//! Wire format and audio conversion for the Cloudflare Realtime WebSocket adapter.
//!
//! The adapter speaks protobuf frames carrying 16-bit signed little-endian PCM at
//! 48 kHz stereo. The EC20 speaks 8 kHz mono over its NMEA port. Everything here
//! is pure so it can be tested without a modem or a socket.
//!
//! Only three protobuf fields are involved, so the encoder is written by hand
//! rather than pulling in a code generator:
//!
//! ```proto
//! message Packet {
//!     uint32 sequenceNumber = 1;
//!     uint32 timestamp      = 2;
//!     bytes  payload        = 5;
//! }
//! ```

/// Sample rate the modem produces and consumes.
pub const MODEM_RATE: u32 = 8_000;
/// Sample rate the adapter produces and consumes.
pub const ADAPTER_RATE: u32 = 48_000;
/// Integer ratio between the two rates.
const RATIO: usize = 6;
/// `RATIO` as a signed sample-arithmetic operand.
const RATIO_I32: i32 = 6;
const _: () = assert!(ADAPTER_RATE == MODEM_RATE * 6);

/// One decoded adapter frame.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Packet {
    pub sequence_number: u32,
    pub timestamp: u32,
    /// 16-bit signed little-endian PCM, 48 kHz, stereo interleaved.
    pub payload: Vec<u8>,
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let [low, ..] = v.to_le_bytes();
        let byte = low & 0x7f;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn low_u32(v: u64) -> u32 {
    let [b0, b1, b2, b3, ..] = v.to_le_bytes();
    u32::from_le_bytes([b0, b1, b2, b3])
}

/// Clamp to the `i16` range.
fn saturate_i16(v: i32) -> i16 {
    i16::try_from(v).unwrap_or(if v < 0 { i16::MIN } else { i16::MAX })
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut result: u64 = 0;
    let mut shift = 0;
    while *pos < buf.len() {
        let byte = buf[*pos];
        *pos += 1;
        result |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    None
}

impl Packet {
    /// Encode to the adapter's protobuf wire format.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.payload.len() + 16);
        if self.sequence_number != 0 {
            out.push(0x08); // field 1, varint
            put_varint(&mut out, u64::from(self.sequence_number));
        }
        if self.timestamp != 0 {
            out.push(0x10); // field 2, varint
            put_varint(&mut out, u64::from(self.timestamp));
        }
        if !self.payload.is_empty() {
            out.push(0x2a); // field 5, length-delimited
                            // usize is at most 64 bits on every supported target, so the fallback is unreachable.
            put_varint(
                &mut out,
                u64::try_from(self.payload.len()).unwrap_or(u64::MAX),
            );
            out.extend_from_slice(&self.payload);
        }
        out
    }

    /// Decode a frame, skipping fields this daemon does not use.
    ///
    /// Returns `None` on a truncated or malformed frame rather than panicking,
    /// because these bytes arrive from the network.
    pub fn decode(buf: &[u8]) -> Option<Self> {
        let mut pkt = Packet::default();
        let mut pos = 0;
        while pos < buf.len() {
            let key = read_varint(buf, &mut pos)?;
            let field = key >> 3;
            let wire = key & 0x7;
            match (field, wire) {
                (1, 0) => pkt.sequence_number = low_u32(read_varint(buf, &mut pos)?),
                (2, 0) => pkt.timestamp = low_u32(read_varint(buf, &mut pos)?),
                (5, 2) => {
                    let len = usize::try_from(read_varint(buf, &mut pos)?).ok()?;
                    let end = pos.checked_add(len)?;
                    if end > buf.len() {
                        return None;
                    }
                    pkt.payload = buf[pos..end].to_vec();
                    pos = end;
                }
                // Unknown fields must be skipped, not treated as errors.
                (_, 0) => {
                    read_varint(buf, &mut pos)?;
                }
                (_, 2) => {
                    let len = usize::try_from(read_varint(buf, &mut pos)?).ok()?;
                    pos = pos.checked_add(len)?;
                    if pos > buf.len() {
                        return None;
                    }
                }
                (_, 5) => pos = pos.checked_add(4)?,
                (_, 1) => pos = pos.checked_add(8)?,
                _ => return None,
            }
        }
        Some(pkt)
    }
}

