// High-confidence verification-code detection shared by ingestion, filtering and
// historical reprocessing. A bare number is never enough: every accepted candidate
// must have an OTP label, a login/verification action, or an expiry/security signal.

const ZH_LABEL = '验证码|校验码|动态码|动态密码|驗證碼|校驗碼|動態碼|動態密碼';
const EN_CODE_LABEL =
  'otp|passcode|pin|(?:verification|security|authentication|login|access|confirmation|one[- ]time)\\s+(?:code|password)';
const JA_LABEL = '認証コード|確認コード|ワンタイムパスワード|ワンタイムコード|セキュリティコード';

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
    reason: 'ja_label_before',
    pattern: new RegExp(`(?:${JA_LABEL})\\s*(?:は|が)?\\s*[:：]?\\s*(\\d{4,8})`),
  },
  {
    reason: 'ja_label_after',
    pattern: new RegExp(`(\\d{4,8})\\s*(?:は|が)?\\s*(?:あなたの|お客様の)?[^\\n。]{0,24}?(?:${JA_LABEL})`),
  },
  {
    reason: 'en_label_before',
    pattern: new RegExp(`\\b(?:${EN_CODE_LABEL})\\b[^\\d\\n]{0,20}?(\\d{4,8})\\b`, 'i'),
  },
  {
    reason: 'en_otp_login_before',
    pattern: /\botp\s+for\s+login\b[^\d\n]{0,64}?(\d{4,8})\b/i,
  },
  {
    reason: 'en_generic_code_before',
    pattern: /\bcode\b[^\d\n]{0,20}?(\d{3}-\d{3})\b/i,
  },
  {
    reason: 'en_generic_code_before',
    pattern: /\bcode\b[^\d\n]{0,20}?(\d{4,8})\b/i,
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
    reason: 'en_expiry',
    pattern: /\b(\d{4,8})\b[^\n.]{0,16}?(?:is\s+)?valid\s+(?:for|in)\s+\d+\s*(?:minutes?|mins?)\b/i,
  },
  {
    reason: 'en_security',
    pattern: /\b(\d{4,8})\b[^\n.]{0,8}?[.!,:;]?\s*(?:do\s+not|never)\s+share\s+(?:it|this|the\s+(?:code|otp|pin|passcode)|with\b)/i,
  },
  {
    reason: 'zh_purpose_expiry',
    pattern:
      /(\d{4,8})[。．.!！]?\s*(?:仅|僅|只)?用于[^\n。]{1,24}[，,]\s*\d+\s*分(?:钟|鐘)内有效/,
  },
  {
    reason: 'zh_expiry_or_security',
    pattern: /(\d{4,8})[^\n。]{0,24}?(?:\d+\s*分钟内有效|\d+\s*分鐘內有效|有效期(?:为|為)?\s*\d+\s*分钟|有效期(?:为|為)?\s*\d+\s*分鐘|请勿(?:向他人)?泄露|請勿(?:向他人)?洩露|不要告知他人|切勿转发|切勿轉發)/,
  },
  {
    reason: 'ja_generic_code_before',
    pattern: /コード\s*(?:番号)?\s*[:：]?\s*(\d{4,8})/,
  },
  {
    reason: 'ja_login_action',
    pattern: /(\d{4,8})\s*を\s*(?:入力|使用)(?:し(?:てください)?)?[^\n。]{0,24}?(?:ログイン|サインイン|認証|確認)/,
  },
  {
    reason: 'ja_expiry',
    pattern: /(\d{4,8})[^\n。]{0,16}?(?:有効期限\s*(?:は|が)?\s*\d+\s*分|\d+\s*分(?:間|以内)?\s*有効)/,
  },
  {
    reason: 'ja_security',
    pattern: /(\d{4,8})[^\n。]{0,24}?(?:誰とも|誰にも|他人|第三者)[^\n。]{0,8}?(?:共有|教え|伝え)(?:しないで|しない|ず|ないでください)/,
  },
];

const NON_OTP_CODE_PREFIX =
  /(?:promo(?:tional)?|discount|voucher|coupon|offer|area|postal|zip|product)\s+code\s*[:=-]?\s*$/i;
const NON_OTP_CODE_ACTION =
  /^\s*(?:to\s+)?(?:complete|place|track|confirm)\s+(?:your\s+)?(?:purchase|order|delivery|booking)\b/i;
const JA_NON_OTP_CODE_PREFIX =
  /(?:商品|製品|クーポン|プロモーション?|キャンペーン|バウチャー|割引|招待|紹介|注文|予約|会員|ポイント)\s*コード\s*(?:番号)?\s*[:：]?\s*$/;

function candidateOffset(match) {
  return match.index + match[0].indexOf(match[1]);
}

function isRejectedCandidate(content, match, reason) {
  const offset = candidateOffset(match);
  const before = content.slice(Math.max(0, offset - 32), offset);
  const after = content.slice(offset + match[1].length, offset + match[1].length + 48);

  // A date fragment cannot be an OTP without an explicit OTP label.
  if (!reason.includes('label') && /^\s*(?:年|[-/]\s*\d)/.test(after)) return true;

  // English "code" is overloaded. Do not turn promo/area/postal codes into OTPs.
  if (reason === 'en_generic_code_before') {
    if (NON_OTP_CODE_PREFIX.test(before)) return true;
    if (NON_OTP_CODE_ACTION.test(after)) return true;
  }
  if (reason === 'en_login_action' && NON_OTP_CODE_ACTION.test(after)) return true;

  // Japanese コード is equally overloaded (product/coupon/order codes).
  if (reason === 'ja_generic_code_before' && JA_NON_OTP_CODE_PREFIX.test(before)) return true;

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
