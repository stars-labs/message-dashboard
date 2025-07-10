// Verification code extraction patterns
const verificationCodePatterns = [
  /验证码是[:：]\s*(\d{4,6})/,
  /验证码为[:：]\s*(\d{4,6})/,
  /验证码[:：]\s*(\d{4,6})/,
  /校验码[:：]?\s*(\d{4,6})/,
  /动态码[:：]?\s*(\d{4,6})/,
  /code\s*is\s*[:：]?\s*(\d{4,6})/i,
  /CODE[:：]\s*(\d{4,6})/i,
  /\b(\d{6})\b/,  // 6-digit code
  /\b(\d{4})\b/,  // 4-digit code
];

export function extractVerificationCode(content) {
  for (const pattern of verificationCodePatterns) {
    const match = content.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}