fn to_i16(bytes: &[u8]) -> Vec<i16> {
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}

fn to_bytes(samples: &[i16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Modem audio (8 kHz mono) to adapter audio (48 kHz stereo).
///
/// Upsampling is a 6x linear interpolation between neighbouring samples, then
/// each sample is duplicated across both channels. `last` carries the previous
/// block's final sample so the interpolation does not restart from silence on
/// every frame; pass `0` for the first block.
pub fn modem_to_adapter(pcm8k_mono: &[u8], last: &mut i16) -> Vec<u8> {
    let input = to_i16(pcm8k_mono);
    let mut out = Vec::with_capacity(input.len() * RATIO * 2);
    for &sample in &input {
        let prev = i32::from(*last);
        let cur = i32::from(sample);
        for step in 0..RATIO_I32 {
            let interpolated = prev + (cur - prev) * step / RATIO_I32;
            let v = saturate_i16(interpolated);
            out.push(v); // left
            out.push(v); // right
        }
        *last = sample;
    }
    to_bytes(&out)
}

/// Adapter audio (48 kHz stereo) to modem audio (8 kHz mono).
///
/// Channels are averaged, then each group of six samples is averaged as well.
/// Averaging doubles as the anti-alias filter a plain decimation would need.
/// A trailing partial group is dropped: at 48 kHz it is at most 0.1 ms.
pub fn adapter_to_modem(pcm48k_stereo: &[u8]) -> Vec<u8> {
    let input = to_i16(pcm48k_stereo);
    let mono: Vec<i32> = input
        .as_chunks::<2>()
        .0
        .iter()
        .map(|lr| i32::midpoint(i32::from(lr[0]), i32::from(lr[1])))
        .collect();
    let out: Vec<i16> = mono
        .as_chunks::<RATIO>()
        .0
        .iter()
        .map(|g| saturate_i16(g.iter().sum::<i32>() / RATIO_I32))
        .collect();
    to_bytes(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_packet_roundtrip() {
        let p = Packet {
            sequence_number: 42,
            timestamp: 1_234_567,
            payload: vec![1, 2, 3, 4],
        };
        assert_eq!(Packet::decode(&p.encode()), Some(p));
    }

    #[test]
    fn test_packet_payload_only() {
        let p = Packet {
            sequence_number: 0,
            timestamp: 0,
            payload: vec![9, 9],
        };
        let encoded = p.encode();
        assert_eq!(
            encoded[0], 0x2a,
            "payload must be field 5, length-delimited"
        );
        assert_eq!(Packet::decode(&encoded), Some(p));
    }

    #[test]
    fn test_packet_skips_unknown_fields() {
        // field 3 varint (0x18) then our payload; the unknown field must not break parsing.
        let mut buf = vec![0x18, 0x7f];
        buf.extend_from_slice(
            &Packet {
                sequence_number: 0,
                timestamp: 0,
                payload: vec![7],
            }
            .encode(),
        );
        assert_eq!(Packet::decode(&buf).map(|p| p.payload), Some(vec![7]));
    }

    #[test]
    fn test_packet_rejects_truncated_frames() {
        assert_eq!(Packet::decode(&[0x2a, 0x10, 0x01]), None); // claims 16 bytes, has 1
        assert_eq!(Packet::decode(&[0x08]), None); // varint key with no value
    }

    #[test]
    fn test_upsample_expands_by_six_and_duplicates_channels() {
        // Two mono samples at 8 kHz -> 12 stereo frames at 48 kHz -> 48 bytes.
        let pcm = to_bytes(&[1000, 2000]);
        let mut last = 0;
        let out = modem_to_adapter(&pcm, &mut last);
        assert_eq!(out.len(), 2 * RATIO * 2 * 2);
        let samples = to_i16(&out);
        for pair in samples.as_chunks::<2>().0 {
            assert_eq!(
                pair[0], pair[1],
                "left and right must carry the same sample"
            );
        }
        assert_eq!(last, 2000, "state must carry the last input sample");
    }

    #[test]
    fn test_downsample_is_the_inverse_size() {
        // 12 stereo frames at 48 kHz -> 2 mono samples at 8 kHz.
        let stereo: Vec<i16> = (0i16..).step_by(10).take(RATIO * 2 * 2).collect();
        let out = adapter_to_modem(&to_bytes(&stereo));
        assert_eq!(out.len(), 2 * 2);
    }

    #[test]
    fn test_downsample_averages_channels() {
        // Six frames of L=1000 R=2000 must average to 1500.
        let mut stereo = Vec::new();
        for _ in 0..RATIO {
            stereo.push(1000);
            stereo.push(2000);
        }
        let out = to_i16(&adapter_to_modem(&to_bytes(&stereo)));
        assert_eq!(out, vec![1500]);
    }

    #[test]
    fn test_roundtrip_preserves_a_constant_tone() {
        // A constant signal must survive up- and downsampling unchanged.
        let pcm = to_bytes(&[500; 8]);
        let mut last = 500;
        let up = modem_to_adapter(&pcm, &mut last);
        let down = to_i16(&adapter_to_modem(&up));
        assert_eq!(down, vec![500; 8]);
    }

    #[test]
    fn test_upsample_interpolates_full_scale_swings_without_wrapping() {
        let pcm = to_bytes(&[i16::MAX, i16::MIN]);
        let mut last = 0;
        let out = to_i16(&modem_to_adapter(&pcm, &mut last));
        let left: Vec<i16> = out.chunks(2).map(|pair| pair[0]).collect();
        assert_eq!(
            left,
            vec![0, 5461, 10922, 16383, 21844, 27305, 32767, 21845, 10922, 0, -10923, -21845]
        );
        assert_eq!(last, i16::MIN);
    }

    #[test]
    fn test_saturate_i16_clamps_at_both_edges() {
        assert_eq!(saturate_i16(0), 0);
        assert_eq!(saturate_i16(i32::from(i16::MAX)), i16::MAX);
        assert_eq!(saturate_i16(i32::from(i16::MIN)), i16::MIN);
        assert_eq!(saturate_i16(i32::from(i16::MAX) + 1), i16::MAX);
        assert_eq!(saturate_i16(i32::from(i16::MIN) - 1), i16::MIN);
        assert_eq!(saturate_i16(i32::MAX), i16::MAX);
        assert_eq!(saturate_i16(i32::MIN), i16::MIN);
    }

    #[test]
    fn test_upsample_of_silence_is_silence() {
        let mut last = 0;
        let out = to_i16(&modem_to_adapter(&to_bytes(&[0; 4]), &mut last));
        assert_eq!(out, vec![0; 4 * RATIO * 2]);
    }

    #[test]
    fn test_downsample_keeps_full_scale_levels() {
        for level in [i16::MIN, i16::MAX, 0] {
            let stereo = vec![level; RATIO * 2];
            assert_eq!(to_i16(&adapter_to_modem(&to_bytes(&stereo))), vec![level]);
        }
    }

    #[test]
    fn test_downsample_of_opposite_full_scale_channels_rounds_toward_zero() {
        let mut stereo = Vec::new();
        for _ in 0..RATIO {
            stereo.push(i16::MIN);
            stereo.push(i16::MAX);
        }
        assert_eq!(to_i16(&adapter_to_modem(&to_bytes(&stereo))), vec![0]);
    }

    #[test]
    fn test_decode_keeps_the_low_32_bits_of_oversized_varints() {
        let mut buf = vec![0x08];
        put_varint(&mut buf, 0x1_0000_0005);
        buf.push(0x10);
        put_varint(&mut buf, u64::MAX);
        assert_eq!(
            Packet::decode(&buf),
            Some(Packet {
                sequence_number: 5,
                timestamp: u32::MAX,
                payload: Vec::new(),
            })
        );
    }

    #[test]
    fn test_packet_roundtrip_of_a_multi_byte_length() {
        let p = Packet {
            sequence_number: u32::MAX,
            timestamp: u32::MAX,
            payload: vec![0xab; 300],
        };
        assert_eq!(Packet::decode(&p.encode()), Some(p));
    }

    #[test]
    fn test_odd_length_input_is_not_a_panic() {
        let mut last = 0;
        assert!(!modem_to_adapter(&[1, 2, 3], &mut last).is_empty());
        assert_eq!(adapter_to_modem(&[1, 2, 3]).len(), 0);
    }
}
