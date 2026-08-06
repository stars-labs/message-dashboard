// Run with: bun test server/utils/spam-filter.test.js
import { describe, expect, test } from 'bun:test';
import { classifyMessage, normalizeSender } from './spam-filter.js';

// Mirrors the seed rules in migrations/035_add_message_filter.sql.
// Ordered by id, which is the order classifyMessage evaluates them in.
const RULES = [
  { id: 1, rule_type: 'body_keyword', pattern: '外交部领保中心' },
  { id: 2, rule_type: 'body_keyword', pattern: '中国文化和旅游部温馨提示' },
  { id: 3, rule_type: 'body_keyword', pattern: '中国海关提示' },
  { id: 4, rule_type: 'sender', pattern: '10086' },
  { id: 5, rule_type: 'sender', pattern: '10010' },
  { id: 6, rule_type: 'sender', pattern: '101906' },
  { id: 7, rule_type: 'sender', pattern: '12306' },
];

// A received message with only the fields the classifier reads.
function received(fields) {
  return { type: 'received', content: '', phone_number: null, ...fields };
}

describe('normalizeSender', () => {
  test('strips the leading + and any punctuation', () => {
    expect(normalizeSender('+8610086')).toBe('8610086');
    expect(normalizeSender('10086')).toBe('10086');
    expect(normalizeSender(' 100-86 ')).toBe('10086');
  });

  test('returns empty string for absent senders', () => {
    expect(normalizeSender(null)).toBe('');
    expect(normalizeSender(undefined)).toBe('');
    expect(normalizeSender('')).toBe('');
  });
});

describe('classifyMessage — body keyword rules', () => {
  test('filters the 领保中心 broadcast', () => {
    const msg = received({
      content:
        '外交部领保中心祝您健康平安！近期本地区假冒公检法、银行、使馆和防疫部门工作人员的电信诈骗高发，请提高警惕。',
      phone_number: '10086',
    });
    expect(classifyMessage(msg, RULES)).toEqual({
      filter_status: 'filtered',
      filter_rule_id: 1,
    });
  });

  test('filters the 文旅部 broadcast', () => {
    const msg = received({
      content:
        "中国文化和旅游部温馨提示，文明旅游'三讲三不'：讲安全、讲礼让、讲卫生；不大声喧哗、不乱写乱画、不违法违规。",
    });
    expect(classifyMessage(msg, RULES)).toEqual({
      filter_status: 'filtered',
      filter_rule_id: 2,
    });
  });

  test('filters the 海关 broadcast despite the full-width comma after the pattern', () => {
    const msg = received({
      content: '中国海关提示，请勿携带下列物品进入中国境内',
    });
    expect(classifyMessage(msg, RULES)).toEqual({
      filter_status: 'filtered',
      filter_rule_id: 3,
    });
  });

  test('first matching rule wins when a message contains two patterns', () => {
    // The real 领保中心 SMS also embeds the 文旅部 text further down.
    const msg = received({
      content:
        '外交部领保中心祝您健康平安！……中国文化和旅游部温馨提示，文明旅游"三讲三不"。',
    });
    // Rule 1 comes before rule 2, so provenance must point at rule 1.
    expect(classifyMessage(msg, RULES).filter_rule_id).toBe(1);
  });
});

describe('classifyMessage — sender rules', () => {
  test('filters an exact shortcode match', () => {
    const msg = received({ content: '【联通助理】国际漫游提醒', phone_number: '101906' });
    expect(classifyMessage(msg, RULES)).toEqual({
      filter_status: 'filtered',
      filter_rule_id: 6,
    });
  });

  test('filters a shortcode carrying a 86 country prefix', () => {
    const msg = received({ content: '任意内容', phone_number: '+8610086' });
    expect(classifyMessage(msg, RULES)).toEqual({
      filter_status: 'filtered',
      filter_rule_id: 4,
    });
  });

  // Regression guard: an endsWith() implementation would wrongly filter this.
  test('does NOT filter a real mobile number that merely ends with a shortcode', () => {
    const msg = received({
      content: '您的验证码是 384912，请勿泄露。',
      phone_number: '13910086',
    });
    expect(classifyMessage(msg, RULES)).toEqual({
      filter_status: 'clean',
      filter_rule_id: null,
    });
  });

  test('does NOT filter a longer number that merely contains a shortcode', () => {
    const msg = received({ content: '任意内容', phone_number: '8613100862222' });
    expect(classifyMessage(msg, RULES).filter_status).toBe('clean');
  });
});

