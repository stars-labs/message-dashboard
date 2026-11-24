import { describe, expect, test } from 'bun:test';
import type {
  BalanceCheck,
  BalanceCheckDetail,
  BalanceConversationMessage,
  BalanceMetric,
} from '../../shared/api/balance-checks.js';
import {
  formatBalanceMetric,
  getBalanceConversation,
  getBalanceMetricLabel,
  getBalanceStatusMeta,
  getBalanceTimestamp,
  getCashBalance,
  getLatestBalanceReply,
  normalizeUtcTimestamp,
} from './balance-query.js';

function metric(overrides: Partial<BalanceMetric> = {}): BalanceMetric {
  return {
    metric_type: 'cash_balance',
    value: null,
    unit: null,
    currency: null,
    expires_at: null,
    ...overrides,
  };
}

function check(overrides: Partial<BalanceCheck> = {}): BalanceCheck {
  return {
    id: 'check-1',
    sim_iccid: 'iccid-1',
    profile_id: 'profile-1',
    requested_at: '2026-08-14 04:00:00',
    sent_at: null,
    completed_at: null,
    status: 'parsed',
    step_index: 0,
    response_sender: null,
    raw_response: null,
    error: null,
    parser_version: '1',
    country_code: 'CN',
    profile_carrier: 'carrier',
    method: 'sms',
    command: '',
    destination: null,
    conversation_steps: '[]',
    sim_index: null,
    sim_number: null,
    sim_carrier: null,
    sim_country: null,
    outbound_content: null,
    outbound_recipient: null,
    outbound_timestamp: null,
    outbound_status: null,
    response_content: null,
    response_phone_number: null,
    response_timestamp: null,
    skill_job_status: null,
    web_job_status: null,
    web_human_reason: null,
    display_status: 'parsed',
    profile_outputs: [],
    metrics: [],
    ...overrides,
  };
}

function message(overrides: Partial<BalanceConversationMessage> = {}): BalanceConversationMessage {
  return {
    id: 'message-1',
    type: 'sent',
    content: 'hello',
    timestamp: null,
    status: null,
    phone_number: null,
    recipient: null,
    ...overrides,
  };
}

function detail(conversation: BalanceConversationMessage[]): BalanceCheckDetail {
  return { id: 'check-1', conversation, web_events: [] };
}

describe('balance query presentation', () => {
  test('uses the latest conversation timestamp', () => {
    expect(
      getBalanceTimestamp(
        check({
          requested_at: '2026-08-14 04:00:00',
          response_timestamp: '2026-08-14T04:01:00.000Z',
        }),
      ),
    ).toBe('2026-08-14T04:01:00.000Z');
  });

  test('formats parsed cash balances', () => {
    const balance = check({ metrics: [metric({ value: 82.36, currency: 'CNY' })] });
    expect(getCashBalance(balance)?.value).toBe(82.36);
    expect(formatBalanceMetric(getCashBalance(balance))).toContain('82.36');
  });

  test('uses readable labels for known metrics and preserves unknown ones', () => {
    expect(getBalanceMetricLabel('cash_balance')).toBe('账户余额');
    expect(getBalanceMetricLabel('data_remaining')).toBe('剩余流量');
    expect(getBalanceMetricLabel('carrier_bonus')).toBe('carrier_bonus');
  });

  test('labels audit states and normalizes D1 timestamps', () => {
    expect(getBalanceStatusMeta('response_received').label).toBe('已收到回复');
    expect(getBalanceStatusMeta('skill_pending').label).toBe('等待 AI');
    expect(getBalanceStatusMeta('skill_processing').label).toBe('AI 判断中');
    expect(normalizeUtcTimestamp('2026-08-14 04:01:00')).toBe('2026-08-14 04:01:00Z');
    expect(normalizeUtcTimestamp('2026-08-14T04:01:00Z')).toBe('2026-08-14T04:01:00Z');
  });

  test('returns the detail messages when the detail has a conversation', () => {
    const messages = [message({ id: 'a' }), message({ id: 'b', type: 'received' })];
    const balance = check({ outbound_content: 'ignored', response_content: 'ignored' });
    expect(getBalanceConversation(balance, detail(messages))).toEqual(messages);
  });

  test('builds the outbound and reply messages from the check without a detail', () => {
    const balance = check({
      outbound_content: 'CXYE',
      outbound_recipient: '10010',
      outbound_timestamp: '2026-08-14T04:00:30.000Z',
      outbound_status: 'sent',
      response_content: 'balance 82.36',
      response_phone_number: '10010',
      response_timestamp: '2026-08-14T04:01:00.000Z',
    });
    expect(getBalanceConversation(balance, null)).toEqual([
      {
        id: 'check-1-outbound',
        type: 'sent',
        content: 'CXYE',
        recipient: '10010',
        phone_number: null,
        timestamp: '2026-08-14T04:00:30.000Z',
        status: 'sent',
      },
      {
        id: 'check-1-response',
        type: 'received',
        content: 'balance 82.36',
        recipient: null,
        phone_number: '10010',
        timestamp: '2026-08-14T04:01:00.000Z',
        status: null,
      },
    ]);
  });

  test('falls back to the command and the raw response for message content', () => {
    for (const outbound_content of [null, '']) {
      const balance = check({
        outbound_content,
        command: 'CXYE',
        response_content: outbound_content,
        raw_response: 'raw reply',
      });
      const messages = getBalanceConversation(balance, null);
      expect(messages.map((item) => item.content)).toEqual(['CXYE', 'raw reply']);
      expect(messages.map((item) => item.id)).toEqual(['check-1-outbound', 'check-1-response']);
    }
  });

  test('returns no messages without outbound content, command or reply', () => {
    expect(getBalanceConversation(check(), null)).toEqual([]);
    expect(getBalanceConversation(check(), detail([]))).toEqual([]);
  });

  test('prefers the last detail message timestamp', () => {
    const balance = check({ response_timestamp: '2026-08-14T04:01:00.000Z' });
    const loaded = detail([
      message({ timestamp: '2026-08-14T04:00:00.000Z' }),
      message({ id: 'b', type: 'received', timestamp: '2026-08-14T04:05:00.000Z' }),
    ]);
    expect(getBalanceTimestamp(balance, loaded)).toBe('2026-08-14T04:05:00.000Z');
  });

  test('returns the newest received message, or null when there is none', () => {
    const loaded = detail([
      message({ id: 'a', type: 'received' }),
      message({ id: 'b', type: 'received' }),
      message({ id: 'c', type: 'sent' }),
    ]);
    expect(getLatestBalanceReply(check(), loaded)?.id).toBe('b');
    expect(getLatestBalanceReply(check({ command: 'CXYE' }), null)).toBeNull();
  });

  test('returns empty timestamps unchanged', () => {
    expect(normalizeUtcTimestamp(null)).toBeNull();
    expect(normalizeUtcTimestamp(undefined)).toBeUndefined();
    expect(normalizeUtcTimestamp('')).toBe('');
  });

  test('shows a placeholder for missing metrics and values', () => {
    expect(formatBalanceMetric(null)).toBe('暂未取得');
    expect(formatBalanceMetric(metric({ value: null, currency: 'CNY' }))).toBe('暂未取得');
  });

  test('renders a unit when there is no currency', () => {
    expect(
      formatBalanceMetric(metric({ metric_type: 'data_remaining', value: 5, unit: 'GB' })),
    ).toBe('5 GB');
  });
});
