import { describe, expect, test } from 'bun:test';
import {
  SINGTEL_POSTPAID_BILL_PARSER_VERSION,
  parseSingtelPostpaidBillSms,
} from './singtel-postpaid-bill.js';

const ACCOUNT_REFERENCE = '12345678';

function billMessage({
  accountReference = ACCOUNT_REFERENCE,
  amount = '42.80',
  dueDate = '14 Jan 2026',
  currency = 'SGD',
} = {}) {
  return `<Singtel>Dear customer, your latest bill for Singtel a/c ${accountReference} is ready. The total amount is ${currency}$${amount} due on ${dueDate}. You can view and pay this bill via My Singtel app at www.singtel.com/viewbill .@`;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function parse(content, overrides = {}) {
  return parseSingtelPostpaidBillSms({
    sender: 'Singtel',
    content,
    expectedAccountRefDigest: await sha256(ACCOUNT_REFERENCE),
    ...overrides,
  });
}

describe('Singtel postpaid bill SMS parser', () => {
  test.each([
    ['14 Jan 2026', '2026-01-14'],
    ['09 Feb 2026', '2026-02-09'],
    ['31 Mar 2026', '2026-03-31'],
    ['30 Apr 2026', '2026-04-30'],
    ['01 May 2026', '2026-05-01'],
    ['30 Jun 2026', '2026-06-30'],
    ['31 Jul 2026', '2026-07-31'],
    ['31 Aug 2026', '2026-08-31'],
    ['30 Sep 2026', '2026-09-30'],
  ])('parses the confirmed %s month format', async (dueDate, expectedDate) => {
    const accountDigest = await sha256(ACCOUNT_REFERENCE);
    await expect(parse(billMessage({ dueDate }))).resolves.toEqual({
      parser_version: SINGTEL_POSTPAID_BILL_PARSER_VERSION,
      amount_minor: 4280,
      currency: 'SGD',
      due_date: expectedDate,
      account_ref_last4: '5678',
      account_ref_digest: accountDigest,
    });
  });

  test('parses a three-digit amount as integer cents', async () => {
    await expect(parse(billMessage({ amount: '142.08' }))).resolves.toMatchObject({
      amount_minor: 14208,
    });
  });

  test('discovers the account identity from an authentic bill without operator configuration', async () => {
    const accountDigest = await sha256(ACCOUNT_REFERENCE);

    await expect(parseSingtelPostpaidBillSms({
      sender: 'Singtel',
      content: billMessage(),
    })).resolves.toMatchObject({
      account_ref_digest: accountDigest,
      account_ref_last4: '5678',
      amount_minor: 4280,
    });
  });

  test.each([
    ['wrong sender', billMessage(), { sender: 'Singtel Biz' }],
    ['ambiguous amount', `${billMessage()} Total: SGD$1.00`, {}],
    ['malformed amount', billMessage({ amount: '42.8' }), {}],
    ['malformed date', billMessage({ dueDate: '31 Feb 2026' }), {}],
    ['unsupported currency', billMessage({ currency: 'USD' }), {}],
    ['rebate notice', 'We sincerely apologize for the recent network disruption. As a small gesture, you will receive a $10 goodwill rebate on your bill - no action needed.', {}],
    ['OTP', '<Singtel>Your OTP is 123456. Do not share it with anyone.', {}],
    ['generic bill text', 'Your bill is ready. Please pay it soon.', {}],
    ['historical fragment', '<Singtel>Dear customer, your latest bill for Singtel a/c 12345678 is ready. The total amount is SGD$42.80 due on 14 Mar 2026. You can view and pay this b', {}],
  ])('rejects %s', async (_name, content, overrides) => {
    await expect(parse(content, overrides)).resolves.toBeNull();
  });

  test('rejects a bill for a different configured account', async () => {
    await expect(parse(billMessage({ accountReference: '87654321' }))).resolves.toBeNull();
  });
});
