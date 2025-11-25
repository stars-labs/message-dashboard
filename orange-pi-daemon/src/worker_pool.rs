use anyhow::{Context, Result};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, RwLock, Semaphore};
use tokio::task::JoinSet;
use tracing::{debug, error, info, warn};

use crate::modem_manager::ModemManager;
use crate::types::*;

/// Configuration for the worker pool
#[derive(Debug, Clone)]
pub struct WorkerPoolConfig {
    /// Number of concurrent workers
    pub num_workers: usize,
    /// Maximum modems per batch
    pub batch_size: usize,
    /// Timeout for processing a single modem
    pub modem_timeout: Duration,
}

impl Default for WorkerPoolConfig {
    fn default() -> Self {
        Self {
            num_workers: 2,           // Further reduced to 2 workers for 92+ modems (50% success rate with 4)
            batch_size: 5,            // Smaller batch size to reduce concurrent load
            modem_timeout: Duration::from_secs(45), // 45 second timeout to allow slower modems to respond
        }
    }
}

/// Statistics for worker pool operations
#[derive(Debug, Clone, Default)]
pub struct WorkerPoolStats {
    pub total_modems: usize,
    pub successful: usize,
    pub failed: usize,
    pub timeouts: usize,
    pub processing_time: Duration,
    pub avg_time_per_modem: Duration,
}

impl WorkerPoolStats {
    pub fn success_rate(&self) -> f64 {
        if self.total_modems == 0 {
            return 0.0;
        }
        (self.successful as f64 / self.total_modems as f64) * 100.0
    }
}

/// Result from processing a single modem
#[derive(Debug)]
pub struct ModemResult {
    pub modem_id: String,
    pub iccid: Option<String>,
    pub phone: Option<Phone>,
    pub sim: Option<Sim>,
    pub messages: Vec<Message>,
    pub error: Option<String>,
}

/// Worker pool for parallel modem processing
pub struct WorkerPool {
    config: WorkerPoolConfig,
    modem_manager: Arc<ModemManager>,
    semaphore: Arc<Semaphore>,
    stats: Arc<RwLock<WorkerPoolStats>>,
}

impl WorkerPool {
    /// Create a new worker pool
    pub fn new(config: WorkerPoolConfig, modem_manager: Arc<ModemManager>) -> Self {
        let semaphore = Arc::new(Semaphore::new(config.num_workers));

        info!(
            "🚀 Worker pool initialized with {} workers, batch size {}",
            config.num_workers, config.batch_size
        );

        Self {
            config,
            modem_manager,
            semaphore,
            stats: Arc::new(RwLock::new(WorkerPoolStats::default())),
        }
    }

    /// Process a list of modem IDs in parallel
    pub async fn process_modems(&self, modem_ids: Vec<String>) -> Result<Vec<ModemResult>> {
        let start_time = Instant::now();
        let total_modems = modem_ids.len();

        info!("👷 Processing {} modems with {} workers", total_modems, self.config.num_workers);

        // Reset stats
        {
            let mut stats = self.stats.write().await;
            *stats = WorkerPoolStats {
                total_modems,
                ..Default::default()
            };
        }

        // Create result channel
        let (tx, mut rx) = mpsc::channel::<ModemResult>(total_modems);

        // Process modems in batches
        let mut join_set = JoinSet::new();

        for batch in modem_ids.chunks(self.config.batch_size) {
            for modem_id in batch {
                let modem_id = modem_id.clone();
                let tx = tx.clone();
                let semaphore = self.semaphore.clone();
                let modem_manager = self.modem_manager.clone();
                let timeout = self.config.modem_timeout;
                let stats = self.stats.clone();

                // Spawn worker task
                join_set.spawn(async move {
                    // Acquire semaphore permit for rate limiting
                    let _permit = semaphore.acquire().await.unwrap();

                    let result = tokio::time::timeout(
                        timeout,
                        Self::process_single_modem(modem_id.clone(), modem_manager)
                    ).await;

                    let modem_result = match result {
                        Ok(Ok(result)) => {
                            let mut stats = stats.write().await;
                            stats.successful += 1;
                            result
                        }
                        Ok(Err(e)) => {
                            let mut stats = stats.write().await;
                            stats.failed += 1;

                            warn!("⚠️  Failed to process modem {}: {}", modem_id, e);
                            ModemResult {
                                modem_id,
                                iccid: None,
                                phone: None,
                                sim: None,
                                messages: vec![],
                                error: Some(e.to_string()),
                            }
                        }
                        Err(_) => {
                            let mut stats = stats.write().await;
                            stats.timeouts += 1;

                            warn!("⏱️  Timeout processing modem {}", modem_id);
                            ModemResult {
                                modem_id,
                                iccid: None,
                                phone: None,
                                sim: None,
                                messages: vec![],
                                error: Some("Timeout".to_string()),
                            }
                        }
                    };

                    let _ = tx.send(modem_result).await;
                });
            }
        }

        // Drop original sender to close channel when done
        drop(tx);

        // Collect results
        let mut results = Vec::with_capacity(total_modems);
        while let Some(result) = rx.recv().await {
            results.push(result);
        }

        // Wait for all tasks to complete
        while let Some(res) = join_set.join_next().await {
            if let Err(e) = res {
                error!("Worker task panicked: {}", e);
            }
        }

        // Update final stats
        {
            let mut stats = self.stats.write().await;
            stats.processing_time = start_time.elapsed();
            if stats.successful > 0 {
                stats.avg_time_per_modem = stats.processing_time / stats.successful as u32;
            }
        }

        let stats = self.stats.read().await;
        info!(
            "✅ Worker pool completed: {} modems in {:.2}s ({} successful, {} failed, {} timeouts, {:.1}% success rate)",
            stats.total_modems,
            stats.processing_time.as_secs_f64(),
            stats.successful,
            stats.failed,
            stats.timeouts,
            stats.success_rate()
        );

        Ok(results)
    }

