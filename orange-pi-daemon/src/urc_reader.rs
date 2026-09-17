//! Parsing of call-related URCs that arrive on the MODEM port.
//!
//! The AT port is opened per command and closed again, so URCs sent there are
//! lost. `AtModemManager::init_urc_port` routes them to the MODEM port instead,
//! where a persistent reader can see them. This module holds the parsing half so
//! it can be tested without a modem.

/// A call-related unsolicited result code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrcEvent {
    /// An incoming call is ringing. Repeats every few seconds while ringing.
    Ring,
    /// Caller ID for the incoming call, delivered alongside `Ring` when
    /// `AT+CLIP=1` is set.
    CallerId(String),
    /// The call ended: the far end hung up, or the network dropped it.
    NoCarrier,
    /// Voice-over-USB flow control. `false` means the module is busy and the
    /// host must stop sending PCM; `true` means it is ready again.
    PcmReady(bool),
}

/// Parse one line read from the MODEM port.
///
/// Returns `None` for blank lines, command echoes, and URCs this daemon does not
/// act on, so callers can feed every line in unchanged.
pub fn parse_urc_line(line: &str) -> Option<UrcEvent> {
    let line = line.trim();

    match line {
        "" => return None,
        "RING" => return Some(UrcEvent::Ring),
        "NO CARRIER" => return Some(UrcEvent::NoCarrier),
        _ => {}
    }

    // +CLIP: "92953543",128,"",0,,0
    //
    // Take exactly the first quoted field. Stripping quotes greedily would turn a
    // withheld number ("") into the rest of the line.
    if let Some(rest) = line.strip_prefix("+CLIP:") {
        let quoted = rest.trim().strip_prefix('"')?;
        let (number, _) = quoted.split_once('"')?;
        let number = number.trim();
        if number.is_empty() {
            return None;
        }
        return Some(UrcEvent::CallerId(number.to_string()));
    }

    // +QPCMV: 0 / +QPCMV: 1
    if let Some(rest) = line.strip_prefix("+QPCMV:") {
        return match rest.trim() {
            "0" => Some(UrcEvent::PcmReady(false)),
            "1" => Some(UrcEvent::PcmReady(true)),
            _ => None,
        };
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // The strings below are exactly what an EC20 sent on the MODEM port during
    // the 2026-09-16 inbound-call test.
    #[test]
    fn test_parses_ring() {
        assert_eq!(parse_urc_line("RING"), Some(UrcEvent::Ring));
        assert_eq!(parse_urc_line("RING\r"), Some(UrcEvent::Ring));
    }

    #[test]
    fn test_parses_caller_id() {
        assert_eq!(
            parse_urc_line("+CLIP: \"92953543\",128,\"\",0,,0"),
            Some(UrcEvent::CallerId("92953543".to_string()))
        );
        assert_eq!(
            parse_urc_line("+CLIP: \"+6592953543\",145,\"\",0,,0"),
            Some(UrcEvent::CallerId("+6592953543".to_string()))
        );
    }

    #[test]
    fn test_withheld_caller_id_is_ignored() {
        assert_eq!(parse_urc_line("+CLIP: \"\",128,\"\",0,,0"), None);
    }

    #[test]
    fn test_malformed_clip_is_ignored() {
        assert_eq!(parse_urc_line("+CLIP: 92953543,128"), None);
        assert_eq!(parse_urc_line("+CLIP:"), None);
        assert_eq!(parse_urc_line("+CLIP: \"92953543"), None);
    }

    #[test]
    fn test_parses_no_carrier() {
        assert_eq!(parse_urc_line("NO CARRIER"), Some(UrcEvent::NoCarrier));
    }

    #[test]
    fn test_parses_pcm_flow_control() {
        assert_eq!(parse_urc_line("+QPCMV: 0"), Some(UrcEvent::PcmReady(false)));
        assert_eq!(parse_urc_line("+QPCMV: 1"), Some(UrcEvent::PcmReady(true)));
        assert_eq!(parse_urc_line("+QPCMV: 1,0"), None);
    }

    #[test]
    fn test_ignores_blank_and_unrelated_lines() {
        assert_eq!(parse_urc_line(""), None);
        assert_eq!(parse_urc_line("   "), None);
        assert_eq!(parse_urc_line("OK"), None);
        assert_eq!(parse_urc_line("+CREG: 0,1"), None);
    }
}
