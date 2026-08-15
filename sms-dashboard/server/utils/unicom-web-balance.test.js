import { describe, expect, test } from 'bun:test';
import { extractUnicomWebBalance } from './unicom-web-balance.js';

describe('China Unicom web balance response parser', () => {
  test('extracts one explicit balance for the expected account', () => {
    expect(extractUnicomWebBalance({
      data: { mobileNumber: '17600419127', availableBalance: '86.36元' },
    }, '+8617600419127')).toEqual({
      balance: 86.36,
      currency: 'CNY',
      account_number: '+8617600419127',
      balance_path: 'data.availableBalance',
      account_path: 'data.mobileNumber',
    });
  });

  test('extracts the official remaining-fee row for a masked authenticated account', () => {
    expect(extractUnicomWebBalance({
      userInfo: { usernumber: '132****3993' },
      resource: {
        dataList: [
          { remainTitle: '剩余话费', number: '281.40', unit: '元' },
          { remainTitle: '已用流量', number: '0.00', unit: 'MB' },
          { remainTitle: '可用积分', number: '4397', unit: '' },
        ],
      },
    }, '+8613265143993')).toEqual({
      balance: 281.4,
      currency: 'CNY',
      account_number: '+8613265143993',
      balance_path: 'resource.dataList.0.number',
      account_path: 'userInfo.usernumber',
    });
  });

  test('rejects a masked account whose prefix or suffix differs', () => {
    expect(() => extractUnicomWebBalance({
      userInfo: { usernumber: '132****0000' },
      resource: { dataList: [{ remainTitle: '剩余话费', number: '281.40', unit: '元' }] },
    }, '+8613265143993')).toThrow('does not prove');
  });

  test('rejects a response for another logged-in account', () => {
    expect(() => extractUnicomWebBalance({
      data: { mobile: '18600000000', balance: '10.00' },
    }, '+8617600419127')).toThrow('does not prove');
  });

  test('rejects ambiguous monetary fields instead of guessing', () => {
    expect(() => extractUnicomWebBalance({
      data: { mobile: '17600419127', balance: 10, availableBalance: 8 },
    }, '+8617600419127')).toThrow('multiple candidate');
  });

  test('does not treat charges or arbitrary numbers as balance', () => {
    expect(() => extractUnicomWebBalance({
      data: { mobile: '17600419127', currentCharges: 20, points: 1000 },
    }, '+8617600419127')).toThrow('recognized available-balance');
  });
});
