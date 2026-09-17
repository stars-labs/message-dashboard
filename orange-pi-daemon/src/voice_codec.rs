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
const RATIO: usize = (ADAPTER_RATE / MODEM_RATE) as usize;

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
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut result: u64 = 0;
    let mut shift = 0;
    while *pos < buf.len() {
        let byte = buf[*pos];
        *pos += 1;
        result |= ((byte & 0x7f) as u64) << shift;
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
            put_varint(&mut out, self.sequence_number as u64);
        }
        if self.timestamp != 0 {
            out.push(0x10); // field 2, varint
            put_varint(&mut out, self.timestamp as u64);
        }
        if !self.payload.is_empty() {
            out.push(0x2a); // field 5, length-delimited
            put_varint(&mut out, self.payload.len() as u64);
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
                (1, 0) => pkt.sequence_number = read_varint(buf, &mut pos)? as u32,
                (2, 0) => pkt.timestamp = read_varint(buf, &mut pos)? as u32,
                (5, 2) => {
                    let len = read_varint(buf, &mut pos)? as usize;
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
                    let len = read_varint(buf, &mut pos)? as usize;
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
        .chunks_exact(2)
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
        let prev = *last as i32;
        let cur = sample as i32;
        for step in 0..RATIO {
            let interpolated = prev + (cur - prev) * step as i32 / RATIO as i32;
            let v = interpolated as i16;
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
        .chunks_exact(2)
        .map(|lr| (lr[0] as i32 + lr[1] as i32) / 2)
        .collect();
    let out: Vec<i16> = mono
        .chunks_exact(RATIO)
        .map(|g| (g.iter().sum::<i32>() / RATIO as i32) as i16)
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
        for pair in samples.chunks_exact(2) {
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
        let stereo: Vec<i16> = (0..RATIO * 2 * 2).map(|i| (i * 10) as i16).collect();
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
    fn test_odd_length_input_is_not_a_panic() {
        let mut last = 0;
        assert!(modem_to_adapter(&[1, 2, 3], &mut last).len() > 0);
        assert_eq!(adapter_to_modem(&[1, 2, 3]).len(), 0);
    }
}
