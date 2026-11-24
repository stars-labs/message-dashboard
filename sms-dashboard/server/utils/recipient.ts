// The daemon interpolates the recipient into `AT+CMGS="<recipient>"` on the modem's
// serial port. A CR ends the AT command, so an unvalidated value could inject
// arbitrary AT commands. The daemon validates too; this keeps bad values out of D1.

type RecipientCheck = { ok: true; value: string } | { ok: false; reason: string };

const E164 = /^\+?[0-9]{6,15}$/;
const SHORT_CODE = /^[0-9]{3,5}$/;

/** E.164 or carrier short code. Rejects rather than sanitises, so no message goes to a different number than asked. */
export function normalizeRecipient(recipient: unknown): RecipientCheck {
  if (typeof recipient !== 'string') {
    return { ok: false, reason: 'recipient must be a string' };
  }

  // Not String.trim(): it strips CR/LF, which would let a trailing "\r\n" pass as valid.
  const value = recipient.replace(/^[ \t]+|[ \t]+$/g, '');

  if (!value) {
    return { ok: false, reason: 'recipient must not be empty' };
  }

  if (!E164.test(value) && !SHORT_CODE.test(value)) {
    return {
      ok: false,
      reason:
        'recipient must be a 3-5 digit short code or E.164: an optional leading "+" followed by 6-15 digits',
    };
  }

  return { ok: true, value };
}
