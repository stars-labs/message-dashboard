// Validation for outbound SMS recipients.
//
// A recipient submitted to POST /api/messages/send is stored, then picked up by the
// Rust daemon, which interpolates it into an `AT+CMGS="<recipient>"` command written
// straight to a modem's serial port. AT commands are CR-terminated, so a CR in this
// value ends the command and the modem parses the rest as a new one — letting a caller
// run arbitrary AT commands (send from any SIM, wipe stored messages).
// See docs/SECURITY-REVIEW.md finding 3.
//
// The daemon validates independently; this is the trust boundary, so a bad value never
// reaches the database or the pending-send queue in the first place.

// Optional leading '+', then 6-15 ASCII digits. Anchored, and \d is deliberately
// avoided in favour of [0-9] so non-ASCII digit forms cannot slip through.
const E164 = /^\+?[0-9]{6,15}$/;

/**
 * Validate a recipient as E.164.
 *
 * @param {unknown} recipient
 * @returns {{ok: true, value: string} | {ok: false, reason: string}}
 *
 * Rejects rather than sanitises. Stripping separators or control characters would risk
 * sending the message to a different number than the caller asked for, and silently
 * "fixing" a payload hides the attempt; a 400 is both safer and diagnosable.
 */
export function normalizeRecipient(recipient) {
  if (typeof recipient !== 'string') {
    return { ok: false, reason: 'recipient must be a string' };
  }

  // Only spaces and tabs are trimmed — deliberately NOT String.trim(), which also
  // strips CR/LF. A trailing "\r\n" would then normalise to a valid number and return
  // 200, silently discarding evidence of an injection attempt; a control character
  // anywhere in a phone number is anomalous and should fail loudly.
  const value = recipient.replace(/^[ \t]+|[ \t]+$/g, '');

  if (!value) {
    return { ok: false, reason: 'recipient must not be empty' };
  }

  if (!E164.test(value)) {
    return {
      ok: false,
      reason: 'recipient must be E.164: an optional leading "+" followed by 6-15 digits',
    };
  }

  return { ok: true, value };
}
