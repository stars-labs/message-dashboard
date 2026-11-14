import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import type { BalanceCheck } from '../../shared/api/balance-checks.js';
import type { Phone } from '../../shared/api/phones.js';
import { formatBalanceMetric } from './balance-query.js';
import PhoneDetails from './PhoneDetails.svelte';

type DetailedPhone = Phone & { flag: string };

function phone(overrides: Partial<DetailedPhone> = {}): DetailedPhone {
  return {
    id: 'phone-1',
    imei: '867012345678901',
    iccid: '898600520121F0517883',
    number: '+8613520607015',
    country: 'CN',
    carrier: 'China Mobile',
    service_type: 'postpaid',
    service_type_source: null,
    service_type_verified_at: null,
    sim_role: 'standalone',
    primary_iccid: null,
    balance_threshold: null,
    status: 'active',
    signal: 71,
    operator: 'CHN-UNICOM',
    manufacturer: 'Quectel',
    model: 'EC20',
    usb_port: 3,
    usb_path: '1-1.2',
    last_usb_path: null,
    modem_status: null,
    sim_index: 5,
    notes: null,
    created_at: null,
    updated_at: '2026-08-14 04:00:00',
    flag: '🇨🇳',
    ...overrides,
  };
}

function balanceCheck(overrides: Partial<BalanceCheck> = {}): BalanceCheck {
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
    sim_index: 5,
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
    metrics: [
      { metric_type: 'cash_balance', value: 82.36, unit: null, currency: 'CNY', expires_at: null },
    ],
    ...overrides,
  };
}

afterEach(cleanup);

describe('PhoneDetails', () => {
  test('renders nothing without a phone', () => {
    const { container } = render(PhoneDetails, { props: { phone: null } });

    expect(container.querySelector('section')).toBeNull();
  });

  test('shows the card number, flag and number in the header', () => {
    const { getByText } = render(PhoneDetails, { props: { phone: phone() } });

    expect(getByText('S05')).toBeTruthy();
    expect(getByText(/🇨🇳\s+\+8613520607015/)).toBeTruthy();
  });

  test('labels the status from the live daemon connection', () => {
    const online = render(PhoneDetails, {
      props: { phone: phone(), daemonStatus: { connected: true } },
    });
    expect(online.getByText('在线')).toBeTruthy();
    expect(online.getByText('正常')).toBeTruthy();
    cleanup();

    const offline = render(PhoneDetails, {
      props: { phone: phone(), daemonStatus: { connected: false } },
    });
    expect(offline.getByText('离线', { selector: 'span' })).toBeTruthy();
    expect(offline.getByText('离线', { selector: 'dd' })).toBeTruthy();
    expect(offline.queryByText('在线')).toBeNull();
  });

  test('shows the cash balance of the balance check and opens it', async () => {
    const check = balanceCheck();
    const opened: BalanceCheck[] = [];
    const { getByRole, getByText } = render(PhoneDetails, {
      props: {
        phone: phone(),
        balanceCheck: check,
        onOpenBalance: (value: BalanceCheck) => {
          opened.push(value);
        },
      },
    });

    expect(getByText(formatBalanceMetric(check.metrics[0] ?? null))).toBeTruthy();
    expect(getByText('已解析')).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: '查看余额查询详情' }));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toBe(check);
  });

  test('hides the balance button without a balance check', () => {
    const { queryByRole } = render(PhoneDetails, { props: { phone: phone() } });

    expect(queryByRole('button', { name: '查看余额查询详情' })).toBeNull();
  });

  test('labels the service type and the standalone role', () => {
    const { getByText } = render(PhoneDetails, {
      props: { phone: phone({ service_type: 'prepaid' }) },
    });

    expect(getByText('预付费')).toBeTruthy();
    expect(getByText('独立')).toBeTruthy();
  });

  test('names the primary card of a secondary SIM', () => {
    const { getByText } = render(PhoneDetails, {
      props: {
        phone: phone({ sim_role: 'secondary', primary_iccid: '8986PRIMARY' }),
        phones: [{ iccid: '8986PRIMARY', sim_index: 3 }],
      },
    });

    expect(getByText('副卡', { selector: 'dd', exact: false })).toBeTruthy();
    expect(getByText(/→\s*S03/)).toBeTruthy();
  });

  test('shows the module, carrier, location and notes', () => {
    const { getByText } = render(PhoneDetails, {
      props: { phone: phone({ notes: 'shelf 2' }) },
    });

    expect(getByText('Quectel EC20')).toBeTruthy();
    expect(getByText('China Mobile')).toBeTruthy();
    expect(getByText('1-1.2')).toBeTruthy();
    expect(getByText('CHN-UNICOM')).toBeTruthy();
    expect(getByText('shelf 2')).toBeTruthy();
  });

  test('marks a position taken from the last known USB path', () => {
    const { getByText } = render(PhoneDetails, {
      props: { phone: phone({ usb_path: null, last_usb_path: '1-1.4' }) },
    });

    expect(getByText(/1-1\.4/)).toBeTruthy();
    expect(getByText('（上次）')).toBeTruthy();
  });
});
