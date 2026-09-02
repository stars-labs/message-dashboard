#[cfg(target_os = "linux")]
use anyhow::Context;
use anyhow::Result;
use tracing_subscriber::EnvFilter;

const DEFAULT_FILTER: &str = "orange_pi_daemon_rust=info";

pub fn backend_name() -> &'static str {
    if cfg!(target_os = "linux") {
        "journald"
    } else {
        "terminal"
    }
}

pub fn init() -> Result<()> {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));

    #[cfg(target_os = "linux")]
    {
        use tracing_subscriber::prelude::*;

        let journald = tracing_journald::layer()
            .context("Failed to connect native tracing layer to journald")?
            .with_syslog_identifier("sms-daemon".to_string());
        tracing_subscriber::registry()
            .with(filter)
            .with(journald)
            .try_init()
            .map_err(|error| anyhow::anyhow!("Failed to initialize journald tracing: {error}"))?;
    }

    #[cfg(not(target_os = "linux"))]
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .try_init()
        .map_err(|error| anyhow::anyhow!("Failed to initialize terminal tracing: {error}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn selects_the_native_backend_on_linux_only() {
        let expected = if cfg!(target_os = "linux") {
            "journald"
        } else {
            "terminal"
        };
        assert_eq!(super::backend_name(), expected);
    }
}