describe('classifyMessage — messages that must never be filtered', () => {
  test('keeps a genuine verification code SMS', () => {
    const msg = received({
      content: '【抖音】您的验证码是38291，请在15分钟内使用，请勿泄露。',
      phone_number: '1069',
    });
    expect(classifyMessage(msg, RULES)).toEqual({
      filter_status: 'clean',
      filter_rule_id: null,
    });
  });

  test('keeps an English verification code SMS', () => {
    const msg = received({
      content: 'Your Google verification code is 123456',
      phone_number: '+6580286158',
    });
    expect(classifyMessage(msg, RULES).filter_status).toBe('clean');
  });

  test('never filters our own outbound SMS, even if the body matches a rule', () => {
    const msg = {
      type: 'sent',
      content: '中国海关提示，请勿携带下列物品进入中国境内',
      phone_number: '10086',
    };
    expect(classifyMessage(msg, RULES)).toEqual({
      filter_status: 'clean',
      filter_rule_id: null,
    });
  });

  test('keeps everything when there are no rules', () => {
    const msg = received({ content: '中国海关提示，请勿携带下列物品', phone_number: '10086' });
    expect(classifyMessage(msg, [])).toEqual({
      filter_status: 'clean',
      filter_rule_id: null,
    });
  });
});

// 10010 is 2,864 of the 8,624 messages in the real table, but 14 of those are
// genuine 联通网上营业厅 login codes. Blanket-blocking the shortcode would hide them,
// so a labelled code overrides every rule.
describe('classifyMessage — OTP safety guard', () => {
  test('keeps a real 10010 verification code even though 10010 is blocked', () => {
    const msg = received({
      content: '验证码：754852，感谢您使用网上营业厅【中国联通】',
      phone_number: '10010',
    });
    expect(classifyMessage(msg, RULES)).toEqual({
      filter_status: 'clean',
      filter_rule_id: null,
    });
  });

  test('still filters 10010 marketing that carries no labelled code', () => {
    const msg = received({
      content:
        '【中国联通】尊敬的用户，您在中国联通订购的"广东在网得24个月沃视频月卡优惠"(方案编号: 25GD300965)，将于2026-08-31到期。',
      phone_number: '10010',
    });
    expect(classifyMessage(msg, RULES)).toEqual({
      filter_status: 'filtered',
      filter_rule_id: 5,
    });
  });

  test('the guard beats body-keyword rules too, not just sender rules', () => {
    const msg = received({
      content: '中国海关提示，请勿携带下列物品。您的验证码是 445566',
      phone_number: '10086',
    });
    expect(classifyMessage(msg, RULES).filter_status).toBe('clean');
  });

  test('protects English OTPs, which the Singapore SIMs receive', () => {
    const msg = received({
      content: 'Your Google verification code is 123456',
      phone_number: '10010',
    });
    expect(classifyMessage(msg, RULES).filter_status).toBe('clean');
  });

  test('a bare year is not a labelled code, so it does not rescue marketing', () => {
    const msg = received({ content: '优惠将于2026-08-31到期', phone_number: '10086' });
    expect(classifyMessage(msg, RULES).filter_status).toBe('filtered');
  });
});

describe('classifyMessage — malformed input', () => {
  test('tolerates a missing body', () => {
    expect(classifyMessage(received({ content: null }), RULES).filter_status).toBe('clean');
    expect(classifyMessage(received({}), RULES).filter_status).toBe('clean');
  });

  test('tolerates a non-string body', () => {
    expect(classifyMessage(received({ content: 12345 }), RULES).filter_status).toBe('clean');
  });

  test('ignores a rule with an unknown rule_type instead of throwing', () => {
    const msg = received({ content: '中国海关提示，请勿携带' });
    const rules = [{ id: 99, rule_type: 'regex', pattern: '.*' }, RULES[2]];
    expect(classifyMessage(msg, rules).filter_rule_id).toBe(3);
  });
});
