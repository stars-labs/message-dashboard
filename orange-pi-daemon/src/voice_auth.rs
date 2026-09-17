//! Admission checks for the voice bridge listener.
//!
//! The listener is reachable from the whole internet, so a connection has to pass
//! two independent checks before it can touch a modem:
//!
//! 1. The peer address is in Cloudflare's published ranges. The Realtime SFU is
//!    the only legitimate client.
//! 2. The request path carries an HMAC the Worker signed with the shared
//!    `SMS_API_KEY`, binding the call id, leg, action, SIM, number and expiry.
//!    A path cannot be altered to dial a different number or reused after expiry.
//!
//! Path shape, built by `sms-dashboard/server/api/calls.js`:
//! `/voice/{callId}/{leg}/{action}/{iccid}/{number}/{exp}/{sig}`

use ring::hmac;
use std::net::IpAddr;

/// Which adapter a connection belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Leg {
    /// Local (ingest) adapter: the daemon sends modem audio into the SFU.
    Up,
    /// Remote (egress) adapter: the SFU streams browser audio to the daemon.
    Down,
}

impl Leg {
    fn as_str(self) -> &'static str {
        match self {
            Leg::Up => "up",
            Leg::Down => "down",
        }
    }
}

/// What the modem should do when the first leg of a call arrives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallAction {
    /// Place an outbound call to this E.164 number.
    Dial(String),
    /// Answer the call ringing on the SIM.
    Answer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceRequest {
    pub call_id: String,
    pub leg: Leg,
    pub action: CallAction,
    pub iccid: String,
    pub exp: u64,
    sig: String,
}

impl VoiceRequest {
    fn action_str(&self) -> &'static str {
        match self.action {
            CallAction::Dial(_) => "dial",
            CallAction::Answer => "answer",
        }
    }

    fn number_str(&self) -> &str {
        match &self.action {
            CallAction::Dial(number) => number,
            CallAction::Answer => "-",
        }
    }

    /// The exact string the Worker signs.
    fn signing_input(&self) -> String {
        format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            self.call_id,
            self.leg.as_str(),
            self.action_str(),
            self.iccid,
            self.number_str(),
            self.exp
        )
    }
}

fn is_e164(number: &str) -> bool {
    let Some(digits) = number.strip_prefix('+') else {
        return false;
    };
    (7..=15).contains(&digits.len())
        && !digits.starts_with('0')
        && digits.bytes().all(|b| b.is_ascii_digit())
}

