use std::time::Duration;
use tokio::time::sleep;
use tracing::{info, warn};

/// Retry manager with exponential backoff
/// Handles network failures gracefully to prevent error storms
pub struct RetryManager {
    max_retries: u32,
    base_delay_ms: u64,
    current_attempt: u32,
}

impl RetryManager {
    /// Create a new retry manager
    ///
    /// # Arguments
    /// * `max_retries` - Maximum number of retry attempts (e.g., 3)
    /// * `base_delay_ms` - Base delay in milliseconds (e.g., 1000 for 1s)
    pub fn new(max_retries: u32, base_delay_ms: u64) -> Self {
        Self {
            max_retries,
            base_delay_ms,
            current_attempt: 0,
        }
    }

    /// Reset the retry counter (call after a successful operation)
    pub fn reset(&mut self) {
        self.current_attempt = 0;
    }

    /// Check if we should retry
    pub fn should_retry(&self) -> bool {
        self.current_attempt < self.max_retries
    }

    /// Get the next delay duration with exponential backoff
    /// Returns delay in milliseconds
    pub fn next_delay(&mut self) -> u64 {
        self.current_attempt += 1;

        // Exponential backoff: base_delay * 2^(attempt-1)
        // Example with base_delay=1000ms:
        // Attempt 1: 1000ms (1s)
        // Attempt 2: 2000ms (2s)
        // Attempt 3: 4000ms (4s)
        let delay = self.base_delay_ms * (1 << (self.current_attempt.saturating_sub(1)));

        // Cap at 30 seconds to avoid very long waits
        delay.min(30_000)
    }

    /// Sleep with exponential backoff and return the delay used
    pub async fn sleep_with_backoff(&mut self) -> u64 {
        let delay_ms = self.next_delay();
        let delay_duration = Duration::from_millis(delay_ms);

        info!(
            "🔄 Retrying in {}ms (attempt {}/{})",
            delay_ms, self.current_attempt, self.max_retries
        );
        sleep(delay_duration).await;

        delay_ms
    }

    /// Execute a closure with retries
    ///
    /// # Example
    /// ```ignore
    /// let result = retry_manager.execute_with_retry(|| async {
    ///     api_client.upload_data(&data).await
    /// }).await;
    /// ```
    pub async fn execute_with_retry<F, Fut, T, E>(&mut self, mut operation: F) -> Result<T, E>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<T, E>>,
        E: std::fmt::Display,
    {
        loop {
            match operation().await {
                Ok(result) => {
                    if self.current_attempt > 0 {
                        info!(
                            "✅ Operation succeeded after {} retries",
                            self.current_attempt
                        );
                    }
                    self.reset();
                    return Ok(result);
                }
                Err(err) => {
                    if self.should_retry() {
                        warn!("❌ Operation failed: {}. Retrying...", err);
                        self.sleep_with_backoff().await;
                    } else {
                        warn!(
                            "❌ Operation failed after {} attempts: {}",
                            self.max_retries, err
                        );
                        return Err(err);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_retry_delays() {
        let mut rm = RetryManager::new(3, 1000);

        assert_eq!(rm.next_delay(), 1000); // 1s
        assert_eq!(rm.next_delay(), 2000); // 2s
        assert_eq!(rm.next_delay(), 4000); // 4s
        assert!(!rm.should_retry()); // Max retries reached
    }

    #[test]
    fn test_reset() {
        let mut rm = RetryManager::new(3, 1000);

        rm.next_delay();
        rm.next_delay();
        assert_eq!(rm.current_attempt, 2);

        rm.reset();
        assert_eq!(rm.current_attempt, 0);
        assert!(rm.should_retry());
    }

    #[test]
    fn test_max_delay_cap() {
        let mut rm = RetryManager::new(10, 1000);

        // Keep retrying until we hit the 30s cap
        for _ in 0..10 {
            let delay = rm.next_delay();
            assert!(delay <= 30_000, "Delay should be capped at 30s");
        }
    }
}
