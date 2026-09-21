//! Deliver a long SMS whose remaining parts are never going to arrive.
//!
//! A multipart message is only assembled, stored and deleted from the SIM once
//! every part is present. When a part is lost in the network the rest wait
//! forever: on 2026-09-21 there were 454 such groups (664 parts, the oldest from
//! October 2025) on 67 SIMs. They were re-read on every scan, and they occupy
//! SIM storage — a SIM that fills up makes the carrier drop new SMS.
//!
//! After a day the missing parts are not coming. The parts that did arrive are
//! then delivered as one message marked incomplete, which lets the normal
//! store-then-delete path free the SIM slots without losing their content.

use chrono::{DateTime, Duration, Utc};

/// How long to wait for missing parts. Carriers retry delivery for hours, not
/// days; a day keeps a slow second part from being split off as incomplete.
pub const ORPHAN_AFTER_HOURS: i64 = 24;

/// Whether a group's newest part is old enough that the rest will not arrive.
///
/// Judged by the newest part, not the oldest: a part that landed an hour ago
/// means the message is still being delivered, however old its siblings are.
/// A timestamp that cannot be read is never treated as old — failing to parse
/// must not be what deletes a message from a SIM.
pub fn is_orphaned(part_timestamps: &[&str], now: DateTime<Utc>) -> bool {
    let newest = part_timestamps
        .iter()
        .filter_map(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|at| at.with_timezone(&Utc))
        .max();
    match newest {
        Some(newest) if part_timestamps.len() == count_parsed(part_timestamps) => {
            now - newest >= Duration::hours(ORPHAN_AFTER_HOURS)
        }
        _ => false,
    }
}

fn count_parsed(part_timestamps: &[&str]) -> usize {
    part_timestamps
        .iter()
        .filter(|raw| DateTime::parse_from_rfc3339(raw).is_ok())
        .count()
}

/// The text delivered for an incomplete message: a marker naming how much of it
/// arrived, then the parts in order with each gap shown, so a reader can tell a
/// truncated sentence from a complete one.
pub fn assemble_partial(total_parts: u8, parts: &[(u8, String)]) -> String {
    let mut sorted: Vec<&(u8, String)> = parts.iter().collect();
    sorted.sort_by_key(|(number, _)| *number);

    let mut text = format!("[不完整 {}/{}] ", sorted.len(), total_parts);
    let mut expected = 1u8;
    for (number, content) in sorted {
        if *number > expected {
            text.push_str("[…]");
        }
        text.push_str(content);
        expected = number.saturating_add(1);
    }
    if expected <= total_parts {
        text.push_str("[…]");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(raw: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(raw)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn a_group_is_orphaned_a_day_after_its_newest_part() {
        let now = at("2026-09-21T12:00:00Z");
        // The real case: parts from October 2025 still on the SIM.
        assert!(is_orphaned(&["2025-10-09T01:47:57.000Z"], now));
        assert!(is_orphaned(&["2026-09-20T12:00:00.000Z"], now));
        assert!(!is_orphaned(&["2026-09-20T12:00:01.000Z"], now));
    }

    #[test]
    fn one_recent_part_keeps_the_whole_group_waiting() {
        let now = at("2026-09-21T12:00:00Z");
        assert!(!is_orphaned(
            &["2025-10-09T01:47:57.000Z", "2026-09-21T11:30:00.000Z"],
            now
        ));
    }

    #[test]
    fn an_unreadable_timestamp_never_makes_a_group_orphaned() {
        let now = at("2026-09-21T12:00:00Z");
        assert!(!is_orphaned(&["not a timestamp"], now));
        assert!(!is_orphaned(&["2025-10-09T01:47:57.000Z", "garbage"], now));
        assert!(!is_orphaned(&[], now));
    }

    #[test]
    fn the_partial_text_says_how_much_arrived_and_where_the_gaps_are() {
        let parts = vec![(3u8, "three".to_string()), (1u8, "one ".to_string())];
        assert_eq!(assemble_partial(4, &parts), "[不完整 2/4] one […]three[…]");
    }

    #[test]
    fn a_missing_first_or_last_part_is_marked_too() {
        assert_eq!(
            assemble_partial(3, &[(2, "middle".to_string())]),
            "[不完整 1/3] […]middle[…]"
        );
        assert_eq!(
            assemble_partial(2, &[(1, "start".to_string())]),
            "[不完整 1/2] start[…]"
        );
        assert_eq!(
            assemble_partial(2, &[(2, "end".to_string())]),
            "[不完整 1/2] […]end"
        );
    }
}
