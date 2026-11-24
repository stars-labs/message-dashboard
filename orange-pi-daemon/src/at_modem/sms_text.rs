use super::AtModemManager;
use crate::identifiers::SmsAddress;
use tracing::debug;

impl AtModemManager {
    /// Text-mode output after `AT+CSCS="UCS2"` is UTF-16BE hex.
    pub(super) fn decode_sms_content(raw: &str) -> String {
        let is_hex = raw.len() >= 4
            && raw.len().is_multiple_of(4)
            && raw.chars().all(|c| c.is_ascii_hexdigit());

        if is_hex {
            // Plain digit strings can look like hex; keep the raw text unless the decode is printable.
            if let Some(decoded) = Self::decode_ucs2_hex(raw) {
                if !decoded.is_empty()
                    && decoded
                        .chars()
                        .all(|c| !c.is_control() || c == '\n' || c == '\r')
                {
                    debug!("Decoded UCS2: {} -> {}", raw, decoded);
                    return decoded;
                }
            }
        }

        raw.to_string()
    }

    /// Some modems expose alphanumeric senders as concatenated decimal ASCII
    /// code points (for example, `83 105 110 ...` for `Singtel`). E.164 phone
    /// numbers are at most 15 digits, so only longer numeric values are eligible
    /// for this decoding path.
    pub(super) fn decode_sms_sender(raw: &str) -> String {
        if raw.chars().all(|character| character.is_ascii_digit()) {
            if raw.len() <= 15 {
                return raw.to_string();
            }

            if raw.len() <= 36 {
                let mut candidates = Vec::new();
                Self::decode_decimal_ascii_candidates(raw, 0, String::new(), &mut candidates);
                if let [candidate] = candidates.as_slice() {
                    if candidate
                        .chars()
                        .any(|character| character.is_ascii_alphabetic())
                        && candidate.chars().all(|character| {
                            character.is_ascii_alphanumeric()
                                || matches!(character, ' ' | '&' | '.' | '-' | '+')
                        })
                    {
                        return candidate.clone();
                    }
                }
            }
        }

        Self::decode_sms_content(raw)
    }

    fn decode_decimal_ascii_candidates(
        raw: &str,
        offset: usize,
        decoded: String,
        candidates: &mut Vec<String>,
    ) {
        if candidates.len() > 1 {
            return;
        }
        if offset == raw.len() {
            candidates.push(decoded);
            return;
        }

        for width in [2, 3] {
            let end = offset + width;
            if end > raw.len() {
                continue;
            }
            let Some(Ok(code_point)) = raw.get(offset..end).map(str::parse::<u8>) else {
                continue;
            };
            if !(32..=126).contains(&code_point) {
                continue;
            }

            let mut next = decoded.clone();
            next.push(char::from(code_point));
            Self::decode_decimal_ascii_candidates(raw, end, next, candidates);
        }
    }

    /// "4F60597D" -> "你好"
    pub(super) fn decode_ucs2_hex(hex: &str) -> Option<String> {
        if !hex.len().is_multiple_of(2) {
            return None;
        }

        let bytes = hex
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
            .collect::<Option<Vec<u8>>>()?;

        if bytes.len() % 2 != 0 {
            return None;
        }

        let u16_values: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .copied()
            .map(u16::from_be_bytes)
            .collect();

        String::from_utf16(&u16_values).ok()
    }

    /// +CMGL: 1,"REC READ","+1234567890","","24/01/15,10:30:45+32"
    /// Under UCS2 the sender and timestamp fields are hex encoded.
    pub(super) fn parse_cmgl_header(line: &str) -> Option<(u32, SmsAddress, String)> {
        let parts: Vec<&str> = line.split(',').collect();
        let [first_field, _, sender_field, ..] = parts.as_slice() else {
            return None;
        };

        let index_part = first_field.split(':').next_back()?.trim();
        let index = index_part.parse::<u32>().ok()?;

        let raw_sender = sender_field.trim().trim_matches('"');
        let sender = SmsAddress::from(Self::decode_sms_sender(raw_sender));

        let timestamp = if parts.len() >= 5 {
            let raw_date = parts.get(4).map_or("", |s| s.trim().trim_matches('"'));
            let raw_time = parts.get(5).map_or("", |s| s.trim().trim_matches('"'));
            let date = Self::decode_sms_content(raw_date);
            let time = Self::decode_sms_content(raw_time);
            Self::normalize_sms_timestamp(&date, &time)
        } else {
            chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string()
        };

        Some((index, sender, timestamp))
    }

    /// Split a trailing `-NN` offset off `time`, ignoring a leading sign character.
    fn split_negative_offset(time: &str) -> Option<(&str, &str)> {
        let pos = time.get(1..)?.rfind('-')? + 1;
        let (clock, tail) = time.split_at_checked(pos)?;
        Some((clock, tail.strip_prefix('-')?))
    }

    /// Inputs are "24/01/15" (YY/MM/DD) and "10:30:45+32" (HH:MM:SS plus a UTC offset in
    /// quarter-hours, so +32 is UTC+8). Returns RFC3339 UTC.
    pub(super) fn normalize_sms_timestamp(date: &str, time: &str) -> String {
        let date_parts: Vec<&str> = date.split('/').collect();

        let (time_clean, offset_minutes) = if let Some((t, tz)) = time.rsplit_once('+') {
            let tz_quarters: i32 = tz.parse().unwrap_or(0);
            (t, tz_quarters * 15)
        } else if let Some((t, tz)) = Self::split_negative_offset(time) {
            let tz_quarters: i32 = tz.parse().unwrap_or(0);
            (t, -(tz_quarters * 15))
        } else {
            (time, 0i32)
        };

        if let [year, month, day, ..] = date_parts.as_slice() {
            let year = format!("20{year}");

            let local_str = format!("{year}-{month}-{day}T{time_clean}");
            if let Ok(naive) =
                chrono::NaiveDateTime::parse_from_str(&local_str, "%Y-%m-%dT%H:%M:%S")
            {
                let utc = naive - chrono::Duration::minutes(i64::from(offset_minutes));
                return format!("{}Z", utc.format("%Y-%m-%dT%H:%M:%S%.3f"));
            }

            let tz_hours = offset_minutes.abs() / 60;
            let tz_mins = offset_minutes.abs() % 60;
            let sign = if offset_minutes >= 0 { '+' } else { '-' };
            return format!("{year}-{month}-{day}T{time_clean}{sign}{tz_hours:02}:{tz_mins:02}");
        }

        chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string()
    }
}