    /// Process a single modem (internal helper)
    async fn process_single_modem(
        modem_id: String,
        modem_manager: Arc<ModemManager>,
    ) -> Result<ModemResult> {
        debug!("Processing modem {}", modem_id);

        // Get ICCID
        let iccid = modem_manager
            .get_iccid(&modem_id)
            .await
            .context("Failed to get ICCID")?;

        if iccid.is_none() {
            debug!("Modem {} has no SIM card", modem_id);
            return Ok(ModemResult {
                modem_id,
                iccid: None,
                phone: None,
                sim: None,
                messages: vec![],
                error: Some("No SIM card".to_string()),
            });
        }

        let iccid = iccid.unwrap();

        // Get device details - skip if no valid IMEI
        let device_details = modem_manager
            .get_device_details(&modem_id)
            .await
            .context("Failed to get device details")?;

        // Skip modems without valid IMEI (no SIM or during SIM swap)
        let (equipment_id, manufacturer, model, firmware, hardware) = match device_details {
            Some(details) => details,
            None => {
                debug!("Modem {} has no valid IMEI, skipping", modem_id);
                return Ok(ModemResult {
                    modem_id,
                    iccid: Some(iccid),
                    phone: None,
                    sim: None,
                    messages: vec![],
                    error: Some("No valid IMEI".to_string()),
                });
            }
        };

        // Get signal quality (cached)
        let signal_data = modem_manager
            .get_signal_quality(&modem_id)
            .await
            .unwrap_or_default();

        // Get phone number
        let phone_number = modem_manager
            .get_phone_number(&modem_id)
            .await
            .unwrap_or(None);

        // Get operator
        let operator = modem_manager
            .get_operator(&modem_id)
            .await
            .unwrap_or(None);

        // Get messages
        let messages = modem_manager
            .get_new_messages(&modem_id, &iccid)
            .await
            .unwrap_or_default();

        // Build Phone struct
        let phone = Phone {
            iccid: iccid.clone(),
            number: phone_number.clone(),
            signal: Some(signal_data.percent),
            operator_name: operator.clone(),
            status: "active".to_string(),
            manufacturer: manufacturer.clone(),
            model: model.clone(),
            firmware_revision: firmware.clone(),
            hardware_revision: hardware.clone(),
            imei: Some(equipment_id.clone()),
            country: None,
            flag: None,
            carrier: operator.clone(),
            rssi: Some(signal_data.rssi),
            rsrq: None,
            rsrp: None,
            snr: None,
            operator_id: None,
            access_tech: None,
            modem_index: modem_id.parse::<i32>().ok(),
            sim_index: None,
            device_path: None,
            usb_port: None,
        };

        // Build Sim struct
        let sim = Sim {
            iccid: iccid.clone(),
            phone_number: phone_number.clone(),
            current_modem_id: Some(equipment_id),
            operator_name: operator,
            operator_id: None,
            status: "active".to_string(),
            sim_index: None,
        };

        Ok(ModemResult {
            modem_id,
            iccid: Some(iccid),
            phone: Some(phone),
            sim: Some(sim),
            messages,
            error: None,
        })
    }

    /// Get current statistics
    pub async fn get_stats(&self) -> WorkerPoolStats {
        self.stats.read().await.clone()
    }

    /// Check if using native D-Bus
    pub async fn is_using_native_dbus(&self) -> bool {
        self.modem_manager.is_using_native_dbus().await
    }

    /// Update configuration
    pub fn update_config(&mut self, config: WorkerPoolConfig) {
        let num_workers = config.num_workers;
        let batch_size = config.batch_size;

        self.config = config;
        self.semaphore = Arc::new(Semaphore::new(num_workers));

        info!(
            "🔧 Worker pool config updated: {} workers, batch size {}",
            num_workers, batch_size
        );
    }

    /// Process modems with progress callback
    pub async fn process_with_progress<F>(
        &self,
        modem_ids: Vec<String>,
        mut progress_callback: F,
    ) -> Result<Vec<ModemResult>>
    where
        F: FnMut(usize, usize) + Send,
    {
        let total = modem_ids.len();
        let mut processed = 0;

        // Process in smaller chunks for progress updates
        let chunk_size = std::cmp::min(10, self.config.batch_size);
        let mut all_results = Vec::new();

        for chunk in modem_ids.chunks(chunk_size) {
            let results = self.process_modems(chunk.to_vec()).await?;
            all_results.extend(results);

            processed += chunk.len();
            progress_callback(processed, total);
        }

        Ok(all_results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_worker_pool_config_default() {
        let config = WorkerPoolConfig::default();
        assert_eq!(config.num_workers, 2);  // Further reduced to 2 workers for 92+ modems
        assert_eq!(config.batch_size, 5);  // Smaller batch size
        assert_eq!(config.modem_timeout, Duration::from_secs(45));  // Increased timeout for slower modems
    }

    #[test]
    fn test_worker_pool_stats() {
        let mut stats = WorkerPoolStats::default();
        stats.total_modems = 100;
        stats.successful = 95;
        stats.failed = 3;
        stats.timeouts = 2;

        assert_eq!(stats.success_rate(), 95.0);
    }

    #[test]
    fn test_worker_pool_stats_empty() {
        let stats = WorkerPoolStats::default();
        assert_eq!(stats.success_rate(), 0.0);
    }
}