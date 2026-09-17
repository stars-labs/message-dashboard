//! Pure call-state logic for the voice bridge: `AT+CLCC` parsing and deciding
//! when a ringing modem should be reported to the Worker. Kept free of I/O so it
//! can be tested without a modem.

use crate::urc_reader::UrcEvent;
use std::time::{Duration, Instant};

/// One voice entry from `AT+CLCC`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VoiceCall {
    pub incoming: bool,
    /// 0 active, 1 held, 2 dialing, 3 alerting, 4 incoming, 5 waiting.
    pub stat: u8,
}

/// Voice calls listed by `AT+CLCC`.
///
/// Lines are `+CLCC: <id>,<dir>,<stat>,<mode>,<mpty>,...`. The LTE data bearer
/// shows up on every modem as a permanent `mode=1` entry, so anything but
/// `mode=0` is skipped.
pub fn parse_clcc(response: &str) -> Vec<VoiceCall> {
    response
        .lines()
        .filter_map(|line| line.trim().strip_prefix("+CLCC:"))
        .filter_map(|rest| {
            let fields: Vec<&str> = rest.trim().split(',').collect();
            let dir = fields.get(1)?.trim();
            let stat = fields.get(2)?.trim().parse().ok()?;
            let mode = fields.get(3)?.trim();
            (mode == "0").then_some(VoiceCall {
                incoming: dir == "1",
                stat,
            })
        })
        .collect()
}

pub fn is_ringing(calls: &[VoiceCall]) -> bool {
    calls.iter().any(|c| c.incoming && c.stat == 4)
}

/// What the URC reader should tell the Worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RingReport {
    /// Ringing; the caller id if one was delivered.
    Ringing(Option<String>),
    /// A call that was ringing stopped before anyone answered.
    Ended,
}

/// How long after the last `RING` a modem still counts as ringing. `RING`
/// repeats every few seconds while a call is offered.
const RING_WINDOW: Duration = Duration::from_secs(10);

/// Turns the URC stream of one modem into Worker reports.
///
/// `RING` is followed by `+CLIP` when the caller id is known, so a report is
/// sent on `+CLIP`; `RING` alone reports only when no caller id arrived
/// recently, which covers withheld numbers without doubling every report.
#[derive(Debug, Default)]
pub struct RingTracker {
    last_ring: Option<Instant>,
    last_caller: Option<(String, Instant)>,
}

impl RingTracker {
    pub fn on_event(&mut self, event: &UrcEvent, now: Instant) -> Option<RingReport> {
        let recent = |at: Instant| now.saturating_duration_since(at) < RING_WINDOW;
        match event {
            UrcEvent::Ring => {
                self.last_ring = Some(now);
                let caller_known = self.last_caller.as_ref().is_some_and(|(_, at)| recent(*at));
                (!caller_known).then_some(RingReport::Ringing(None))
            }
            UrcEvent::CallerId(number) => {
                self.last_caller = Some((number.clone(), now));
                Some(RingReport::Ringing(Some(number.clone())))
            }
            UrcEvent::NoCarrier => {
                let was_ringing = self.last_ring.is_some_and(recent);
                self.last_ring = None;
                self.last_caller = None;
                was_ringing.then_some(RingReport::Ended)
            }
            UrcEvent::PcmReady(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clcc_skips_the_data_bearer() {
        // Captured on S78 while S86 was calling it, 2026-09-16.
        let response =
            "\r\n+CLCC: 1,0,0,1,0,\"\",128\r\n+CLCC: 4,1,4,0,0,\"97817169\",129\r\n\r\nOK\r\n";
        assert_eq!(
            parse_clcc(response),
            vec![VoiceCall {
                incoming: true,
                stat: 4
            }]
        );
        assert!(is_ringing(&parse_clcc(response)));
    }

    #[test]
    fn clcc_with_only_data_has_no_voice_call() {
        let calls = parse_clcc("+CLCC: 1,0,0,1,0,\"\",128\r\nOK\r\n");
        assert!(calls.is_empty());
        assert!(!is_ringing(&calls));
    }

    #[test]
    fn clcc_active_outgoing_is_not_ringing() {
        let calls = parse_clcc("+CLCC: 3,0,0,0,0,\"92953543\",129\r\nOK");
        assert_eq!(
            calls,
            vec![VoiceCall {
                incoming: false,
                stat: 0
            }]
        );
        assert!(!is_ringing(&calls));
    }

    #[test]
    fn caller_id_reports_and_suppresses_the_next_ring() {
        let mut t = RingTracker::default();
        let t0 = Instant::now();
        assert_eq!(
            t.on_event(&UrcEvent::Ring, t0),
            Some(RingReport::Ringing(None))
        );
        assert_eq!(
            t.on_event(&UrcEvent::CallerId("92953543".into()), t0),
            Some(RingReport::Ringing(Some("92953543".into())))
        );
        assert_eq!(
            t.on_event(&UrcEvent::Ring, t0 + Duration::from_secs(4)),
            None
        );
    }

    #[test]
    fn withheld_number_reports_every_ring() {
        let mut t = RingTracker::default();
        let t0 = Instant::now();
        assert_eq!(
            t.on_event(&UrcEvent::Ring, t0),
            Some(RingReport::Ringing(None))
        );
        assert_eq!(
            t.on_event(&UrcEvent::Ring, t0 + Duration::from_secs(4)),
            Some(RingReport::Ringing(None))
        );
    }

    #[test]
    fn no_carrier_while_ringing_reports_ended_once() {
        let mut t = RingTracker::default();
        let t0 = Instant::now();
        t.on_event(&UrcEvent::Ring, t0);
        assert_eq!(
            t.on_event(&UrcEvent::NoCarrier, t0 + Duration::from_secs(2)),
            Some(RingReport::Ended)
        );
        assert_eq!(
            t.on_event(&UrcEvent::NoCarrier, t0 + Duration::from_secs(3)),
            None
        );
    }

    #[test]
    fn no_carrier_long_after_ringing_is_not_reported() {
        let mut t = RingTracker::default();
        let t0 = Instant::now();
        t.on_event(&UrcEvent::Ring, t0);
        assert_eq!(
            t.on_event(&UrcEvent::NoCarrier, t0 + Duration::from_secs(60)),
            None
        );
    }
}
