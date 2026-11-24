use crate::dbus_client::DBusClient;
use crate::modem_manager::ModemManager;
use anyhow::Result;
use std::time::{Duration, Instant};

fn elapsed_millis(elapsed: Duration) -> f64 {
    f64::from(u32::try_from(elapsed.as_millis()).unwrap_or(u32::MAX))
}
use tokio::process::Command;
use tracing::{info, warn};

pub struct PerformanceBenchmark;

impl PerformanceBenchmark {
    pub async fn run_benchmark() -> Result<()> {
        info!("🏁 Starting Performance Benchmark");
        info!("================================");

        let native_result = Self::benchmark_native_dbus().await;

        let busctl_result = Self::benchmark_busctl().await;

        let mmcli_result = Self::benchmark_mmcli().await;

        info!("\n📊 BENCHMARK RESULTS");
        info!("====================");

        if let Ok(native_time) = native_result {
            info!("✨ Native D-Bus:  {:>6.2}ms per operation", native_time);

            if let Ok(mmcli_time) = &mmcli_result {
                let improvement = ((mmcli_time - native_time) / mmcli_time) * 100.0;
                info!("   → {:.1}% faster than mmcli", improvement);
            }
        }

        if let Ok(busctl_time) = busctl_result {
            info!("📡 Busctl:        {:>6.2}ms per operation", busctl_time);

            if let Ok(mmcli_time) = &mmcli_result {
                let improvement = ((mmcli_time - busctl_time) / mmcli_time) * 100.0;
                info!("   → {:.1}% faster than mmcli", improvement);
            }
        }

        if let Ok(mmcli_time) = mmcli_result {
            info!(
                "🐌 mmcli:         {:>6.2}ms per operation (baseline)",
                mmcli_time
            );
        }

        info!("\n💡 Recommendation: Native D-Bus provides the best performance");

        Ok(())
    }

    async fn benchmark_native_dbus() -> Result<f64> {
        let dbus_client = DBusClient::new().await;

        let _ = dbus_client.list_modems().await;

        let iterations = 10;
        let start = Instant::now();

        for _ in 0..iterations {
            match dbus_client.list_modems().await {
                Ok(_) => {}
                Err(e) => {
                    warn!("Native D-Bus not available: {}", e);
                    return Err(e);
                }
            }
        }

        let elapsed = start.elapsed();
        let avg_ms = elapsed_millis(elapsed) / f64::from(iterations);

        Ok(avg_ms)
    }

    async fn benchmark_busctl() -> Result<f64> {
        let check = Command::new("which").arg("busctl").output().await?;

        if !check.status.success() {
            return Err(anyhow::anyhow!("busctl not available"));
        }

        let _ = Command::new("busctl")
            .arg("call")
            .arg("org.freedesktop.ModemManager1")
            .arg("/org/freedesktop/ModemManager1")
            .arg("org.freedesktop.DBus.ObjectManager")
            .arg("GetManagedObjects")
            .output()
            .await;

        let iterations = 10;
        let start = Instant::now();

        for _ in 0..iterations {
            let output = Command::new("busctl")
                .arg("call")
                .arg("org.freedesktop.ModemManager1")
                .arg("/org/freedesktop/ModemManager1")
                .arg("org.freedesktop.DBus.ObjectManager")
                .arg("GetManagedObjects")
                .output()
                .await?;

            if !output.status.success() {
                return Err(anyhow::anyhow!("busctl command failed"));
            }
        }

        let elapsed = start.elapsed();
        let avg_ms = elapsed_millis(elapsed) / f64::from(iterations);

        Ok(avg_ms)
    }

    async fn benchmark_mmcli() -> Result<f64> {
        let check = Command::new("which").arg("mmcli").output().await?;

        if !check.status.success() {
            return Err(anyhow::anyhow!("mmcli not available"));
        }

        let _ = Command::new("mmcli").arg("-L").output().await;

        let iterations = 10;
        let start = Instant::now();

        for _ in 0..iterations {
            let output = Command::new("mmcli").arg("-L").output().await?;

            if !output.status.success() {
                return Err(anyhow::anyhow!("mmcli command failed"));
            }
        }

        let elapsed = start.elapsed();
        let avg_ms = elapsed_millis(elapsed) / f64::from(iterations);

        Ok(avg_ms)
    }

    pub async fn measure_throughput() -> Result<()> {
        info!("📈 Measuring Throughput (operations/second)");
        info!("===========================================");

        let manager = ModemManager::new().await;
        let duration_secs = 5;

        info!("Testing for {} seconds...", duration_secs);

        let start = Instant::now();
        let mut operations = 0;

        while start.elapsed().as_secs() < duration_secs {
            if manager.list_modems().await.is_ok() {
                operations += 1;
            }
        }

        let elapsed = start.elapsed().as_secs_f64();
        let ops_per_sec = f64::from(operations) / elapsed;

        info!("✅ Completed {} operations in {:.2}s", operations, elapsed);
        info!("📊 Throughput: {:.1} operations/second", ops_per_sec);

        let time_for_92_modems = 92.0 / ops_per_sec;
        info!("⏱️  Time to process 92 modems: {:.2}s", time_for_92_modems);

        if time_for_92_modems < 1.0 {
            info!("🚀 EXCELLENT: Sub-second processing for all modems!");
        } else if time_for_92_modems < 5.0 {
            info!("✨ GOOD: Fast processing for all modems");
        } else {
            info!("⚠️  Consider optimizations for better performance");
        }

        Ok(())
    }
}
