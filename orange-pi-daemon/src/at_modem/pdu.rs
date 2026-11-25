use super::{AtModemManager, AtSms, ConcatInfo};
use crate::identifiers::SmsAddress;
use anyhow::{anyhow, Result};
use tracing::debug;

impl AtModemManager {
    pub(super) fn parse_pdu_sms(index: u32, pdu_hex: &str) -> Result<AtSms> {
        let pdu_bytes: Vec<u8> = (0..pdu_hex.len())
            .step_by(2)
            .filter_map(|i| {
                let pair = pdu_hex.get(i..(i + 2).min(pdu_hex.len()))?;
                u8::from_str_radix(pair, 16).ok()
            })
            .collect();

        if pdu_bytes.len() < 10 {
            return Err(anyhow!("PDU too short"));
        }

        let mut pos = 0;

        // Skip the SMSC address
        let smsc_len = usize::from(*pdu_bytes.first().ok_or_else(|| anyhow!("PDU too short"))?);
        pos += 1 + smsc_len;

        let pdu_type = *pdu_bytes
            .get(pos)
            .ok_or_else(|| anyhow!("PDU truncated after SMSC"))?;
        pos += 1;

        // In semi-octets (digits)
        let sender_len = usize::from(
            *pdu_bytes
                .get(pos)
                .ok_or_else(|| anyhow!("PDU truncated at sender length"))?,
        );
        pos += 1;

        let sender_toa = *pdu_bytes
            .get(pos)
            .ok_or_else(|| anyhow!("PDU truncated at sender type"))?;
        pos += 1;

        // Type-of-number (bits 6-4): 0x05 = alphanumeric (GSM 7-bit packed)
        let sender_number_type = (sender_toa >> 4) & 0x07;

        let sender_bytes = sender_len.div_ceil(2);
        let sender_address = pdu_bytes
            .get(pos..pos + sender_bytes)
            .ok_or_else(|| anyhow!("PDU truncated at sender address"))?;
        let sender = if sender_number_type == 0x05 {
            // For alphanumeric senders sender_len counts semi-octets: septets = len * 4 / 7
            let num_septets = (sender_len * 4) / 7;
            Self::decode_pdu_7bit(sender_address, num_septets, 0)
        } else {
            Self::decode_bcd_phone(sender_address, sender_len)
        };
        pos += sender_bytes;

        // PID
        if pdu_bytes.get(pos).is_none() {
            return Err(anyhow!("PDU truncated at PID"));
        }
        pos += 1;

        let dcs = *pdu_bytes
            .get(pos)
            .ok_or_else(|| anyhow!("PDU truncated at DCS"))?;
        pos += 1;

        let timestamp_bytes = pdu_bytes
            .get(pos..pos + 7)
            .ok_or_else(|| anyhow!("PDU truncated at timestamp"))?;
        let timestamp = Self::decode_pdu_timestamp(timestamp_bytes);
        pos += 7;

        let user_data_len = usize::from(
            *pdu_bytes
                .get(pos)
                .ok_or_else(|| anyhow!("PDU truncated at UDL"))?,
        );
        pos += 1;

        let has_udh = (pdu_type & 0x40) != 0;
        let mut concat_info = None;
        let mut text_start = pos;
        let udhl = if has_udh {
            let udhl = usize::from(
                *pdu_bytes
                    .get(pos)
                    .ok_or_else(|| anyhow!("PDU truncated at UDHL"))?,
            );
            pos += 1;

            let udh = pdu_bytes
                .get(pos..pos + udhl)
                .ok_or_else(|| anyhow!("PDU truncated at UDH"))?;
            concat_info = Self::extract_udh_concat(udh);
            pos += udhl;
            text_start = pos;
            udhl
        } else {
            0
        };

        // GSM 03.38 DCS: 0x00 = 7-bit default alphabet, 0x04 = 8-bit data, 0x08 = UCS-2
        let text_bytes = pdu_bytes
            .get(text_start..)
            .ok_or_else(|| anyhow!("PDU truncated before text"))?;
        let text = if (dcs & 0x08) != 0 {
            debug!("PDU encoding detected: UCS-2 (DCS: 0x{:02X})", dcs);
            Self::decode_pdu_ucs2(text_bytes, user_data_len)
        } else if (dcs & 0x04) != 0 {
            debug!("PDU encoding detected: 8-bit data (DCS: 0x{:02X})", dcs);
            Self::decode_pdu_8bit(text_bytes)
        } else {
            debug!("PDU encoding detected: 7-bit GSM (DCS: 0x{:02X})", dcs);
            Self::decode_pdu_7bit(text_bytes, user_data_len, udhl)
        };

        Ok(AtSms {
            storage: None,
            index,
            sender: SmsAddress::from(sender),
            timestamp,
            text,
            concat_info,
        })
    }

