//! Pacing of browser audio towards the modem.
//!
//! The EC20 wants host PCM in 100 ms frames (1600 bytes of 8 kHz s16le mono)
//! and asks for a pause with `+QPCMV: 0`, resuming with `+QPCMV: 1`. The
//! adapter delivers browser audio in much smaller packets whenever they arrive,
//! so the bridge collects them here and hands the modem one frame per tick.
//! Pure and timer-free, so the policy can be tested without a port.

use std::collections::VecDeque;
use std::time::Duration;

/// One host frame: 100 ms of 8 kHz, 16-bit, mono PCM.
pub const HOST_FRAME: usize = 1600;
/// How often the bridge asks for a frame.
pub const HOST_FRAME_INTERVAL: Duration = Duration::from_millis(100);
/// Audio held back beyond this is dropped, oldest first. Three frames absorb
/// adapter jitter and a short `+QPCMV: 0` pause without turning the call into a
/// delayed echo of itself.
pub const MAX_BUFFERED: usize = HOST_FRAME * 3;

#[derive(Debug)]
pub struct Pacer {
    buffer: VecDeque<u8>,
    ready: bool,
    dropped: usize,
}

impl Default for Pacer {
    fn default() -> Self {
        Self {
            buffer: VecDeque::with_capacity(MAX_BUFFERED + HOST_FRAME),
            // The module only reports a change, never an initial state, and it
            // accepts audio as soon as `AT+QPCMV=1,0` succeeded.
            ready: true,
            dropped: 0,
        }
    }
}

impl Pacer {
    /// Queue browser audio. Anything beyond [`MAX_BUFFERED`] evicts the oldest
    /// bytes, so a stalled modem costs audio rather than latency.
    pub fn push(&mut self, pcm: &[u8]) {
        self.buffer.extend(pcm);
        if self.buffer.len() > MAX_BUFFERED {
            let excess = self.buffer.len() - MAX_BUFFERED;
            self.buffer.drain(..excess);
            self.dropped += excess;
        }
    }

    /// `+QPCMV: 1` is ready, `+QPCMV: 0` is busy.
    pub fn set_ready(&mut self, ready: bool) {
        self.ready = ready;
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }

    /// The frame to write on this tick, if the module may receive one and a
    /// whole frame is queued. A partial frame waits for the next tick instead
    /// of being padded, so the modem never plays silence in the middle of speech.
    pub fn next_frame(&mut self) -> Option<Vec<u8>> {
        if !self.ready || self.buffer.len() < HOST_FRAME {
            return None;
        }
        Some(self.buffer.drain(..HOST_FRAME).collect())
    }

    /// Bytes dropped since the last call, for logging.
    pub fn take_dropped(&mut self) -> usize {
        std::mem::take(&mut self.dropped)
    }

    pub fn buffered(&self) -> usize {
        self.buffer.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(len: usize, value: u8) -> Vec<u8> {
        vec![value; len]
    }

    #[test]
    fn waits_for_a_whole_frame() {
        let mut pacer = Pacer::default();
        pacer.push(&bytes(HOST_FRAME - 1, 1));
        assert_eq!(pacer.next_frame(), None);
        pacer.push(&bytes(1, 1));
        assert_eq!(pacer.next_frame().map(|f| f.len()), Some(HOST_FRAME));
        assert_eq!(pacer.next_frame(), None);
    }

    #[test]
    fn frames_come_out_in_order_from_small_packets() {
        let mut pacer = Pacer::default();
        // 20 ms adapter packets: 320 bytes each, five per host frame.
        for i in 0..10u8 {
            pacer.push(&bytes(320, i));
        }
        let first = pacer.next_frame().unwrap();
        let second = pacer.next_frame().unwrap();
        assert_eq!(&first[..320], &bytes(320, 0)[..]);
        assert_eq!(&first[1280..], &bytes(320, 4)[..]);
        assert_eq!(&second[..320], &bytes(320, 5)[..]);
        assert_eq!(pacer.next_frame(), None);
    }

    #[test]
    fn holds_audio_while_the_module_is_busy_and_resumes() {
        let mut pacer = Pacer::default();
        pacer.push(&bytes(HOST_FRAME, 7));
        pacer.set_ready(false);
        assert!(!pacer.is_ready());
        assert_eq!(pacer.next_frame(), None);
        assert_eq!(pacer.buffered(), HOST_FRAME);
        pacer.set_ready(true);
        assert_eq!(pacer.next_frame(), Some(bytes(HOST_FRAME, 7)));
    }

    #[test]
    fn drops_the_oldest_audio_beyond_the_cap() {
        let mut pacer = Pacer::default();
        pacer.set_ready(false);
        for i in 0..5u8 {
            pacer.push(&bytes(HOST_FRAME, i));
        }
        assert_eq!(pacer.buffered(), MAX_BUFFERED);
        assert_eq!(pacer.take_dropped(), 2 * HOST_FRAME);
        assert_eq!(pacer.take_dropped(), 0);
        pacer.set_ready(true);
        // Frames 0 and 1 are gone; playback continues from the newest 300 ms.
        assert_eq!(pacer.next_frame(), Some(bytes(HOST_FRAME, 2)));
        assert_eq!(pacer.next_frame(), Some(bytes(HOST_FRAME, 3)));
        assert_eq!(pacer.next_frame(), Some(bytes(HOST_FRAME, 4)));
        assert_eq!(pacer.next_frame(), None);
    }

    #[test]
    fn starts_ready_because_the_module_never_announces_it() {
        assert!(Pacer::default().is_ready());
    }
}
