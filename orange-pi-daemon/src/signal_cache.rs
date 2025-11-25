use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{debug, trace};
use crate::types::SignalData;

/// Cache entry for signal data
#[derive(Debug, Clone)]
struct CacheEntry {
    signal: SignalData,
    timestamp: Instant,
}

/// Signal cache to reduce redundant signal quality checks
/// Reduces mmcli/D-Bus calls by caching signal data for a short period
pub struct SignalCache {
    cache: Arc<RwLock<HashMap<String, CacheEntry>>>,
    ttl: Duration,
    hit_count: Arc<RwLock<u64>>,
    miss_count: Arc<RwLock<u64>>,
}

impl SignalCache {
    /// Create a new signal cache with specified TTL
    pub fn new(ttl_seconds: u64) -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            ttl: Duration::from_secs(ttl_seconds),
            hit_count: Arc::new(RwLock::new(0)),
            miss_count: Arc::new(RwLock::new(0)),
        }
    }

    /// Get cached signal data if still valid
    pub async fn get(&self, modem_id: &str) -> Option<SignalData> {
        let cache = self.cache.read().await;

        if let Some(entry) = cache.get(modem_id) {
            if entry.timestamp.elapsed() < self.ttl {
                let mut hits = self.hit_count.write().await;
                *hits += 1;

                trace!("📊 Signal cache HIT for modem {}: {}% (age: {:?})",
                    modem_id, entry.signal.percent, entry.timestamp.elapsed());

                return Some(entry.signal.clone());
            } else {
                trace!("📊 Signal cache expired for modem {} (age: {:?})",
                    modem_id, entry.timestamp.elapsed());
            }
        }

        let mut misses = self.miss_count.write().await;
        *misses += 1;

        trace!("📊 Signal cache MISS for modem {}", modem_id);
        None
    }

    /// Store signal data in cache
    pub async fn set(&self, modem_id: String, signal: SignalData) {
        let mut cache = self.cache.write().await;

        trace!("📊 Caching signal for modem {}: {}%", modem_id, signal.percent);

        cache.insert(modem_id, CacheEntry {
            signal,
            timestamp: Instant::now(),
        });
    }

    /// Clear expired entries from cache
    pub async fn cleanup(&self) {
        let mut cache = self.cache.write().await;
        let now = Instant::now();

        let before_count = cache.len();
        cache.retain(|modem_id, entry| {
            let keep = now.duration_since(entry.timestamp) < self.ttl;
            if !keep {
                trace!("🧹 Removing expired signal cache for modem {}", modem_id);
            }
            keep
        });

        let removed = before_count - cache.len();
        if removed > 0 {
            debug!("🧹 Signal cache cleanup: removed {} expired entries", removed);
        }
    }

    /// Get cache statistics
    pub async fn get_stats(&self) -> CacheStats {
        let hits = *self.hit_count.read().await;
        let misses = *self.miss_count.read().await;
        let total = hits + misses;
        let hit_rate = if total > 0 {
            (hits as f64 / total as f64) * 100.0
        } else {
            0.0
        };

        let cache_size = self.cache.read().await.len();

        CacheStats {
            hits,
            misses,
            hit_rate,
            cache_size,
        }
    }

    /// Clear all cache entries
    pub async fn clear(&self) {
        let mut cache = self.cache.write().await;
        let count = cache.len();
        cache.clear();

        debug!("🧹 Cleared signal cache: removed {} entries", count);

        // Reset stats
        *self.hit_count.write().await = 0;
        *self.miss_count.write().await = 0;
    }

    /// Update TTL for cache entries
    pub fn set_ttl(&mut self, ttl_seconds: u64) {
        self.ttl = Duration::from_secs(ttl_seconds);
        debug!("⏱️  Signal cache TTL updated to {} seconds", ttl_seconds);
    }
}

/// Cache statistics
#[derive(Debug, Clone)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub hit_rate: f64,
    pub cache_size: usize,
}

impl std::fmt::Display for CacheStats {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Signal Cache: {} entries, {} hits, {} misses ({:.1}% hit rate)",
            self.cache_size, self.hits, self.misses, self.hit_rate
        )
    }
}