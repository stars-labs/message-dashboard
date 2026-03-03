//! Modem health diagnostic tool
//!
//! Usage: cargo run --bin modem_health <modem_id>
//! Example: cargo run --bin modem_health 0  # Check /dev/ttyUSB2
//!
//! This tool performs a comprehensive health check on a modem including:
//! - Signal quality
//! - Network registration status
//! - IMS status
//! - SMS configuration
//! - SIM card info

use anyhow::Result;
use orange_pi_daemon_rust::at_modem::AtModemManager;

fn parse_signal_percent(rssi: u32) -> String {
    if rssi == 99 {
        "Unknown".to_string()
    } else if rssi == 0 {
        "<-113dBm (No signal)".to_string()
    } else {
        let percent = (rssi * 100) / 31;
        format!("{}% (RSSI: {} dBm)", percent, rssi - 110)
    }
}

fn parse_reg_status(stat: u32) -> &'static str {
    match stat {
        0 => "Not registered",
        1 => "Registered (home)",
        2 => "Searching",
        3 => "Denied",
        4 => "Unknown",
        5 => "Registered (roaming)",
        _ => "Unknown",
    }
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        println!("Modem Health Diagnostic Tool");
        println!();
        println!("Usage: {} <modem_id|port>", args[0]);
        println!();
        println!("Examples:");
        println!("  {} 0              # Check modem 0 (ttyUSB2)", args[0]);
        println!("  {} 1              # Check modem 1 (ttyUSB6)", args[0]);
        println!("  {} /dev/ttyUSB2   # Check by port path", args[0]);
        return Ok(());
    }

    let target = &args[1];
    let port = if target.starts_with("/dev/") {
        target.clone()
    } else {
        format!("/dev/ttyUSB{}", target.parse::<u32>().unwrap_or(0) * 4 + 2)
    };

    println!("========================================");
    println!("  Modem Health Check: {}", target);
    println!("  Port: {}", port);
    println!("========================================");
    println!();

    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async {
        let manager = AtModemManager::new();
        let health = manager.health_check(&port).await;

        match health {
            Ok(h) => {
                println!("[OK] Successfully connected to modem");
                println!();

                println!("=== Basic Info ===");
                if let Some(iccid) = &h.iccid {
                    println!("  ICCID: {}", iccid);
                } else {
                    println!("  ICCID: [FAILED - No SIM or unreadable]");
                }

                if let Some(imei) = &h.imei {
                    println!("  IMEI: {}", imei);
                } else {
                    println!("  IMEI: [FAILED]");
                }

                println!();
                println!("=== Signal & Network ===");

                if let Some(sig) = h.signal_percent {
                    println!("  Signal: {}", parse_signal_percent(sig));
                } else {
                    println!("  Signal: [FAILED]");
                }

                if let Some(op) = &h.operator {
                    println!("  Operator: {}", op);
                } else {
                    println!("  Operator: [Unknown]");
                }

                if let Some(net) = &h.network_reg {
                    println!("  CREG (CS): stat={} -> {}", net.creg.1, parse_reg_status(net.creg.1));
                    println!("  CGREG (PS): stat={} -> {}", net.cgreg.1, parse_reg_status(net.cgreg.1));

                    if net.creg.1 != 1 && net.creg.1 != 5 {
                        println!("  [WARNING] Not registered to network! SMS will not work.");
                    }
                } else {
                    println!("  Network: [FAILED to query]");
                }

                println!();
                println!("=== IMS Status ===");

                if let Some(ims) = &h.ims_status {
                    println!("  IMS Enabled: {}", if ims.enabled { "Yes" } else { "No" });
                    if !ims.registration.is_empty() {
                        println!("  Registration: {}", ims.registration);
                    }
                    if !ims.enabled {
                        println!("  [WARNING] IMS is disabled - may affect SMS over LTE");
                    }
                } else {
                    println!("  [FAILED to query IMS status]");
                }

                println!();
                println!("=== SMS Configuration ===");

                if let Some(sms) = &h.sms_config {
                    println!("  Mode: {}", sms.mode);
                    println!("  Storage: {}", sms.storage);
                } else {
                    println!("  [FAILED to query SMS config]");
                }

                if let Some(csca) = &h.sms_center {
                    println!("  Service Center: {}", csca);
                    if csca.is_empty() {
                        println!("  [WARNING] SMS service center is empty!");
                    }
                } else {
                    println!("  Service Center: [Unknown/Not set]");
                }

                println!();
                println!("========================================");
                println!("  DIAGNOSIS SUMMARY");
                println!("========================================");

                let mut issues: Vec<String> = Vec::new();
                let mut ok = true;

                if h.iccid.is_none() {
                    issues.push("SIM card not detected (ICCID missing)".to_string());
                    ok = false;
                }

                if h.imei.is_none() {
                    issues.push("IMEI not readable".to_string());
                }

                if let Some(sig) = h.signal_percent {
                    if sig < 10 {
                        issues.push("Very weak or no signal".to_string());
                    }
                } else {
                    issues.push("Signal query failed".to_string());
                }

                if let Some(net) = h.network_reg {
                    if net.creg.1 != 1 && net.creg.1 != 5 {
                        issues.push(format!("Not registered to network (CREG={})", net.creg.1));
                        ok = false;
                    }
                } else {
                    issues.push("Cannot query network registration".to_string());
                    ok = false;
                }

                if let Some(ims) = h.ims_status {
                    if !ims.enabled {
                        issues.push("IMS is disabled".to_string());
                    }
                }

                if let Some(csca) = h.sms_center {
                    if csca.is_empty() {
                        issues.push("SMS Service Center not configured".to_string());
                    }
                }

                if ok {
                    println!("  [PASS] All checks passed - modem should be able to receive SMS");
                } else {
                    println!("  [FAIL] Issues detected:");
                    for (i, issue) in issues.iter().enumerate() {
                        println!("    {}. {}", i + 1, issue);
                    }
                }

                println!();
            }
            Err(e) => {
                println!("[FAILED] Cannot connect to modem: {}", e);
                println!();
                println!("Troubleshooting steps:");
                println!("  1. Check if port exists: ls -la {}", port);
                println!("  2. Check permissions: ls -la /dev/ttyUSB*");
                println!("  3. Check if ModemManager is blocking: sudo systemctl status ModemManager");
                println!("  4. Try: sudo chmod 666 {}", port);
            }
        }
    });

    Ok(())
}
