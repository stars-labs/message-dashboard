mod periodic_tasks;
mod reader;
mod startup;
mod uploader;

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{error, info};

use orange_pi_daemon_rust::api_client::ApiClient;
use orange_pi_daemon_rust::health::HealthTracker;
use orange_pi_daemon_rust::logging;
use orange_pi_daemon_rust::modem_manager::ModemManager;
use orange_pi_daemon_rust::stall_watchdog::{self, Heartbeat, STALL_AFTER};
use orange_pi_daemon_rust::types::Config;
use orange_pi_daemon_rust::wire::ModemReport;

use periodic_tasks::{
    spawn_device_sync, spawn_health_heartbeat, spawn_rediscovery, spawn_retention_cleanup,
    spawn_segment_cleanup, spawn_sms_sender, spawn_statistics_logger, spawn_voice_bridge,
};
use reader::{spawn_modem_reader, ModemReader};
use startup::{
    api_settings, build_modem_cache, check_modem_manager, init_worker_pool, open_message_store,
    print_help, resolve_db_path,
};
use uploader::spawn_uploader;

type SharedHealth = Arc<RwLock<HealthTracker>>;
type SharedDevices = Arc<RwLock<HashMap<String, ModemReport>>>;

#[tokio::main(flavor = "multi_thread", worker_threads = 4)] // Optimized for 4-core ARM CPU
async fn main() -> Result<()> {
    logging::init()?;

    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_help(args.first().map_or("orange-pi-daemon", String::as_str));
        return Ok(());
    }

    let db_path = resolve_db_path(&args);

    let (api_url, api_key) = api_settings(|name| std::env::var(name).ok())?;

    let session_id = format!("rust-daemon-{}", uuid::Uuid::new_v4());
    info!(
        "🚀 SMS Daemon v{} starting (Direct AT Commands)",
        env!("CARGO_PKG_VERSION")
    );
    info!("📡 Session ID: {}", session_id);
    info!("🌍 API URL: {}", api_url);
    info!("💾 Database: {}", db_path);

    let message_store = open_message_store(&db_path)?;

    let modem_manager = Arc::new(ModemManager::new());
    let config = Config {
        api_url: api_url.clone(),
        api_key: api_key.clone(),
        check_interval_secs: 1, // Fast 1-second check interval for dual-loop
    };
    let api_client = Arc::new(ApiClient::new(config)?);

    check_modem_manager(&modem_manager).await?;

    let worker_pool = init_worker_pool(&modem_manager, &message_store);

    let valid_modems = build_modem_cache(&modem_manager).await?;

    if valid_modems.is_empty() {
        error!("❌ No modems with valid IMEI found!");
        error!("💡 Check: mmcli -L");
        return Ok(());
    }

    let modem_ids: Vec<String> = valid_modems.keys().cloned().collect();

    let modem_set: Arc<RwLock<Vec<String>>> = Arc::new(RwLock::new(modem_ids));

    let _ = sd_notify::notify(true, &[sd_notify::NotifyState::Ready]);
    info!("🔔 Notified systemd - daemon is ready");

    info!(
        "🚀 Starting DUAL LOOP architecture with {} modems",
        valid_modems.len()
    );

    let latest_devices: SharedDevices = Arc::new(RwLock::new(HashMap::new()));
    let health_tracker: SharedHealth = Arc::new(RwLock::new(HealthTracker::new(
        session_id.clone(),
        env!("CARGO_PKG_VERSION").to_string(),
    )));

    // Beaten by the reader on every completed cycle, read by the watchdog thread.
    let reader_heartbeat = Heartbeat::default();
    spawn_modem_reader(ModemReader {
        store: Arc::clone(&message_store),
        manager: Arc::clone(&modem_manager),
        pool: Arc::clone(&worker_pool),
        modem_set: Arc::clone(&modem_set),
        devices: Arc::clone(&latest_devices),
        health: Arc::clone(&health_tracker),
        heartbeat: reader_heartbeat.clone(),
    });
    spawn_uploader(
        Arc::clone(&message_store),
        Arc::clone(&api_client),
        Arc::clone(&health_tracker),
    );
    spawn_device_sync(
        Arc::clone(&api_client),
        Arc::clone(&latest_devices),
        Arc::clone(&modem_set),
        session_id.clone(),
    );
    spawn_statistics_logger(Arc::clone(&message_store));
    spawn_retention_cleanup(Arc::clone(&message_store));
    spawn_segment_cleanup(Arc::clone(&message_store));
    spawn_sms_sender(
        (*api_client).clone(),
        Arc::clone(&modem_manager),
        valid_modems
            .iter()
            .filter_map(|(modem_id, iccid)| iccid.as_ref().map(|i| (i.clone(), modem_id.clone())))
            .collect(),
        session_id,
    );
    spawn_health_heartbeat(Arc::clone(&api_client), health_tracker, message_store);
    spawn_rediscovery(Arc::clone(&modem_manager), modem_set);
    spawn_voice_bridge(
        api_key,
        modem_manager,
        (*api_client).clone(),
        latest_devices,
    );

    // An OS thread, not a tokio task: a hung runtime keeps the process alive so
    // Restart=always never fires, and a task on that runtime would be starved too.
    stall_watchdog::spawn(reader_heartbeat).context("failed to start the stall watchdog thread")?;
    info!(
        "🐕 Stall watchdog thread started - restarting if no read cycle completes for {}s",
        STALL_AFTER.as_secs()
    );

    info!("✨ All tasks spawned - system running in dual-loop mode");
    loop {
        tokio::time::sleep(Duration::from_secs(300)).await;
        info!("💓 Heartbeat - daemon is healthy");
    }
}
