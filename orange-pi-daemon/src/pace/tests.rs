use super::worker_pace;
use reqwest::header::{HeaderMap, HeaderValue};
use std::time::Duration;

fn answered(value: &'static str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("x-poll-interval", HeaderValue::from_static(value));
    headers
}

#[test]
fn waits_what_the_worker_says() {
    assert_eq!(worker_pace(&answered("10")), Some(Duration::from_secs(10)));
}

#[test]
fn holds_the_pace_between_one_second_and_ten_minutes() {
    assert_eq!(worker_pace(&answered("0")), Some(Duration::from_secs(1)));
    assert_eq!(
        worker_pace(&answered("86400")),
        Some(Duration::from_secs(600))
    );
}

#[test]
fn sets_no_pace_without_a_readable_header() {
    assert_eq!(worker_pace(&HeaderMap::new()), None);
    assert_eq!(worker_pace(&answered("soon")), None);
    assert_eq!(worker_pace(&answered("-5")), None);
}
