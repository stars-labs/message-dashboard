use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{error, info, warn};

use orange_pi_daemon_rust::identifiers::Iccid;
use orange_pi_daemon_rust::message_store::MessageStore;
use orange_pi_daemon_rust::modem_manager::ModemManager;
use orange_pi_daemon_rust::types::ApiKey;
use orange_pi_daemon_rust::worker_pool::{WorkerPool, WorkerPoolConfig};

#[expect(clippy::print_stdout, reason = "--help writes its text to stdout")]
pub(crate) fn print_help(program: &str) {
    println!(
        "SMS Daemon v{} - Direct AT Commands for 100+ modems",
        env!("CARGO_PKG_VERSION")
    );
    println!();
    println!("USAGE:");
    println!("    {program} [OPTIONS] [COMMAND]");
    println!();
    println!("COMMANDS:");
    println!("    benchmark    Run performance benchmark");
    println!("    cleanup      Run database cleanup and exit");
    println!();
    println!("OPTIONS:");
    println!(
        "    --db-path <PATH>    SQLite database path (default: /var/lib/sms-daemon/messages.db)"
    );
    println!("    -h, --help          Print this help message");
    println!();
    println!("ENVIRONMENT VARIABLES:");
    println!("    MESSAGE_DB_PATH     SQLite database path (overridden by --db-path)");
    println!("    SMS_API_URL         API endpoint URL");
    println!("    SMS_API_KEY         API authentication key");
    println!("    USE_DBUS            Set to '1' to use ModemManager D-Bus (default: AT commands)");
    println!("    RUST_LOG            Log level (e.g., orange_pi_daemon_rust=debug)");
}

/// Probe every listed modem; a modem needs a valid IMEI to be cached, and its
/// ICCID is optional.
pub(crate) async fn build_modem_cache(
    modem_manager: &ModemManager,
) -> Result<HashMap<String, Option<Iccid>>> {
    info!("🔄 Building initial modem cache...");
    let mut valid_modems: HashMap<String, Option<Iccid>> = HashMap::new();
    match modem_manager.list_modems().await {
        Ok(modems) => {
            info!(
                "📋 Found {} modems, checking for SIM cards...",
                modems.len()
            );
            for modem_id in modems {
                let imei = match modem_manager.get_device_details(&modem_id).await {
                    Ok(Some((imei, ..))) => Some(imei),
                    Ok(None) => None,
                    Err(e) => {
                        warn!("⚠️  Failed to get IMEI for modem {}: {}", modem_id, e);
                        None
                    }
                };

                let Some(imei) = imei else {
                    warn!("⚠️  Modem {} has no valid IMEI, skipping", modem_id);
                    continue;
                };

                let iccid = match modem_manager.get_iccid(&modem_id).await {
                    Ok(Some(iccid)) => Some(iccid),
                    Ok(None) => None,
                    Err(e) => {
                        warn!("⚠️  Failed to get ICCID for modem {}: {}", modem_id, e);
                        None
                    }
                };

                valid_modems.insert(modem_id.clone(), iccid.clone());

                if let Some(iccid) = &iccid {
                    info!(
                        "✅ Cached modem {} with ICCID {} (IMEI {})",
                        modem_id, iccid, imei
                    );
                } else {
                    warn!(
                        "⚠️  Cached modem {} without ICCID (IMEI {}) — SIM read failed",
                        modem_id, imei
                    );
                }
            }
        }
        Err(e) => {
            error!("❌ Failed to list modems: {}", e);
            return Err(anyhow::anyhow!("Failed to list modems"));
        }
    }
    Ok(valid_modems)
}

pub(crate) fn load_api_settings() -> (String, ApiKey) {
    let api_url =
        std::env::var("SMS_API_URL").unwrap_or_else(|_| "http://localhost:8787".to_string());
    let api_key = std::env::var("SMS_API_KEY").unwrap_or_else(|_| {
        warn!("SMS_API_KEY not set, using default");
        "default_api_key".to_string()
    });
    (api_url, api_key.into())
}

pub(crate) async fn check_modem_manager(modem_manager: &ModemManager) -> Result<()> {
    if let Err(e) = modem_manager.list_modems().await {
        error!("❌ ModemManager not accessible: {}", e);
        error!("💡 Make sure ModemManager is running: systemctl status ModemManager");
        return Err(anyhow::anyhow!("ModemManager not accessible"));
    }
    Ok(())
}

pub(crate) fn resolve_db_path(args: &[String]) -> String {
    args.windows(2)
        .find_map(|w| match w {
            [flag, value] if flag == "--db-path" => Some(value.clone()),
            _ => None,
        })
        .or_else(|| std::env::var("MESSAGE_DB_PATH").ok())
        .unwrap_or_else(|| "/var/lib/sms-daemon/messages.db".to_string())
}

pub(crate) fn open_message_store(db_path: &str) -> Result<Arc<MessageStore>> {
    let message_store = Arc::new(MessageStore::new(db_path)?);

    let marked_deleted = message_store.mark_old_uploaded_as_deleted()?;
    if marked_deleted > 0 {
        info!(
            "✅ Marked {} old uploaded messages as deleted (stale paths)",
            marked_deleted
        );
    }
    Ok(message_store)
}

pub(crate) fn init_worker_pool(
    modem_manager: &Arc<ModemManager>,
    message_store: &Arc<MessageStore>,
) -> Arc<WorkerPool> {
    let worker_config = WorkerPoolConfig::default();
    let worker_pool = Arc::new(WorkerPool::new(
        worker_config.clone(),
        modem_manager.clone(),
        message_store.clone(),
    ));
    info!(
        "👷 Worker pool initialized with {} parallel workers (batch size: {})",
        worker_config.num_workers, worker_config.batch_size
    );
    worker_pool
}
