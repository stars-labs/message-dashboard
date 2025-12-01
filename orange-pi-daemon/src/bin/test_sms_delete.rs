// Test program to verify SMS deletion on SIM cards
use anyhow::Result;
use tracing::{error, info, warn};
use std::sync::Arc;
use orange_pi_daemon_rust::modem_manager::ModemManager;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter("debug")
        .init();

    info!("🔬 SMS Deletion Test Program");
    info!("=============================");

    // Initialize ModemManager with native D-Bus
    let modem_manager = Arc::new(ModemManager::new().await);

    // Check if native D-Bus is available
    if modem_manager.is_using_native_dbus().await {
        info!("✅ Using native D-Bus for direct communication");
    } else {
        warn!("⚠️  Fallback to busctl subprocess");
    }

    // List all modems
    info!("📱 Listing modems...");
    let modems = modem_manager.list_modems().await?;
    info!("Found {} modems", modems.len());

    if modems.is_empty() {
        error!("❌ No modems found!");
        return Ok(());
    }

    // Take first modem with a SIM card
    let mut target_modem = None;
    for modem_id in &modems[..5.min(modems.len())] {  // Check first 5 modems
        if let Ok(Some(iccid)) = modem_manager.get_iccid(modem_id).await {
            info!("📱 Modem {} has SIM with ICCID: {}", modem_id, iccid);
            target_modem = Some((modem_id.clone(), iccid));
            break;
        }
    }

    let (modem_id, iccid) = match target_modem {
        Some(t) => t,
        None => {
            error!("❌ No modem with SIM card found!");
            return Ok(());
        }
    };

    info!("\n🎯 Testing deletion on modem: {}", modem_id);
    info!("   ICCID: {}", iccid);

    // Get messages from this modem
    info!("\n📥 Getting messages from modem...");
    let messages = modem_manager.get_new_messages_with_paths(&modem_id, &iccid).await?;
    info!("Found {} messages on SIM card", messages.len());

    if messages.is_empty() {
        warn!("⚠️  No messages to delete on this SIM card");
        return Ok(());
    }

    // Show first few messages
    for (i, msg) in messages.iter().take(3).enumerate() {
        info!("\n📧 Message {}:", i + 1);
        info!("   Path: {}", msg.sms_path);
        info!("   From: {}", msg.message.phone_number);
        info!("   Time: {}", msg.message.timestamp);
        info!("   Text: {}", &msg.message.content[..50.min(msg.message.content.len())]);
    }

    // Try to delete first message
    let first_msg = &messages[0];
    info!("\n🗑️  Attempting to delete message...");
    info!("   Modem ID: {}", modem_id);
    info!("   SMS Path: {}", first_msg.sms_path);

    // Try deletion using different methods
    info!("\n=== METHOD 1: Direct ModemManager delete ===");
    match modem_manager.delete_sms(&modem_id, &first_msg.sms_path).await {
        Ok(_) => {
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

    // Try using mmcli directly as a comparison
    info!("\n=== METHOD 2: Direct mmcli command ===");
    let cmd = format!("mmcli -m {} --messaging-delete-sms={}", modem_id, first_msg.sms_path);
    info!("Running: {}", cmd);

    let output = tokio::process::Command::new("ssh")
        .arg("root@203.116.95.146")
        .arg(&cmd)
        .output()
        .await?;

    if output.status.success() {
        info!("✅ SUCCESS with mmcli!");
    } else {
        error!("❌ FAILED with mmcli!");
        error!("   stdout: {}", String::from_utf8_lossy(&output.stdout));
        error!("   stderr: {}", String::from_utf8_lossy(&output.stderr));
    }

    // Try using busctl directly
    info!("\n=== METHOD 3: Direct busctl command ===");
    let busctl_cmd = format!(
        "busctl call org.freedesktop.ModemManager1 /org/freedesktop/ModemManager1/Modem/{} org.freedesktop.ModemManager1.Modem.Messaging Delete o {}",
        modem_id, first_msg.sms_path
    );
    info!("Running: {}", busctl_cmd);

    let busctl_output = tokio::process::Command::new("ssh")
        .arg("root@203.116.95.146")
        .arg(&busctl_cmd)
        .output()
        .await?;

    if busctl_output.status.success() {
        info!("✅ SUCCESS with busctl!");
    } else {
        error!("❌ FAILED with busctl!");
        error!("   stdout: {}", String::from_utf8_lossy(&busctl_output.stdout));
        error!("   stderr: {}", String::from_utf8_lossy(&busctl_output.stderr));
    }

    // Check if message still exists
    info!("\n🔍 Checking if message still exists...");
    let remaining = modem_manager.get_new_messages_with_paths(&modem_id, &iccid).await?;
    let still_exists = remaining.iter().any(|m| m.sms_path == first_msg.sms_path);

    if still_exists {
        error!("❌ Message still exists on SIM card!");
    } else {
        info!("✅ Message successfully removed from SIM card!");
    }

    info!("\n📊 Test complete!");
    Ok(())
}