import { describe, expect, test } from 'bun:test';
import { extractM1WebBalance } from './m1-web-balance.js';

describe('M1 prepaid portal balance parser', () => {
  test('parses the authenticated account balance and validity date', () => {
    expect(extractM1WebBalance({
      accountText: '9095 0236',
      balanceText: '$9.97',
      validityText: 'Valid Till 20 Sep 2026',
    }, '+6590950236')).toEqual({
      balance: 9.97,
      currency: 'SGD',
      account_number: '+6590950236',
      expires_at: '2026-09-20',
      balance_path: '.balanceAmt.maBalanceDiv',
      expiry_path: '.balanceForBox .brand-color',
      account_path: '.numberTxt',
    });
  });

  test('rejects a portal session for a different M1 account', () => {
    expect(() => extractM1WebBalance({
      accountText: '9095 0237',
      balanceText: '$9.97',
      validityText: 'Valid Till 20 Sep 2026',
    }, '+6590950236')).toThrow('authenticated account');
  });

  test('requires an exact SGD balance and a real Singapore calendar date', () => {
    expect(() => extractM1WebBalance({
      accountText: '9095 0236',
      balanceText: '9.97 credits',
      validityText: 'Valid Till 20 Sep 2026',
    }, '+6590950236')).toThrow('SGD balance');
    expect(() => extractM1WebBalance({
      accountText: '9095 0236',
      balanceText: '$9.97',
      validityText: 'Valid Till 31 Feb 2026',
    }, '+6590950236')).toThrow('validity date');
  });
});
