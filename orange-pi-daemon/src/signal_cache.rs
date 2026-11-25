use crate::types::SignalData;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::trace;

#[derive(Debug, Clone)]
struct CacheEntry {
    signal: SignalData,
    timestamp: Instant,
}

#[derive(Debug)]
pub struct SignalCache {
    cache: Arc<RwLock<HashMap<String, CacheEntry>>>,
    ttl: Duration,
}

impl SignalCache {
    pub fn new(ttl_seconds: u64) -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            ttl: Duration::from_secs(ttl_seconds),
        }
    }

    pub async fn get(&self, modem_id: &str) -> Option<SignalData> {
        let cache = self.cache.read().await;

        if let Some(entry) = cache.get(modem_id) {
            if entry.timestamp.elapsed() < self.ttl {
                trace!(
                    "📊 Signal cache HIT for modem {}: {}% (age: {:?})",
                    modem_id,
                    entry.signal.percent,
                    entry.timestamp.elapsed()
                );

                return Some(entry.signal.clone());
            }
            trace!(
                "📊 Signal cache expired for modem {} (age: {:?})",
                modem_id,
                entry.timestamp.elapsed()
            );
        }

        trace!("📊 Signal cache MISS for modem {}", modem_id);
        None
    }

    pub async fn set(&self, modem_id: String, signal: SignalData) {
        let mut cache = self.cache.write().await;

        trace!(
            "📊 Caching signal for modem {}: {}%",
            modem_id,
            signal.percent
        );

        cache.insert(
            modem_id,
            CacheEntry {
                signal,
                timestamp: Instant::now(),
            },
        );
    }
}
