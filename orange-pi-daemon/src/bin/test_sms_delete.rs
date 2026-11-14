// Test program to verify SMS deletion on SIM cards
use anyhow::Result;
use orange_pi_daemon_rust::message_store::MessageStore;
use orange_pi_daemon_rust::modem_manager::ModemManager;
use orange_pi_daemon_rust::types::MessageWithPath;
use std::sync::Arc;
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt().with_env_filter("debug").init();

    info!("🔬 SMS Deletion Test Program");
    info!("=============================");

    // Initialize MessageStore
    let message_store = Arc::new(MessageStore::new("/tmp/test_messages.db")?);

    // Initialize ModemManager with native D-Bus
    let modem_manager = Arc::new(ModemManager::new().await);

    // Check if native D-Bus is available
    if modem_manager.is_using_native_dbus() {
        info!("✅ Using native D-Bus for direct communication");
    } else {
        warn!("⚠️  Fallback to busctl subprocess");
    }

    let Some((modem_id, iccid)) = find_modem_with_sim(&modem_manager).await? else {
        return Ok(());
    };

    info!("\n🎯 Testing deletion on modem: {}", modem_id);
    info!("   ICCID: {}", iccid);

    // Get messages from this modem
    info!("\n📥 Getting messages from modem...");
    let messages = modem_manager
        .get_new_messages_with_paths(&modem_id, &iccid, &message_store)
        .await?;
    info!("Found {} messages on SIM card", messages.len());

    if messages.is_empty() {
        warn!("⚠️  No messages to delete on this SIM card");
        return Ok(());
    }

    log_first_messages(&messages);

    // Try to delete first message
    let Some(first_msg) = messages.first() else {
        return Ok(());
    };
    info!("\n🗑️  Attempting to delete message...");
    info!("   Modem ID: {}", modem_id);
    info!("   SMS Path: {}", first_msg.sms_path);

    // Try deletion using different methods
    info!("\n=== METHOD 1: Direct ModemManager delete ===");
    delete_with_modem_manager(&modem_manager, &modem_id, &first_msg.sms_path).await;

    // Try using mmcli directly as a comparison
    info!("\n=== METHOD 2: Direct mmcli command ===");
    let cmd = format!(
        "mmcli -m {} --messaging-delete-sms={}",
        modem_id, first_msg.sms_path
    );
    run_over_ssh("mmcli", &cmd).await?;

    // Try using busctl directly
    info!("\n=== METHOD 3: Direct busctl command ===");
    let busctl_cmd = format!(
        "busctl call org.freedesktop.ModemManager1 /org/freedesktop/ModemManager1/Modem/{} org.freedesktop.ModemManager1.Modem.Messaging Delete o {}",
        modem_id, first_msg.sms_path
    );
    run_over_ssh("busctl", &busctl_cmd).await?;

    // Check if message still exists
    info!("\n🔍 Checking if message still exists...");
    let remaining = modem_manager
        .get_new_messages_with_paths(&modem_id, &iccid, &message_store)
        .await?;
    let still_exists = remaining.iter().any(|m| m.sms_path == first_msg.sms_path);

    if still_exists {
        error!("❌ Message still exists on SIM card!");
    } else {
        info!("✅ Message successfully removed from SIM card!");
    }

    info!("\n📊 Test complete!");
    Ok(())
}

async fn find_modem_with_sim(modem_manager: &ModemManager) -> Result<Option<(String, String)>> {
    info!("📱 Listing modems...");
    let modems = modem_manager.list_modems().await?;
    info!("Found {} modems", modems.len());

    if modems.is_empty() {
        error!("❌ No modems found!");
        return Ok(None);
    }

    // Take first modem with a SIM card
    for modem_id in modems.iter().take(5) {
        // Check first 5 modems
        if let Ok(Some(iccid)) = modem_manager.get_iccid(modem_id).await {
            info!("📱 Modem {} has SIM with ICCID: {}", modem_id, iccid);
            return Ok(Some((modem_id.clone(), iccid)));
        }
    }

    error!("❌ No modem with SIM card found!");
    Ok(None)
}

fn log_first_messages(messages: &[MessageWithPath]) {
    for (i, msg) in messages.iter().take(3).enumerate() {
        info!("\n📧 Message {}:", i + 1);
        info!("   Path: {}", msg.sms_path);
        info!("   From: {}", msg.message.phone_number);
        info!("   Time: {}", msg.message.timestamp);
        info!(
            "   Text: {}",
            msg.message.content.chars().take(50).collect::<String>()
        );
    }
}

async fn delete_with_modem_manager(modem_manager: &ModemManager, modem_id: &str, sms_path: &str) {
    match modem_manager.delete_sms(modem_id, sms_path).await {
        Ok(()) => {
            info!("✅ SUCCESS! Message deleted using ModemManager");
        }
        Err(e) => {
            error!("❌ FAILED: {}", e);
            error!("   Full error chain:");
            for cause in e.chain() {
                error!("   Caused by: {}", cause);
            }
        }
    }
}

async fn run_over_ssh(label: &str, cmd: &str) -> Result<()> {
    info!("Running: {}", cmd);

    let output = tokio::process::Command::new("ssh")
        .arg("root@203.116.95.146")
        .arg(cmd)
        .output()
        .await?;

    if output.status.success() {
        info!("✅ SUCCESS with {label}!");
    } else {
        error!("❌ FAILED with {label}!");
        error!("   stdout: {}", String::from_utf8_lossy(&output.stdout));
        error!("   stderr: {}", String::from_utf8_lossy(&output.stderr));
    }
    Ok(())
}
