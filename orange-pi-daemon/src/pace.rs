use reqwest::header::HeaderMap;
use std::time::Duration;

const SHORTEST: Duration = Duration::from_secs(1);
const LONGEST: Duration = Duration::from_secs(600);

/// How long the Worker asks the daemon to wait before its next recurring call
/// (`X-Poll-Interval`, ADR 0002), held between 1 s and 10 min so one bad answer
/// can neither stop a loop nor spin it. `None` when the answer sets no pace.
pub(crate) fn worker_pace(headers: &HeaderMap) -> Option<Duration> {
    let seconds: u64 = headers
        .get("x-poll-interval")?
        .to_str()
        .ok()?
        .parse()
        .ok()?;
    Some(Duration::from_secs(seconds).clamp(SHORTEST, LONGEST))
}

#[cfg(test)]
mod tests;
