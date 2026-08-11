// High-confidence verification-code detection shared by ingestion, filtering and
// historical reprocessing. A bare number is never enough: every accepted candidate
// must have an OTP label, a login/verification action, or an expiry/security signal.

const ZH_LABEL = '验证码|校验码|动态码|动态密码|驗證碼|校驗碼|動態碼|動態密碼';
const EN_CODE_LABEL =
  'otp|passcode|pin|(?:verification|security|authentication|login|access|confirmation|one[- ]time)\\s+(?:code|password)|code';

/**
 * Ordered from the most explicit forms to contextual forms. Each expression has
 * exactly one capture group: the code shown in the UI.
 */
export const VERIFICATION_CODE_PATTERNS = [
  {
    reason: 'zh_label_before',
    pattern: new RegExp(`(?:${ZH_LABEL})\\s*(?:是|为|為)?\\s*[:：]?\\s*(\\d{4,8})`),
  },
  {
    reason: 'zh_label_after',
    pattern: new RegExp(`(\\d{4,8})\\s*(?:是|为|為)\\s*(?:您|你|妳)?的?\\s*(?:${ZH_LABEL})`),
  },
  {
    reason: 'en_label_before',
    pattern: new RegExp(`\\b(?:${EN_CODE_LABEL})\\b[^\\d\\n]{0,20}?(\\d{4,8})\\b`, 'i'),
  },
  {
    reason: 'en_label_after',
    pattern: /\b(\d{4,8})\b\s+is\s+your(?:\s+[a-z][a-z0-9_-]*){0,3}\s+(?:verification\s+|security\s+|authentication\s+|login\s+)?(?:code|otp|pin|password|passcode)\b/i,
  },
  {
    reason: 'google_g_code',
    pattern: /\bG-(\d{4,8})\b/,
  },
  {
    reason: 'en_login_action',
    pattern: /\b(?:use|enter|input|type)\s+(?:this\s+)?(?:code\s+)?(\d{4,8})\b[^\n.]{0,32}?\b(?:to\s+)?(?:log\s*in|sign\s*in|verify|authenticate|confirm|complete)\b/i,
  },
  {
    reason: 'zh_login_action',
    pattern: /(?:输入|輸入|使用|填入|填写|填寫)\s*(\d{4,8})\s*(?:以|来|來|完成|进行|進行)?\s*(?:身份)?(?:登录|登入|登錄|验证|驗證|认证|認證|确认|確認)/,
  },
  {
    reason: 'en_expiry_or_security',
    pattern: /\b(\d{4,8})\b[^\n]{0,24}?(?:(?:is\s+)?(?:valid|expires?)\s+(?:for|in)\s+\d+\s*(?:minutes?|mins?)|do\s+not\s+share|never\s+share)\b/i,
  },
  {
    reason: 'zh_expiry_or_security',
    pattern: /(\d{4,8})[^\n。]{0,24}?(?:\d+\s*分钟内有效|\d+\s*分鐘內有效|有效期(?:为|為)?\s*\d+\s*分钟|有效期(?:为|為)?\s*\d+\s*分鐘|请勿(?:向他人)?泄露|請勿(?:向他人)?洩露|不要告知他人|切勿转发|切勿轉發)/,
  },
];

const NON_OTP_CODE_PREFIX =
  /(?:promo(?:tional)?|discount|voucher|coupon|offer|area|postal|zip|product)\s+code\s*[:=-]?\s*$/i;

function candidateOffset(match) {
  return match.index + match[0].indexOf(match[1]);
}

function isRejectedCandidate(content, match, reason) {
  const offset = candidateOffset(match);
  const before = content.slice(Math.max(0, offset - 32), offset);
  const after = content.slice(offset + match[1].length, offset + match[1].length + 16);

  // A date fragment cannot be an OTP without an explicit OTP label.
  if (!reason.includes('label') && /^\s*(?:年|[-/]\s*\d)/.test(after)) return true;

  // English "code" is overloaded. Do not turn promo/area/postal codes into OTPs.
  if (reason === 'en_label_before' && NON_OTP_CODE_PREFIX.test(before)) return true;

  return false;
}

/**
 * Return the code and the evidence that made it trustworthy, or null.
 *
 * @param {unknown} content
 * @returns {{code: string, reason: string}|null}
 */
export function detectVerificationCode(content) {
  if (typeof content !== 'string' || content === '') return null;

  for (const { reason, pattern } of VERIFICATION_CODE_PATTERNS) {
    const match = content.match(pattern);
    if (match && !isRejectedCandidate(content, match, reason)) {
      return { code: match[1], reason };
    }
  }

  return null;
}

/** Backwards-compatible string-only API used when persisting a message. */
export function extractVerificationCode(content) {
  return detectVerificationCode(content)?.code ?? null;
}

/** Single boolean definition used by the spam-filter safety guard. */
export function hasVerificationCode(content) {
  return detectVerificationCode(content) !== null;
}

// Kept for callers outside this repository; internally use hasVerificationCode().
export function hasLabelledCode(content) {
  return hasVerificationCode(content);
}