    /// Plain 8-bit text passes through; binary WAP Push payloads become a readable
    /// notification; other binary data is converted lossily.
    pub(super) fn decode_pdu_8bit(bytes: &[u8]) -> String {
        if let Ok(text) = std::str::from_utf8(bytes) {
            let is_plain_text = text.chars().all(|character| {
                !character.is_control() || matches!(character, '\n' | '\r' | '\t')
            });
            if is_plain_text {
                return text.to_string();
            }
        }

        if let Some(url) = Self::extract_http_url(bytes) {
            return format!("运营商 WAP Push\n链接：{url}");
        }

        String::from_utf8_lossy(bytes).to_string()
    }

    fn extract_http_url(bytes: &[u8]) -> Option<String> {
        let start = (0..bytes.len()).find(|&index| {
            bytes
                .get(index..)
                .is_some_and(|rest| rest.starts_with(b"https://") || rest.starts_with(b"http://"))
        })?;
        let end = bytes
            .get(start..)?
            .iter()
            .position(|byte| !byte.is_ascii_graphic())
            .map_or(bytes.len(), |length| start + length);
        std::str::from_utf8(bytes.get(start..end)?)
            .ok()
            .map(str::to_owned)
    }

    pub(super) fn extract_udh_concat(udh_bytes: &[u8]) -> Option<ConcatInfo> {
        let mut rest = udh_bytes;
        while let [iei, iedl, tail @ ..] = rest {
            let Some((element, next)) = tail.split_at_checked(usize::from(*iedl)) else {
                break;
            };

            // IEI 0x00: Concatenated short message, 8-bit reference
            // IEI 0x08: Concatenated short message, 16-bit reference
            // The 16-bit form keeps only the lower byte of its reference.
            let ids = match (*iei, element) {
                (0x00, &[ref_id, total_parts, part_number])
                | (0x08, &[_, ref_id, total_parts, part_number]) => {
                    Some((ref_id, total_parts, part_number))
                }
                _ => None,
            };
            if let Some((ref_id, total_parts, part_number)) = ids {
                return Some(ConcatInfo {
                    ref_id,
                    total_parts,
                    part_number,
                });
            }

            rest = next;
        }
        None
    }

    /// Map a BCD nibble (0x0-0xF) to its character per GSM 03.40 Section 9.1.2.3
    fn bcd_nibble_to_char(nibble: u8) -> Option<char> {
        match nibble {
            0x0..=0x9 => Some(char::from(b'0' + nibble)),
            0xA => Some('*'),
            0xB => Some('#'),
            0xC => Some('a'),
            0xD => Some('b'),
            _ => None, // 0xE and 0xF are reserved filler
        }
    }

    pub(super) fn decode_bcd_phone(bytes: &[u8], digit_count: usize) -> String {
        let mut phone = String::new();
        for (i, byte) in bytes.iter().enumerate() {
            let nibble_lo = byte & 0x0F;
            let nibble_hi = (byte >> 4) & 0x0F;

            if i * 2 < digit_count {
                if let Some(ch) = Self::bcd_nibble_to_char(nibble_lo) {
                    phone.push(ch);
                }
            }
            if i * 2 + 1 < digit_count {
                if let Some(ch) = Self::bcd_nibble_to_char(nibble_hi) {
                    phone.push(ch);
                }
            }
        }
        phone
    }

    pub(super) fn decode_pdu_timestamp(bytes: &[u8]) -> String {
        let &[year, month, day, hour, minute, second, tz_byte, ..] = bytes else {
            return chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
        };

        // Semi-octets: each byte carries its BCD digits swapped (low nibble is the tens)
        let decode_bcd = |b: u8| -> u8 {
            let swapped = ((b & 0x0F) << 4) | ((b >> 4) & 0x0F);
            let high = (swapped >> 4) & 0x0F;
            let low = swapped & 0x0F;
            high * 10 + low
        };

        let year = i32::from(decode_bcd(year)) + 2000;
        let month = u32::from(decode_bcd(month));
        let day = u32::from(decode_bcd(day));
        let hour = u32::from(decode_bcd(hour));
        let minute = u32::from(decode_bcd(minute));
        let second = u32::from(decode_bcd(second));

        // Timezone is BCD quarter-hours; bit 7 of the raw byte is the sign.
        let tz_sign = if (tz_byte & 0x80) != 0 { -1 } else { 1 };
        let tz_quarters = i32::from(decode_bcd(tz_byte & 0x7F));
        let tz_offset_minutes = tz_sign * tz_quarters * 15;

        let naive = chrono::NaiveDate::from_ymd_opt(year, month, day)
            .and_then(|d| d.and_hms_opt(hour, minute, second))
            .unwrap_or_else(|| chrono::Utc::now().naive_utc());

        let dt = chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
            naive - chrono::Duration::minutes(i64::from(tz_offset_minutes)),
            chrono::Utc,
        );

        dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
    }

    /// GSM 03.38 default alphabet. Index 0x1B (ESC) is never looked up; the decoder
    /// handles it as the extension prefix.
    const GSM_DEFAULT_ALPHABET: [char; 128] = [
        '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', // 0x00-0x07
        'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å', // 0x08-0x0F
        'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', // 0x10-0x17
        'Σ', 'Θ', 'Ξ', ' ', 'Æ', 'æ', 'ß', 'É', // 0x18-0x1F
        ' ', '!', '"', '#', '¤', '%', '&', '\'', // 0x20-0x27
        '(', ')', '*', '+', ',', '-', '.', '/', // 0x28-0x2F
        '0', '1', '2', '3', '4', '5', '6', '7', // 0x30-0x37
        '8', '9', ':', ';', '<', '=', '>', '?', // 0x38-0x3F
        '¡', 'A', 'B', 'C', 'D', 'E', 'F', 'G', // 0x40-0x47
        'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', // 0x48-0x4F
        'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', // 0x50-0x57
        'X', 'Y', 'Z', 'Ä', 'Ö', 'Ñ', 'Ü', '§', // 0x58-0x5F
        '¿', 'a', 'b', 'c', 'd', 'e', 'f', 'g', // 0x60-0x67
        'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', // 0x68-0x6F
        'p', 'q', 'r', 's', 't', 'u', 'v', 'w', // 0x70-0x77
        'x', 'y', 'z', 'ä', 'ö', 'ñ', 'ü', 'à', // 0x78-0x7F
    ];

    /// GSM 03.38 extension table, reached via the ESC 0x1B prefix.
    fn gsm_extension_char(code: u8) -> Option<char> {
        match code {
            0x0A => Some('\u{000C}'),
            0x14 => Some('^'),
            0x28 => Some('{'),
            0x29 => Some('}'),
            0x2F => Some('\\'),
            0x3C => Some('['),
            0x3D => Some('~'),
            0x3E => Some(']'),
            0x40 => Some('|'),
            0x65 => Some('€'),
            _ => None,
        }
    }

    /// `bytes` excludes the UDH; `septet_count` is the User Data Length in septets;
    /// `udhl` is the UDH length in bytes (0 if none), which determines the fill bits.
    pub(super) fn decode_pdu_7bit(bytes: &[u8], septet_count: usize, udhl: usize) -> String {
        // Fill bits pad the UDH out to a septet boundary.
        let fill_bits = if udhl > 0 {
            (7 - ((udhl + 1) * 8) % 7) % 7
        } else {
            0
        };

        let mut result = String::new();
        let mut bit_pos = fill_bits;
        let mut escape_next = false;

        for _ in 0..septet_count {
            let byte_pos = bit_pos / 8;
            let shift = bit_pos % 8;

            let Some(&low_byte) = bytes.get(byte_pos) else {
                break;
            };
            let mut char_val = (low_byte >> shift) & 0x7F;
            if shift > 1 {
                if let Some(&high_byte) = bytes.get(byte_pos + 1) {
                    char_val |= (high_byte << (8 - shift)) & 0x7F;
                }
            }

            if escape_next {
                escape_next = false;
                if let Some(ext_char) = Self::gsm_extension_char(char_val) {
                    result.push(ext_char);
                } else {
                    result.push(' ');
                }
            } else if char_val == 0x1B {
                escape_next = true;
            } else {
                result.push(
                    Self::GSM_DEFAULT_ALPHABET
                        .get(usize::from(char_val))
                        .copied()
                        .unwrap_or(' '),
                );
            }

            bit_pos += 7;
        }

        result
    }

    pub(super) fn decode_pdu_ucs2(bytes: &[u8], _udl: usize) -> String {
        if bytes.is_empty() {
            return String::new();
        }

        let u16_values: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .copied()
            .map(u16::from_be_bytes)
            .collect();

        String::from_utf16(&u16_values).unwrap_or_else(|_| String::from("?"))
    }
}
