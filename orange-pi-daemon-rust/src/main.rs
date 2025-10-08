mod types;
mod modem_manager;
mod api_client;
// mod dbus_manager;  // Disabled for now

use anyhow::Result;
use std::collections::HashMap;
use std::time::Duration;
use tokio::time;
use tracing::{info, warn, error};
use crate::types::*;
use crate::modem_manager::ModemManager;
use crate::api_client::ApiClient;

#[tokio::main(flavor = "multi_thread", worker_threads = 4)] // Multi-threaded for concurrent modem processing
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "orange_pi_daemon_rust=info".to_string())
        )
        .init();
    
    // Load configuration
    let config = Config {
        api_url: std::env::var("SMS_API_URL")
            .unwrap_or_else(|_| "https://sexy.qzz.io".to_string()),
        api_key: std::env::var("SMS_API_KEY")
            .expect("SMS_API_KEY environment variable must be set"),
        check_interval_secs: std::env::var("CHECK_INTERVAL_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5),
    };
    
    info!("🚀 Starting Rust SMS Daemon v1.0.0");
    info!("📡 API URL: {}", config.api_url);
    info!("⏱️  Check interval: {}s", config.check_interval_secs);
    
    // Initialize components
    let modem_manager = ModemManager::new();
    let api_client = ApiClient::new(config.clone());
    
    // Cache of valid modems (those with SIM cards)
    let mut valid_modems: HashMap<String, String> = HashMap::new(); // modem_id -> iccid
    
    // Build initial modem cache
    info!("🔄 Building initial modem cache...");
    match modem_manager.list_modems().await {
        Ok(modems) => {
            info!("📋 Found {} modems, checking for SIM cards...", modems.len());
            for modem_id in modems {
                match modem_manager.get_iccid(&modem_id).await {
                    Ok(Some(iccid)) => {
                        valid_modems.insert(modem_id.clone(), iccid.clone());
                        info!("✅ Cached modem {} with ICCID {}", modem_id, iccid);
                    }
                    Ok(None) => {
                        warn!("⚠️  Modem {} has no SIM card", modem_id);
                    }
                    Err(e) => {
                        warn!("⚠️  Failed to get ICCID for modem {}: {}", modem_id, e);
                    }
                }
            }
        }
        Err(e) => {
            error!("❌ Failed to list modems: {}", e);
            error!("💡 Make sure ModemManager is running: systemctl status ModemManager");
        }
    }
    
    if valid_modems.is_empty() {
        error!("❌ No modems with SIM cards found!");
        error!("💡 Check: mmcli -L");
        return Ok(());
    }
    
    // Notify systemd that we're ready
    let _ = sd_notify::notify(true, &[sd_notify::NotifyState::Ready]);
    info!("🔔 Notified systemd - daemon is ready");
    
    info!("🚀 Starting main loop with {} modems", valid_modems.len());
    
    let mut cycle = 0u64;
    let mut last_sync = std::time::Instant::now();
    let sync_interval = Duration::from_secs(10);
    
    // Main event loop
    loop {
        cycle += 1;
        let cycle_start = std::time::Instant::now();
        
        // Process modems concurrently in batches
        let batch_size = 20; // Process 20 modems at a time
        // Clone the HashMap entries to avoid borrow issues
        let modem_vec: Vec<(String, String)> = valid_modems.iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        
        let mut all_messages = Vec::new();
        
        for batch in modem_vec.chunks(batch_size) {
            // Process this batch concurrently using tokio::spawn
            let mut join_handles = Vec::new();
            for (modem_id, iccid) in batch {
                let modem_id = modem_id.clone();
                let iccid = iccid.clone();
                let mm = modem_manager.clone();
                
                let handle = tokio::spawn(async move {
                    mm.get_new_messages(&modem_id, &iccid).await
                });
                join_handles.push(handle);
            }
            
            // Collect results
            for handle in join_handles {
                match handle.await {
                    Ok(Ok(messages)) => {
                        if !messages.is_empty() {
                            all_messages.extend(messages);
                        }
                    }
                    Ok(Err(e)) => {
                        warn!("⚠️  Failed to check modem: {}", e);
                    }
                    Err(e) => {
                        error!("❌ Task panicked: {}", e);
                    }
                }
            }
        }
        
        // Upload messages if any found
        if !all_messages.is_empty() {
            info!("📤 Uploading {} messages to API", all_messages.len());
            if let Err(e) = api_client.upload_messages(&all_messages).await {
                error!("❌ Failed to upload messages: {}", e);
            }
        }
        
        // Periodic device status sync (every 10 seconds)
        if last_sync.elapsed() > sync_interval {
            info!("🔄 Syncing device status to API");
            
            let mut phones = Vec::new();
            for (modem_id, iccid) in &valid_modems {
                // Gather device data
                let (imei, manufacturer, model, firmware, hardware) = 
                    modem_manager.get_device_details(modem_id)
                        .await
                        .unwrap_or_else(|_| (
                            format!("MODEM_{}", modem_id),
                            None,
                            None,
                            None,
                            None
                        ));
                
                let phone_number = modem_manager.get_phone_number(modem_id)
                    .await
                    .ok()
                    .flatten();
                
                let signal = modem_manager.get_signal_quality(modem_id)
                    .await
                    .unwrap_or_default();
                
                let operator = modem_manager.get_operator(modem_id)
                    .await
                    .ok()
                    .flatten();
                
                phones.push(Phone {
                    iccid: iccid.clone(),
                    number: phone_number,
                    signal: Some(signal.percent),
                    operator_name: operator,
                    status: "active".to_string(),
                    manufacturer,
                    model,
                    firmware_revision: firmware,
                    hardware_revision: hardware,
                    imei: Some(imei),
                    // Optional fields
                    country: None,
                    flag: None,
                    carrier: None,
                    rssi: Some(signal.rssi),
                    rsrq: None,
                    rsrp: None,
                    snr: None,
                    operator_id: None,
                    access_tech: None,
                    modem_index: Some(modem_id.parse().unwrap_or(0)),
                    sim_index: None,
                    device_path: None,
                    usb_port: None,
                });
            }
            
            if let Err(e) = api_client.upload_phones(&phones).await {
                error!("❌ Failed to upload phone data: {}", e);
            }
            
            last_sync = std::time::Instant::now();
        }
        
        // Refresh modem cache every 5 minutes (60 cycles at 5s interval)
        if cycle % 60 == 0 {
            info!("🔄 Refreshing modem cache (every 5 minutes)");
            valid_modems.clear();
            
            if let Ok(modems) = modem_manager.list_modems().await {
                for modem_id in modems {
                    if let Ok(Some(iccid)) = modem_manager.get_iccid(&modem_id).await {
                        valid_modems.insert(modem_id, iccid);
                    }
                }
            }
            
            info!("🔄 Cache refreshed: {} modems", valid_modems.len());
        }
        
        // Log progress every 10 cycles
        if cycle % 10 == 0 {
            let elapsed = cycle_start.elapsed();
            info!("🔍 Cycle {}: checked {} modems in {:?}", 
                  cycle, valid_modems.len(), elapsed);
        }
        
        // Sleep until next cycle
        time::sleep(Duration::from_secs(config.check_interval_secs)).await;
    }
}
