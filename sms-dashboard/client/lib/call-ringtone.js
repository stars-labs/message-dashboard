// Incoming-call ringtone. A dispatcher watching another tab needs to hear a
// call arrive, and the dashboard ships no audio assets, so the tone is
// synthesised: two short beeps a second apart, repeating while the call rings.
//
// The AudioContext is injected so this can be tested without WebAudio, and every
// call is guarded: autoplay policy blocks audio until the page has been
// interacted with, and a blocked ringtone must never break call handling.

const BEEP_HZ = 880;
const BEEP_MS = 220;
const PATTERN_MS = 2400;

export function createRingtone(AudioContextCtor) {
  let context = null;
  let timer = null;

  function beep(at) {
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = BEEP_HZ;
      // Ramped rather than switched, so the beep does not click.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + BEEP_MS / 1000);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + BEEP_MS / 1000 + 0.02);
    } catch {
      // A failed beep is not worth interrupting a ringing call for.
    }
  }

  function ring() {
    if (!context) return;
    beep(context.currentTime);
    beep(context.currentTime + 0.35);
  }

  return {
    start() {
      if (timer || !AudioContextCtor) return false;
      try {
        context = context ?? new AudioContextCtor();
        context.resume?.();
      } catch {
        context = null;
        return false;
      }
      ring();
      timer = setInterval(ring, PATTERN_MS);
      return true;
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      try {
        context?.close?.();
      } catch {
        // Closing twice, or after the page froze, is not an error worth raising.
      }
      context = null;
    },
    get ringing() {
      return timer !== null;
    },
  };
}
