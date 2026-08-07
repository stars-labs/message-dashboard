// Run with: bun test server/utils/recipient.test.js
//
// The recipient of an outbound SMS is stored, then handed to the Rust daemon, which
// interpolates it into an `AT+CMGS="..."` command. A CR in the value terminates that
// command and the modem executes whatever follows. The daemon validates too, but this
// is the trust boundary — rejecting here means a malformed value never reaches the
// database or the pending-send queue. See docs/SECURITY-REVIEW.md finding 3.
import { describe, expect, test } from 'bun:test';
import { normalizeRecipient } from './recipient.js';

describe('normalizeRecipient — valid E.164', () => {
  test('accepts a plain number and preserves it', () => {
    expect(normalizeRecipient('6512345678')).toEqual({ ok: true, value: '6512345678' });
  });

  test('accepts a leading +', () => {
    expect(normalizeRecipient('+6512345678')).toEqual({ ok: true, value: '+6512345678' });
  });

  test('accepts the length boundaries', () => {
    expect(normalizeRecipient('123456').ok).toBe(true); // 6 digits
    expect(normalizeRecipient('+123456789012345').ok).toBe(true); // 15 digits
  });

  test('trims surrounding whitespace', () => {
    expect(normalizeRecipient('  +6512345678 ')).toEqual({ ok: true, value: '+6512345678' });
  });
});

describe('normalizeRecipient — AT command injection', () => {
  // The literal payload from the security review.
  test('rejects CRLF followed by an AT command', () => {
    const result = normalizeRecipient('+6512345678\r\nAT+CMGD=1,4\r');
    expect(result.ok).toBe(false);
  });

  test('rejects a bare CR', () => {
    expect(normalizeRecipient('+6512345678\rAT+CMGD=1,4').ok).toBe(false);
  });

  test('rejects a bare LF', () => {
    expect(normalizeRecipient('+6512345678\n').ok).toBe(false);
  });

  test('rejects a double quote closing the CMGS argument', () => {
    expect(normalizeRecipient('+65123\"').ok).toBe(false);
  });

  test('rejects SMS-entry control characters', () => {
    expect(normalizeRecipient('+65123\x1A').ok).toBe(false); // Ctrl-Z terminates body
    expect(normalizeRecipient('+65123\x1B').ok).toBe(false); // ESC aborts entry
    expect(normalizeRecipient('+65123\0').ok).toBe(false);
  });

  // Whitespace is trimmed, so a payload must not be able to hide behind it.
  test('rejects an injection payload that would survive trimming', () => {
    expect(normalizeRecipient(' +6512345678\r\nAT+CMGD=1,4 ').ok).toBe(false);
  });
});

describe('normalizeRecipient — malformed input', () => {
  test('rejects empty and whitespace-only values', () => {
    expect(normalizeRecipient('').ok).toBe(false);
    expect(normalizeRecipient('   ').ok).toBe(false);
  });

  test('rejects a lone +', () => {
    expect(normalizeRecipient('+').ok).toBe(false);
  });

  test('rejects out-of-range lengths', () => {
    expect(normalizeRecipient('12345').ok).toBe(false); // 5 digits
    expect(normalizeRecipient('+1234567890123456').ok).toBe(false); // 16 digits
  });

  // Formatting humans type. Rejected rather than stripped: silently removing
  // separators risks dialling a different number than the caller intended.
  test('rejects separators and punctuation', () => {
    expect(normalizeRecipient('+65 1234 5678').ok).toBe(false);
    expect(normalizeRecipient('+65-1234-5678').ok).toBe(false);
    expect(normalizeRecipient('(65)12345678').ok).toBe(false);
  });

  test('rejects a + that is not leading', () => {
    expect(normalizeRecipient('65+12345678').ok).toBe(false);
  });

  test('rejects non-string input without throwing', () => {
    expect(normalizeRecipient(undefined).ok).toBe(false);
    expect(normalizeRecipient(null).ok).toBe(false);
    expect(normalizeRecipient(6512345678).ok).toBe(false);
    expect(normalizeRecipient({ toString: () => '+6512345678' }).ok).toBe(false);
    expect(normalizeRecipient(['+6512345678']).ok).toBe(false);
  });

  test('rejects non-ASCII digits that look numeric', () => {
    // Arabic-Indic and fullwidth digits: \d in some engines and Number() accept these.
    expect(normalizeRecipient('٦٥١٢٣٤٥٦٧٨').ok).toBe(false);
    expect(normalizeRecipient('＋６５１２３４５６７８').ok).toBe(false);
  });

  test('gives a reason on rejection', () => {
    expect(normalizeRecipient('+65 123').reason).toBeTruthy();
  });
});
