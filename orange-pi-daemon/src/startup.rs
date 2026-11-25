use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{error, info, warn};

use crate::identifiers::Iccid;
use crate::message_store::MessageStore;
use crate::modem_manager::ModemManager;
use crate::types::ApiKey;
use crate::worker_pool::{WorkerPool, WorkerPoolConfig};

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
    println!("    SMS_API_URL         API endpoint URL (required)");
    println!("    SMS_API_KEY         API authentication key (required)");
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

/// Without either, every request would fail while the process looked healthy.
pub(crate) fn api_settings(env: impl Fn(&str) -> Option<String>) -> Result<(String, ApiKey)> {
    let required = |name: &str| {
        env(name)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("{name} is not set"))
    };
    Ok((required("SMS_API_URL")?, required("SMS_API_KEY")?.into()))
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
        Arc::clone(modem_manager),
        Arc::clone(message_store),
    ));
    info!(
        "👷 Worker pool initialized with {} parallel workers (batch size: {})",
        worker_config.num_workers, worker_config.batch_size
    );
    worker_pool
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        |name| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_string())
        }
    }

    #[test]
    fn api_settings_reads_both_variables() {
        let (url, key) = api_settings(env(&[
            ("SMS_API_URL", "https://sexy.itoken.world"),
            ("SMS_API_KEY", "k".repeat(32).as_str()),
        ]))
        .unwrap();

        assert_eq!(url, "https://sexy.itoken.world");
        assert_eq!(key.expose(), "k".repeat(32));
    }

    #[test]
    fn api_settings_refuses_a_missing_or_empty_key() {
        for vars in [
            &[("SMS_API_URL", "https://sexy.itoken.world")][..],
            &[
                ("SMS_API_URL", "https://sexy.itoken.world"),
                ("SMS_API_KEY", ""),
            ][..],
        ] {
            let error = api_settings(env(vars)).unwrap_err();
            assert_eq!(error.to_string(), "SMS_API_KEY is not set");
        }
    }

    #[test]
    fn api_settings_refuses_a_missing_url() {
        let error = api_settings(env(&[("SMS_API_KEY", "key")])).unwrap_err();
        assert_eq!(error.to_string(), "SMS_API_URL is not set");
    }

    #[test]
    fn api_settings_checks_the_url_before_the_key() {
        let error = api_settings(env(&[])).unwrap_err();
        assert_eq!(error.to_string(), "SMS_API_URL is not set");
    }

    #[test]
    fn api_settings_refuses_an_empty_url() {
        let error = api_settings(env(&[("SMS_API_URL", ""), ("SMS_API_KEY", "key")])).unwrap_err();
        assert_eq!(error.to_string(), "SMS_API_URL is not set");
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn resolve_db_path_takes_the_value_after_the_flag() {
        assert_eq!(
            resolve_db_path(&args(&["daemon", "--db-path", "/data/messages.db"])),
            "/data/messages.db"
        );
    }

    #[test]
    fn resolve_db_path_finds_the_flag_among_other_arguments() {
        assert_eq!(
            resolve_db_path(&args(&[
                "daemon",
                "cleanup",
                "--db-path",
                "/x.db",
                "--help"
            ])),
            "/x.db"
        );
    }

    #[test]
    fn resolve_db_path_uses_the_first_flag_when_it_is_repeated() {
        assert_eq!(
            resolve_db_path(&args(&[
                "--db-path",
                "/first.db",
                "--db-path",
                "/second.db"
            ])),
            "/first.db"
        );
    }

    #[test]
    fn open_message_store_opens_an_empty_queue() {
        let store = open_message_store(":memory:").unwrap();

        assert!(store.claim_messages(10, 90).unwrap().is_empty());
    }

    #[test]
    fn open_message_store_refuses_a_path_in_a_missing_directory() {
        assert!(open_message_store("/nonexistent-sms-daemon-dir/messages.db").is_err());
    }
}