fn is_call_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// Decode `%XX` escapes. The Worker runs every segment through
/// `encodeURIComponent`, so the `+` of an E.164 number arrives as `%2B`.
fn percent_decode(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Parse a request path. Anything malformed is `None`; the signature is not
/// checked here, see [`verify`].
pub fn parse_path(path: &str) -> Option<VoiceRequest> {
    let parts = path
        .strip_prefix("/voice/")?
        .split('/')
        .map(percent_decode)
        .collect::<Option<Vec<String>>>()?;
    let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
    let [call_id, leg, action, iccid, number, exp, sig] = parts.as_slice() else {
        return None;
    };

    let leg = match *leg {
        "up" => Leg::Up,
        "down" => Leg::Down,
        _ => return None,
    };
    let action = match (*action, *number) {
        ("dial", n) if is_e164(n) => CallAction::Dial(n.to_string()),
        ("answer", "-") => CallAction::Answer,
        _ => return None,
    };
    if !is_call_id(call_id)
        || iccid.is_empty()
        || iccid.len() > 22
        || !iccid.bytes().all(|b| b.is_ascii_digit())
        || sig.len() != 64
    {
        return None;
    }

    Some(VoiceRequest {
        call_id: call_id.to_string(),
        leg,
        action,
        iccid: iccid.to_string(),
        exp: exp.parse().ok()?,
        sig: sig.to_ascii_lowercase(),
    })
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

/// Check the signature (constant time) and the expiry.
pub fn verify(api_key: &str, request: &VoiceRequest, now_unix: u64) -> bool {
    if request.exp < now_unix {
        return false;
    }
    let Some(tag) = decode_hex(&request.sig) else {
        return false;
    };
    let key = hmac::Key::new(hmac::HMAC_SHA256, api_key.as_bytes());
    hmac::verify(&key, request.signing_input().as_bytes(), &tag).is_ok()
}

/// Cloudflare's published ranges (<https://www.cloudflare.com/ips/>, fetched
/// 2026-09-17). The SFU adapter was observed connecting from `172.70.204.71`.
const CLOUDFLARE_V4: &[(u32, u8)] = &[
    (0xADF5_3000, 20), // 173.245.48.0/20
    (0x6715_F400, 22), // 103.21.244.0/22
    (0x6716_C800, 22), // 103.22.200.0/22
    (0x671F_0400, 22), // 103.31.4.0/22
    (0x8D65_4000, 18), // 141.101.64.0/18
    (0x6CA2_C000, 18), // 108.162.192.0/18
    (0xBE5D_F000, 20), // 190.93.240.0/20
    (0xBC72_6000, 20), // 188.114.96.0/20
    (0xC5EA_F000, 22), // 197.234.240.0/22
    (0xC629_8000, 17), // 198.41.128.0/17
    (0xA29E_0000, 15), // 162.158.0.0/15
    (0x6810_0000, 13), // 104.16.0.0/13
    (0x6818_0000, 14), // 104.24.0.0/14
    (0xAC40_0000, 13), // 172.64.0.0/13
    (0x8300_4800, 22), // 131.0.72.0/22
];

const CLOUDFLARE_V6: &[(u128, u8)] = &[
    (0x2400_cb00_u128 << 96, 32),
    (0x2606_4700_u128 << 96, 32),
    (0x2803_f800_u128 << 96, 32),
    (0x2405_b500_u128 << 96, 32),
    (0x2405_8100_u128 << 96, 32),
    (0x2a06_98c0_u128 << 96, 29),
    (0x2c0f_f248_u128 << 96, 32),
];

pub fn is_cloudflare_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let addr = u32::from(v4);
            CLOUDFLARE_V4
                .iter()
                .any(|&(net, len)| addr >> (32 - len) == net >> (32 - len))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_cloudflare_ip(IpAddr::V4(v4));
            }
            let addr = u128::from(v6);
            CLOUDFLARE_V6
                .iter()
                .any(|&(net, len)| addr >> (128 - len) == net >> (128 - len))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shared with `sms-dashboard/server/api/calls.test.js`; computed with
    /// `openssl dgst -sha256 -hmac test-key`.
    const VECTOR_PATH: &str = "/voice/11111111-1111-4111-8111-111111111111/up/dial/8965012306052373985/+6592953543/1800000000/2228b401ad42d60138d9f2131e8b4056a77fe21d77ab41810698a0bae6f1e325";

    #[test]
    fn accepts_the_worker_signed_vector() {
        let request = parse_path(VECTOR_PATH).expect("vector parses");
        assert_eq!(request.leg, Leg::Up);
        assert_eq!(request.action, CallAction::Dial("+6592953543".into()));
        assert!(verify("test-key", &request, 1_700_000_000));
    }

    #[test]
    fn accepts_the_vector_as_the_worker_encodes_it() {
        let encoded = VECTOR_PATH.replace("/+", "/%2B");
        let request = parse_path(&encoded).expect("encoded vector parses");
        assert_eq!(request.action, CallAction::Dial("+6592953543".into()));
        assert!(verify("test-key", &request, 1_700_000_000));
    }

    #[test]
    fn rejects_broken_escapes() {
        assert!(parse_path(&VECTOR_PATH.replace("/+", "/%2")).is_none());
        assert!(parse_path(&VECTOR_PATH.replace("/+", "/%ZZ")).is_none());
    }

    #[test]
    fn rejects_a_different_key() {
        let request = parse_path(VECTOR_PATH).unwrap();
        assert!(!verify("other-key", &request, 1_700_000_000));
    }

    #[test]
    fn rejects_a_tampered_number() {
        let tampered = VECTOR_PATH.replace("+6592953543", "+6592953544");
        let request = parse_path(&tampered).unwrap();
        assert!(!verify("test-key", &request, 1_700_000_000));
    }

    #[test]
    fn rejects_a_swapped_leg() {
        let swapped = VECTOR_PATH.replace("/up/", "/down/");
        let request = parse_path(&swapped).unwrap();
        assert!(!verify("test-key", &request, 1_700_000_000));
    }

    #[test]
    fn rejects_after_expiry() {
        let request = parse_path(VECTOR_PATH).unwrap();
        assert!(!verify("test-key", &request, 1_800_000_001));
    }

    #[test]
    fn parses_answer_with_placeholder_number() {
        let path = "/voice/11111111-1111-4111-8111-111111111111/down/answer/8965012306052373985/-/1800000000/".to_string()
            + &"0".repeat(64);
        let request = parse_path(&path).unwrap();
        assert_eq!(request.action, CallAction::Answer);
        assert_eq!(request.leg, Leg::Down);
    }

    #[test]
    fn rejects_malformed_paths() {
        let sig = "0".repeat(64);
        let id = "11111111-1111-4111-8111-111111111111";
        for path in [
            "/adapter-test".to_string(),
            format!("/voice/{id}/up/dial/8965/6592953543/1800000000/{sig}"), // no +
            format!("/voice/{id}/up/answer/8965/+6592953543/1800000000/{sig}"), // answer with number
            format!("/voice/{id}/sideways/dial/8965/+6592953543/1800000000/{sig}"),
            format!("/voice/{id}/up/dial/89a5/+6592953543/1800000000/{sig}"),
            format!("/voice/{id}/up/dial/8965/+6592953543/soon/{sig}"),
            format!("/voice/{id}/up/dial/8965/+6592953543/1800000000/abc"),
            format!("/voice/{id}/up/dial/8965/+6592953543/1800000000/{sig}/extra"),
        ] {
            assert!(parse_path(&path).is_none(), "{path}");
        }
    }

    #[test]
    fn cloudflare_allowlist() {
        let yes = [
            "172.70.204.71",
            "162.158.1.1",
            "2606:4700::1",
            "::ffff:104.16.0.1",
        ];
        let no = [
            "213.35.97.233",
            "10.171.150.102",
            "172.63.255.255",
            "2001:db8::1",
        ];
        for ip in yes {
            assert!(is_cloudflare_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in no {
            assert!(!is_cloudflare_ip(ip.parse().unwrap()), "{ip}");
        }
    }
}
