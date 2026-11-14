import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import BalanceConversationRow from './BalanceConversationRow.svelte';
import BalanceQueryDetail from './BalanceQueryDetail.svelte';

function balanceCheck(overrides = {}) {
  return {
    id: 'bal-1',
    sim_iccid: '898600520121F0517883',
    profile_id: 'profile-1',
    requested_at: '2026-08-14 04:00:00',
    sent_at: null,
    completed_at: null,
    status: 'parsed',
    step_index: 0,
    response_sender: null,
    raw_response: null,
    error: null,
    parser_version: 'v1',
    country_code: 'CN',
    profile_carrier: 'China Mobile',
    method: 'sms',
    command: '10086',
    destination: null,
    conversation_steps: '[]',
    sim_index: 2,
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
    display_status: overrides.status ?? 'parsed',
    profile_outputs: [],
    metrics: [],
    ...overrides,
  };
}

function message(overrides = {}) {
  return {
    id: 'msg-1',
    type: 'sent',
    content: '',
    timestamp: null,
    status: null,
    phone_number: null,
    recipient: null,
    ...overrides,
  };
}

const check = balanceCheck({
  id: 'bal-test-1',
  sim_iccid: '898600520121F0517883',
  sim_index: 2,
  sim_number: '+8613520607015',
  sim_country: 'CN',
  profile_carrier: 'China Mobile',
  method: 'sms',
  command: '10086',
  destination: '10086',
  status: 'parsed',
  requested_at: '2026-08-14 04:00:00',
  sent_at: '2026-08-14 04:00:01',
  outbound_content: '10086',
  outbound_recipient: '10086',
  response_timestamp: '2026-08-14 04:01:00',
  response_phone_number: '10086',
  response_content: '尊敬的客户，账户余额82.36元。',
  parser_version: 'cn-mobile-v1',
  metrics: [
    { metric_type: 'cash_balance', value: 82.36, unit: null, currency: 'CNY', expires_at: null },
  ],
});

const detail = {
  id: check.id,
  conversation: [
    message({
      id: 'msg-start',
      type: 'sent',
      content: '10086',
      recipient: '10086',
      timestamp: '2026-08-14 04:00:01',
    }),
    message({
      id: 'msg-menu',
      type: 'received',
      content: '1.话费与AI豆',
      phone_number: '10086',
      timestamp: '2026-08-14 04:00:10',
    }),
    message({
      id: 'msg-option',
      type: 'sent',
      content: '1',
      recipient: '10086',
      timestamp: '2026-08-14 04:00:12',
    }),
    message({
      id: 'msg-balance',
      type: 'received',
      content: '尊敬的客户，账户余额82.36元。',
      phone_number: '10086',
      timestamp: '2026-08-14 04:01:00',
    }),
  ],
  web_events: [],
};

afterEach(cleanup);

describe('balance query conversation', () => {
  test('renders one grouped row and opens its details', async () => {
    let opened = null;
    const { getAllByRole, getAllByText } = render(BalanceConversationRow, {
      props: {
        check,
        onOpen: (value) => {
          opened = value;
        },
      },
    });

    expect(getAllByText('余额查询').length).toBe(2);
    expect(getAllByText('已解析').length).toBe(2);
    expect(getAllByText('S02').length).toBe(2);
    await fireEvent.click(getAllByRole('button')[0]);
    expect(opened).toBe(check);
  });

  test('shows the request, reply and parsed result in a mobile-safe detail layer', async () => {
    let closed = false;
    const { container, getByText, getAllByRole, getAllByText } = render(BalanceQueryDetail, {
      props: {
        check,
        detail,
        onClose: () => {
          closed = true;
        },
      },
    });

    expect(getAllByText('发送至 10086')).toHaveLength(2);
    expect(getByText('1.话费与AI豆')).toBeTruthy();
    expect(getByText('尊敬的客户，账户余额82.36元。')).toBeTruthy();
    expect(getByText('账户余额')).toBeTruthy();
    expect(container.querySelector('.bottom-\\[var\\(--mobile-tab-bar-height\\)\\]')).toBeTruthy();

    await fireEvent.click(getAllByRole('button', { name: '关闭' })[0]);
    expect(closed).toBe(true);
  });
});
