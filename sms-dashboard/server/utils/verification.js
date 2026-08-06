// Verification code detection.
//
// Two tiers, deliberately kept apart:
//
//   LABELLED_CODE_PATTERNS — the code is explicitly announced ("验证码：123456",
//     "Your OTP is 4821"). High precision. Safe to act on, so the spam filter
//     uses these as a guard: a message carrying a labelled code is never hidden.
//
//   BARE_DIGIT_PATTERNS — any 4/6-digit run, with no label at all. Low precision:
//     "将于2026-08-31到期" yields "2026". DISPLAY ONLY. Never use these to decide
//     whether a message matters, or marketing SMS will look like verification codes.

const ZH_LABEL = '验证码|校验码|动态码|动态密码|驗證碼|校驗碼|動態碼|動態密碼';
const EN_LABEL = 'otp|code|passcode|password|pin';

export const LABELLED_CODE_PATTERNS = [
  // 中文，标签在前：验证码：123456 / 验证码是38291 / 动态码 4821 / 验证码为 951753
  new RegExp(`(?:${ZH_LABEL})\\s*(?:是|为|為)?\\s*[:：]?\\s*(\\d{4,8})`),

  // 中文，数字在前：123456 是您的验证码
  new RegExp(`(\\d{4,8})\\s*(?:是|为|為)\\s*(?:您|你|妳)?的?\\s*(?:${ZH_LABEL})`),

  // English, label first: "code is 123456", "OTP: 1234", "passcode 246810",
  // "PIN is 1234", "one-time password is 778899"
  new RegExp(`\\b(?:${EN_LABEL})\\b[^\\d\\n]{0,20}?(\\d{4,8})\\b`, 'i'),

  // English, digits first: "998877 is your Facebook code",
  // "G-123456 is your Google verification code"
  /\b(\d{4,8})\b\s+is\s+your\b/i,

  // Google's G-nnnnnn form, which can appear without the "is your" tail.
  /\bG-(\d{4,8})\b/,
];

const BARE_DIGIT_PATTERNS = [
  /\b(\d{6})\b/,
  /\b(\d{4})\b/,
];

/**
 * Does this message explicitly announce a verification code?
 *
 * Used as the spam filter's safety guard. A false negative here hides a real
 * code, so this errs toward saying yes; a false positive merely shows one extra
 * message, which is the harmless direction.
 *
 * @param {unknown} content
 * @returns {boolean}
 */
export function hasLabelledCode(content) {
  if (typeof content !== 'string' || content === '') return false;
  return LABELLED_CODE_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * Best-effort extraction of a code for the UI badge. Tries the labelled patterns
 * first, then falls back to any bare digit run.
 *
 * @param {unknown} content
 * @returns {string|null}
 */
export function extractVerificationCode(content) {
  if (typeof content !== 'string') {
    return null;
  }

  for (const pattern of [...LABELLED_CODE_PATTERNS, ...BARE_DIGIT_PATTERNS]) {
    const match = content.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}
