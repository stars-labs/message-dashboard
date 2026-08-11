// Run with: bun test server/utils/verification.test.js
import { describe, expect, test } from 'bun:test';
import {
  detectVerificationCode,
  extractVerificationCode,
  hasLabelledCode,
  hasVerificationCode,
} from './verification.js';

// hasLabelledCode() is the OTP safety guard used by the spam filter: a message
// that carries an explicitly LABELLED code is never filtered, whatever rule it
// matched. It must be high precision in the "is a code" direction — a false
// negative here means a real verification code gets hidden.
describe('hasLabelledCode — Chinese labels', () => {
  test.each([
    ['验证码：754852，感谢您使用网上营业厅【中国联通】'],
    ['验证码:123456'],
    ['【抖音】您的验证码是38291，请在15分钟内使用'],
    ['您的验证码为 951753，请勿泄露'],
    ['校验码：8842'],
    ['动态码 4821'],
    ['动态密码：620914'],
    ['短信验证码：112233，2分钟内有效'],
    ['您的驗證碼是 445566'],   // traditional — Singapore SIMs see this
    ['123456 是您的验证码'],    // reversed order
  ])('detects %j', (content) => {
    expect(hasLabelledCode(content)).toBe(true);
  });
});

describe('hasLabelledCode — English labels', () => {
  test.each([
    ['Your Google verification code is 123456'],
    ['Your verification code is: 998877'],
    ['OTP: 123456'],
    ['Your OTP is 4821 . Do not share it.'],
    ['code: 5678'],
    ['Use passcode 246810 to sign in'],
    ['Your PIN is 1234'],
    ['Your one-time password is 778899'],
    ['Your one time passcode: 334455'],
    ['G-123456 is your Google verification code'],
    ['998877 is your Facebook code'],
    ['Telegram code: 54321'],
    ['Your security code is 111222'],
    ['Your authentication code is 456789'],
  ])('detects %j', (content) => {
    expect(hasLabelledCode(content)).toBe(true);
  });
});

describe('hasVerificationCode — contextual OTPs without an explicit label', () => {
  test.each([
    ['Use 4471 to log in. Expires in 10 min.'],
    ['Enter 839204 to verify your account'],
    ['输入 38291 完成登录'],
    ['使用 951753 进行身份验证'],
    ['4821 is valid for 5 minutes'],
    ['620914. Do not share it with anyone'],
    ['445566，请勿泄露给他人'],
    ['【微博】672868。仅用于解除账号异常，5分钟内有效。'],
    ['【微博】920629。仅用于解除账号异常，5分钟内有效。'],
  ])('detects %j', (content) => {
    expect(hasVerificationCode(content)).toBe(true);
  });
});

describe('hasLabelledCode — must NOT fire on marketing text', () => {
  test.each([
    // Mentions the word but carries no code. These are the 4 anti-fraud
    // broadcasts found in the real message table.
    ['【广州市反诈中心联合广州联通】提醒您:接到机票退改签的电话或短信，请务必通过官方渠道进行核实，切勿泄露银行卡号、支付密码、验证码等个人信息。'],
    ['公益短信：【郴州公安提醒】如遇客服来电，要求办理退款、理赔等，一定要通过官方途径核查！不得在网站上填写银行卡号、密码、验证码等信息'],
    ['短信验证码的请求，做好信息安全防范！联通好服务，用心为客户【上海联通】'],
    // Real marketing bodies with plenty of digits but no labelled code.
    ['【中国联通】尊敬的用户，您在中国联通订购的"广东在网得24个月沃视频月卡优惠"(方案编号: 25GD300965)，将于2026-08-31到期。'],
    ['外交部领保中心祝您健康平安！当地报警电话：999。外交部全球领事保护与服务应急热线+86-10-12308/65612308。'],
    ['中国海关提示，请勿携带下列物品进入中国境内'],
    ['【12306】刘洋购票成功，8月5日G6588次，福田站19:59开。'],
  ])('ignores %j', (content) => {
    expect(hasLabelledCode(content)).toBe(false);
  });

  test('ignores non-string input', () => {
    expect(hasLabelledCode(null)).toBe(false);
    expect(hasLabelledCode(undefined)).toBe(false);
    expect(hasLabelledCode(12345)).toBe(false);
    expect(hasLabelledCode('')).toBe(false);
  });
});

describe('extractVerificationCode', () => {
  test('prefers the labelled code over any other digits in the body', () => {
    expect(extractVerificationCode('订单2026年，验证码：8842')).toBe('8842');
  });

  test('returns null for a bare order number', () => {
    expect(extractVerificationCode('您的订单号 123456 已受理')).toBeNull();
  });

  test('returns null when there are no digits at all', () => {
    expect(extractVerificationCode('中国海关提示，请勿携带下列物品')).toBeNull();
  });

  test('returns null for non-string input', () => {
    expect(extractVerificationCode(null)).toBeNull();
  });

  test.each([
    ['【招商银行】您尾号9016的普卡将于2026年11月30日到期'],
    ['M1 Prepaid is now on 5G! Upgrade on 9 August 2026.'],
    ['将于2026-08-31到期'],
    ['订单 123456 已受理'],
    ['Call area code 2026 for assistance'],
    ['Use promo code 2026 for a discount'],
    ['Use code 2026 to complete your purchase'],
    ['Your card ending 9016 expires in 5 minutes'],
    ['Order 123456: do not share your delivery details'],
    ['优惠码 2026。仅用于本次促销，活动5分钟内有效'],
  ])('does not treat non-OTP numbers as codes: %j', (content) => {
    expect(extractVerificationCode(content)).toBeNull();
  });

  test('returns structured evidence for auditing', () => {
    expect(detectVerificationCode('Your OTP is 4821')).toEqual({
      code: '4821',
      reason: 'en_label_before',
    });
  });
});
