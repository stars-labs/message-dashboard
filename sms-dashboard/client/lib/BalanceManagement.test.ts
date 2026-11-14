import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as v from 'valibot';
import type {
  BalanceCheck,
  BalanceMetric,
  BalanceQueryBatchResponse,
  BalanceQueryPreflightResponse,
  BalanceQueryPreviewResponse,
  BalanceQueryResponse,
} from '../../shared/api/balance-checks.js';
import type {
  BalanceRunnerCapabilities,
  BalanceRunnerCapabilitySummary,
  BalanceRunnersResponse,
} from '../../shared/api/balance-runners.js';
import type {
  CarrierBillingAccountsResponse,
  CarrierBillingLinkedSim,
} from '../../shared/api/carrier-billing.js';
import type {
  CarrierBill,
  CarrierBillResponse,
  CarrierBillsResponse,
} from '../../shared/api/carrier-bills.js';
import type { Phone } from '../../shared/api/phones.js';
import { parseJson } from '../../shared/parse-json.js';
import { auth } from './auth.js';
import BalanceManagement from './BalanceManagement.svelte';

type BalancePhone = Phone & { flag: string };
type BillAccount = CarrierBillingAccountsResponse['accounts'][number];
type BillDetail = CarrierBillResponse['bill'];

const DAY_MS = 24 * 60 * 60 * 1000;

const originalBaseUrl = auth.baseUrl;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

/** A D1-style UTC timestamp (`YYYY-MM-DD HH:MM:SS`) offset from now. */
function d1Timestamp(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

function phoneRow(overrides: Partial<BalancePhone> = {}): BalancePhone {
  return {
    id: 'phone-1',
    imei: null,
    iccid: '89860117811049221139',
    number: '+8613520607015',
    country: 'CN',
    carrier: 'China Mobile',
    service_type: 'prepaid',
    service_type_source: 'carrier_account',
    service_type_verified_at: null,
    sim_role: 'primary',
    primary_iccid: null,
    balance_threshold: null,
    status: 'active',
    signal: null,
    operator: null,
    manufacturer: null,
    model: null,
    usb_port: null,
    usb_path: null,
    last_usb_path: null,
    modem_status: null,
    sim_index: 2,
    notes: null,
    created_at: null,
    updated_at: null,
    flag: '',
    ...overrides,
  };
}

function balanceCheck(overrides: Partial<BalanceCheck> = {}): BalanceCheck {
  return {
    id: 'bal-1',
    sim_iccid: '89860117811049221139',
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
    sim_number: '+8613520607015',
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

function runnerSummary(
  overrides: Partial<BalanceRunnerCapabilitySummary> = {},
): BalanceRunnerCapabilitySummary {
  return {
    available: false,
    state: 'offline',
    runner_id: null,
    current_job_id: null,
    detail_code: null,
    last_heartbeat: null,
    ...overrides,
  };
}

function runnerCapabilities(
  overrides: Partial<BalanceRunnerCapabilities> = {},
): BalanceRunnerCapabilities {
  return { sms_ai: runnerSummary(), carrier_browser: runnerSummary(), ...overrides };
}

function runnersResponse(
  capabilities: Partial<BalanceRunnerCapabilities> = {},
): BalanceRunnersResponse {
  return {
    success: true,
    online_seconds: 90,
    capabilities: runnerCapabilities(capabilities),
    runners: [],
  };
}

function linkedSim(
  overrides: Partial<CarrierBillingLinkedSim> &
    Pick<CarrierBillingLinkedSim, 'iccid' | 'sim_index'>,
): CarrierBillingLinkedSim {
  return {
    number: null,
    verification_source: 'sms',
    verified_at: '2026-08-20 00:00:00',
    verified_by: 'system',
    ...overrides,
  };
}

function billAccount(
  overrides: Partial<BillAccount> & Pick<BillAccount, 'id' | 'linked_sims'>,
): BillAccount {
  return {
    country_code: 'SG',
    carrier: 'Singtel',
    currency: 'SGD',
    display_name: 'Singtel corporate',
    account_ref_masked: '•••• 5678',
    status: 'active',
    version: 1,
    payment_due_count: 0,
    notification_sim: { iccid: 'notification-sim', sim_index: 79, number: null },
    ...overrides,
  };
}

function accountsResponse(accounts: BillAccount[]): CarrierBillingAccountsResponse {
  return { success: true, accounts };
}

function carrierBill(overrides: Partial<CarrierBill> = {}): CarrierBill {
  return {
    id: 'bill-1',
    billing_account_id: 'account-1',
    source_message_id: null,
    amount_minor: 4280,
    currency: 'SGD',
    due_date: '2026-09-14',
    received_at: '2026-08-20 00:00:00',
    parser_version: 'v1',
    action_status: 'unpaid',
    payment_planned_at: null,
    paid_at: null,
    paid_by: null,
    operator_note: null,
    version: 1,
    created_at: '2026-08-20 00:00:00',
    updated_at: '2026-08-20 00:00:00',
    account_display_name: 'Singtel corporate',
    carrier: 'Singtel',
    notification_sim_iccid: 'notification-sim',
    linked_sim_count: 1,
    account_ref_masked: '•••• 5678',
    notification_sim: { iccid: 'notification-sim', sim_index: 79, number: null },
    urgency: 'due_soon',
    days_remaining: 4,
    ...overrides,
  };
}

function billsResponse(bills: CarrierBill[]): CarrierBillsResponse {
  return { success: true, today: '2026-09-10', bills };
}

function billDetail(overrides: Partial<BillDetail> = {}): BillDetail {
  return {
    ...carrierBill(),
    linked_sims: [linkedSim({ iccid: 'notification-sim', sim_index: 79 })],
    source_message: null,
    events: [],
    ...overrides,
  };
}

function preflight(
  overrides: Partial<BalanceQueryPreflightResponse> = {},
): BalanceQueryPreflightResponse {
  return {
    success: true,
    eligible: true,
    reason: null,
    phone: { iccid: phone.iccid, sim_index: phone.sim_index, number: phone.number, carrier: null },
    profile: { id: 'profile-1', method: 'sms', carrier: 'China Mobile' },
    method: { category: 'direct_sms', capability: null, interactive: false },
    runner: { required: false, available: true, state: 'not_required' },
    ...overrides,
  };
}

function previewResponse(
  overrides: Pick<BalanceQueryPreviewResponse, 'method_summary' | 'runner_capabilities'> & {
    eligible: number;
  },
): BalanceQueryPreviewResponse {
  const { eligible, ...rest } = overrides;
  return {
    success: true,
    summary: {
      total: eligible,
      eligible,
      offline: 0,
      unsupported: 0,
      unverified: 0,
      cooldown: 0,
      secondary: 0,
      service_type: 0,
    },
    eligible: [],
    ...rest,
  };
}

function queryResponse(): BalanceQueryResponse {
  return { success: true, check: balanceCheck({ id: 'bal-new', status: 'queued' }) };
}

function batchResponse(): BalanceQueryBatchResponse {
  return {
    success: true,
    batch_id: 'batch-1',
    summary: {
      total: 6,
      eligible: 6,
      offline: 0,
      unsupported: 0,
      unverified: 0,
      cooldown: 0,
      secondary: 0,
      service_type: 0,
      selected: 6,
      methods: ['direct_sms', 'sms_ai', 'browser'],
      queued: 6,
      failed_to_queue: 0,
    },
    checks: [],
    failures: [],
  };
}

type Route = (url: URL, init: RequestInit | undefined) => Response | undefined;

function stubApi(route: Route = () => undefined): void {
  auth.baseUrl = 'https://example.com';
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const routed = route(url, init);
        if (routed) return Promise.resolve(routed);
        if (url.pathname === '/api/balance-runners') {
          return Promise.resolve(Response.json(runnersResponse()));
        }
        if (url.pathname === '/api/carrier-billing/accounts') {
          return Promise.resolve(Response.json(accountsResponse([])));
        }
        throw new Error(`Unexpected request: ${url.href}`);
      },
      { preconnect: () => undefined },
    ),
  );
}

function jsonRequestBody<T>(init: RequestInit | undefined, schema: v.GenericSchema<unknown, T>): T {
  const parsed = parseJson(typeof init?.body === 'string' ? init.body : '', schema);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function carrierSelect(element: HTMLElement): HTMLSelectElement {
  if (!(element instanceof HTMLSelectElement)) throw new Error('not a select');
  return element;
}

function inputOf(element: HTMLElement): HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) throw new Error('not an input');
  return element;
}

function found(element: Element | null): Element {
  if (element === null) throw new Error('element not rendered');
  return element;
}

const phone = phoneRow();

const check = balanceCheck({
  id: 'bal-s02',
  sim_iccid: phone.iccid,
  sim_index: phone.sim_index,
  sim_number: phone.number,
  status: 'parsed',
  method: 'sms',
  profile_carrier: 'China Mobile',
  // Relative to now, not a fixed date: balance data older than
  // PREPAID_STALE_DAYS (35) is classed as 数据过期, so a hardcoded 2026-08-14
  // turned three tests red on 2026-09-18 with no code change at all.
  requested_at: d1Timestamp(-2 * DAY_MS - 7_000),
  completed_at: d1Timestamp(-2 * DAY_MS),
  metrics: [metric({ value: 264.33, currency: 'CNY' })],
});

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  auth.baseUrl = originalBaseUrl;
});

describe('balance management', () => {
  test('shows a threshold without a currency as the bare number', () => {
    stubApi();
    const view = render(BalanceManagement, {
      props: {
        phoneNumbers: [{ ...phone, country: 'US', balance_threshold: 50 }],
        balanceChecks: [],
      },
    });

    expect(view.container.textContent).not.toContain('null');
    expect(view.getAllByText('50').length).toBeGreaterThan(0);
  });

  test('keeps each desktop table tab in its own scroll region', async () => {
    stubApi();
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check] },
    });
    const scrollClasses = ['lg:flex-1', 'lg:min-h-0', 'lg:overflow-auto'];

    let scrollRegion = found(view.container.querySelector('[data-desktop-balance-scroll]'));
    for (const className of scrollClasses) {
      expect(scrollRegion.classList.contains(className)).toBe(true);
    }

    await fireEvent.click(view.getByRole('button', { name: '查询记录' }));
    scrollRegion = found(view.container.querySelector('[data-desktop-balance-scroll]'));
    for (const className of scrollClasses) {
      expect(scrollRegion.classList.contains(className)).toBe(true);
    }
  });

  test('shows the receiving-SIM postpaid bill queue without account configuration', async () => {
    stubApi((url) => {
      if (url.pathname === '/api/carrier-bills')
        return Response.json(billsResponse([carrierBill()]));
      return undefined;
    });
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check] },
    });
    await fireEvent.click(view.getByRole('button', { name: '后付费账单' }));
    await waitFor(() => {
      expect(view.getAllByText('S79').length).toBeGreaterThan(0);
    });

    expect(view.getAllByText('SGD 42.80').length).toBeGreaterThan(0);
    expect(view.getAllByText('4 天后到期').length).toBeGreaterThan(0);
    expect(view.queryByText('•••• 5678')).toBeNull();
    expect(view.queryByText('账单账户')).toBeNull();
    expect(view.container.querySelector('[data-desktop-bill-scroll]')).toBeTruthy();
    expect(view.container.querySelector('[data-mobile-bill-list]')).toBeTruthy();
  });

  test('shows retained bill evidence and admin actions but keeps viewers read-only', async () => {
    stubApi((url) => {
      if (url.pathname === '/api/carrier-bills/bill-1') {
        return Response.json({
          success: true,
          bill: billDetail({
            source_message: {
              id: 'message-1',
              content: 'retained bill source',
              sender: 'Singtel',
              timestamp: null,
            },
            events: [
              {
                id: 'event-1',
                event_type: 'detected',
                actor_type: 'system',
                actor_subject: null,
                source_message_id: null,
                created_at: '2026-08-20',
                metadata: null,
              },
            ],
          }),
        } satisfies CarrierBillResponse);
      }
      if (url.pathname === '/api/carrier-bills')
        return Response.json(billsResponse([carrierBill()]));
      return undefined;
    });
    const adminView = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check], canWriteBills: true },
    });
    await fireEvent.click(adminView.getByRole('button', { name: '后付费账单' }));
    await waitFor(() => {
      expect(adminView.getAllByRole('button', { name: '查看账单' }).length).toBeGreaterThan(0);
    });
    const adminOpen = adminView.getAllByRole('button', { name: '查看账单' })[0];
    if (adminOpen === undefined) throw new Error('no bill to open');
    await fireEvent.click(adminOpen);
    await waitFor(() => {
      expect(adminView.getByText('retained bill source')).toBeTruthy();
    });
    expect(adminView.getByRole('button', { name: '标记已付款' })).toBeTruthy();
    cleanup();

    const viewerView = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check], canWriteBills: false },
    });
    await fireEvent.click(viewerView.getByRole('button', { name: '后付费账单' }));
    await waitFor(() => {
      expect(viewerView.getAllByRole('button', { name: '查看账单' }).length).toBeGreaterThan(0);
    });
    const viewerOpen = viewerView.getAllByRole('button', { name: '查看账单' })[0];
    if (viewerOpen === undefined) throw new Error('no bill to open');
    await fireEvent.click(viewerOpen);
    await waitFor(() => {
      expect(viewerView.getByText('retained bill source')).toBeTruthy();
    });
    expect(viewerView.queryByRole('button', { name: '标记已付款' })).toBeNull();
  });

  test('distinguishes SIMs with and without received bill SMS in the balance overview', async () => {
    const linked = phoneRow({ iccid: 'linked-sim', sim_index: 79, service_type: 'postpaid' });
    const unlinked = phoneRow({ iccid: 'unlinked-sim', sim_index: 80, service_type: 'postpaid' });
    stubApi((url) => {
      if (url.pathname === '/api/carrier-billing/accounts') {
        return Response.json(
          accountsResponse([
            billAccount({
              id: 'account-1',
              linked_sims: [linkedSim({ iccid: 'linked-sim', sim_index: 79 })],
            }),
          ]),
        );
      }
      return undefined;
    });
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [linked, unlinked], balanceChecks: [] },
    });
    await waitFor(() => {
      expect(view.getAllByText('已收到过账单短信').length).toBeGreaterThan(0);
    });
    expect(view.getAllByText('等待账单短信').length).toBeGreaterThan(0);
  });

  test('loads received bill evidence when the SIM inventory arrives after mount', async () => {
    const linked = phoneRow({ iccid: 'linked-sim', sim_index: 79, service_type: 'postpaid' });
    stubApi((url) => {
      if (url.pathname === '/api/carrier-billing/accounts') {
        return Response.json(
          accountsResponse([
            billAccount({
              id: 'account-1',
              linked_sims: [linkedSim({ iccid: 'linked-sim', sim_index: 79 })],
            }),
          ]),
        );
      }
      return undefined;
    });
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [], balanceChecks: [] },
    });
    await view.rerender({ phoneNumbers: [linked], balanceChecks: [] });

    await waitFor(() => {
      expect(view.getAllByText('已收到过账单短信').length).toBeGreaterThan(0);
    });
  });

  test('shows runner capability health from the control plane', async () => {
    stubApi((url) => {
      if (url.pathname === '/api/balance-runners') {
        return Response.json(
          runnersResponse({
            sms_ai: runnerSummary({ available: true, state: 'ready' }),
            carrier_browser: runnerSummary({
              available: true,
              state: 'busy',
              detail_code: 'human_verification_required',
            }),
          }),
        );
      }
      return undefined;
    });
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check] },
    });
    // Wait on the capability that can only appear after the status loads.
    await waitFor(() => {
      expect(view.getByText('需要人工验证')).toBeTruthy();
    });
    // Same three words as the daemon's own health: 正常 / 部分异常 / 离线.
    expect(view.getAllByText('正常').length).toBeGreaterThan(0);
    expect(view.getByText('浏览器任务逐张处理')).toBeTruthy();
  });

  test('shows a per-SIM overview and opens the latest query', async () => {
    stubApi();
    const opened: BalanceCheck[] = [];
    const view = render(BalanceManagement, {
      props: {
        phoneNumbers: [phone],
        balanceChecks: [check],
        onOpenBalance: (value: BalanceCheck) => {
          opened.push(value);
        },
      },
    });

    expect(view.getAllByText('S02').length).toBeGreaterThan(0);
    expect(view.getAllByText(/264\.33/).length).toBeGreaterThan(0);
    expect(view.getAllByText('预付费').length).toBeGreaterThan(0);
    expect(view.getAllByText('正常').length).toBeGreaterThan(0);

    await fireEvent.click(view.getByRole('button', { name: '查看' }));
    expect(opened[0]).toBe(check);
  });

  test('shows balance and expiry risks at the same time', () => {
    stubApi();
    const expiringSoon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const atRisk = {
      ...check,
      metrics: [
        metric({ value: 4.5, currency: 'CNY' }),
        metric({ metric_type: 'account_expiry', expires_at: expiringSoon }),
      ],
    };
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [atRisk] },
    });

    expect(view.getAllByText('需要充值').length).toBeGreaterThan(0);
    expect(view.getAllByText('即将到期').length).toBeGreaterThan(0);
    expect(view.getAllByText(expiringSoon).length).toBeGreaterThan(0);
  });

  test('combines prepaid recharge and postpaid bill actions under payment due', async () => {
    const prepaid = phoneRow({ iccid: 'prepaid-sim', sim_index: 2 });
    const postpaid = phoneRow({ iccid: 'postpaid-sim', sim_index: 79, service_type: 'postpaid' });
    const clearPostpaid = { ...postpaid, iccid: 'clear-postpaid-sim', sim_index: 80 };
    const lowBalance = {
      ...check,
      sim_iccid: prepaid.iccid,
      sim_index: prepaid.sim_index,
      metrics: [metric({ value: 4.5, currency: 'CNY' })],
    };
    stubApi((url) => {
      if (url.pathname === '/api/carrier-billing/accounts') {
        return Response.json(
          accountsResponse([
            billAccount({
              id: 'account-1',
              payment_due_count: 1,
              notification_sim: { iccid: postpaid.iccid, sim_index: 79, number: null },
              linked_sims: [linkedSim({ iccid: postpaid.iccid, sim_index: 79 })],
            }),
          ]),
        );
      }
      return undefined;
    });
    const view = render(BalanceManagement, {
      props: {
        phoneNumbers: [prepaid, postpaid, clearPostpaid],
        balanceChecks: [lowBalance],
      },
    });

    const paymentFilter = await view.findByRole('button', { name: '需付款 2' });
    await fireEvent.click(paymentFilter);
    expect(view.getAllByText('S02').length).toBeGreaterThan(0);
    expect(view.getAllByText('S79').length).toBeGreaterThan(0);
    expect(view.queryByText('S80')).toBeNull();
  });

  test('opens the current bill detail from a postpaid overview row', async () => {
    const postpaid = phoneRow({ iccid: 'postpaid-sim', sim_index: 79, service_type: 'postpaid' });
    const postpaidSim = { iccid: postpaid.iccid, sim_index: 79, number: null };
    const currentBill = carrierBill({
      amount_minor: 7202,
      due_date: '2026-09-07',
      days_remaining: 7,
      notification_sim: postpaidSim,
    });
    stubApi((url) => {
      if (url.pathname === '/api/carrier-billing/accounts') {
        return Response.json(
          accountsResponse([
            billAccount({
              id: 'account-1',
              payment_due_count: 1,
              notification_sim: postpaidSim,
              linked_sims: [linkedSim({ iccid: postpaid.iccid, sim_index: 79 })],
            }),
          ]),
        );
      }
      if (url.pathname === '/api/carrier-bills/bill-1') {
        return Response.json({
          success: true,
          bill: billDetail({
            ...currentBill,
            linked_sims: [linkedSim({ iccid: postpaid.iccid, sim_index: 79 })],
            source_message: {
              id: 'message-1',
              sender: 'Singtel',
              content: 'current bill source',
              timestamp: null,
            },
          }),
        } satisfies CarrierBillResponse);
      }
      if (url.pathname === '/api/carrier-bills') return Response.json(billsResponse([currentBill]));
      return undefined;
    });
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [postpaid], balanceChecks: [] },
    });

    await view.findAllByText('待付款 1 笔');
    const openBill = (await view.findAllByRole('button', { name: '查看账单' }))[0];
    if (openBill === undefined) throw new Error('no bill to open');
    await fireEvent.click(openBill);
    await waitFor(() => {
      expect(view.getByText('账单短信证据')).toBeTruthy();
    });
    expect(view.getByText('current bill source')).toBeTruthy();
    expect(view.getAllByText('SGD 72.02').length).toBeGreaterThan(0);
  });

  test('does not offer a prepaid balance query for postpaid SIMs', () => {
    stubApi();
    const view = render(BalanceManagement, {
      props: {
        phoneNumbers: [{ ...phone, service_type: 'postpaid' }],
        balanceChecks: [check],
        canQueryBalances: true,
      },
    });

    expect(view.getAllByText('后付费账单管理').length).toBeGreaterThan(0);
    expect(view.getAllByText('不按余额管理').length).toBeGreaterThan(0);
    expect(view.queryByText(/264\.33/)).toBeNull();
    expect(view.queryByRole('button', { name: '查询' })).toBeNull();
    expect(view.queryByRole('button', { name: '批量查询' })).toBeNull();
  });

  test('classifies a secondary with its primary instead of as unobtained', async () => {
    stubApi();
    const primary = { ...phone, sim_role: 'primary' };
    const secondary = {
      ...phone,
      iccid: '89860117811049221140',
      sim_index: 3,
      number: '+8613520607016',
      sim_role: 'secondary',
      primary_iccid: primary.iccid,
    };
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [primary, secondary], balanceChecks: [check] },
    });

    expect(view.getByRole('button', { name: '正常 2' })).toBeTruthy();
    expect(view.getByRole('button', { name: '未取得 0' })).toBeTruthy();
    await fireEvent.click(view.getByRole('button', { name: '未取得 0' }));
    expect(view.getByText('没有匹配的 SIM')).toBeTruthy();
  });

  test('switches to the query audit list', async () => {
    stubApi();
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check] },
    });

    await fireEvent.click(view.getByRole('button', { name: '查询记录' }));
    expect(view.getAllByText('已解析').length).toBeGreaterThan(0);
    expect(view.getAllByText('China Mobile').length).toBeGreaterThan(0);
    expect(view.getAllByRole('button', { name: '详情' }).length).toBeGreaterThan(0);
  });

  test('shows single and batch query controls only to authorised users', async () => {
    stubApi();
    const adminView = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check], canQueryBalances: true },
    });
    expect(adminView.getByRole('button', { name: '批量查询' })).toBeTruthy();
    expect(adminView.getAllByRole('button', { name: '查询' }).length).toBeGreaterThan(0);
    await fireEvent.click(adminView.getByRole('button', { name: '查询记录' }));
    expect(adminView.queryByRole('button', { name: '批量查询' })).toBeNull();
    cleanup();

    const viewerView = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check], canQueryBalances: false },
    });
    expect(viewerView.queryByRole('button', { name: '批量查询' })).toBeNull();
    expect(viewerView.queryByRole('button', { name: '查询' })).toBeNull();
  });

  test('opens Balance Agent guidance instead of silently queueing when a required runner is offline', async () => {
    let queued = 0;
    stubApi((url, init) => {
      if (url.pathname === '/api/balance-checks/query-preflight') {
        return Response.json(
          preflight({
            method: { category: 'sms_ai', capability: 'sms_ai', interactive: false },
            runner: { required: true, ...runnerSummary({ available: false, state: 'offline' }) },
          }),
        );
      }
      if (url.pathname === '/api/balance-checks/query' && init?.method === 'POST') {
        queued += 1;
        return Response.json(queryResponse(), { status: 202 });
      }
      return undefined;
    });
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check], canQueryBalances: true },
    });
    const query = view.getAllByRole('button', { name: '查询' })[0];
    if (query === undefined) throw new Error('no query button');
    await fireEvent.click(query);
    await waitFor(() => {
      expect(view.getByText('查询助手未就绪')).toBeTruthy();
    });
    expect(view.getByRole('link', { name: '打开查询助手' }).getAttribute('href')).toBe(
      'message-dashboard-runner://open',
    );
    expect(queued).toBe(0);
    await fireEvent.click(view.getByRole('button', { name: '仍然排队' }));
    await waitFor(() => {
      expect(queued).toBe(1);
    });
  });

  test('warns about human verification before queueing an available browser query', async () => {
    let queued = 0;
    stubApi((url, init) => {
      if (url.pathname === '/api/balance-checks/query-preflight') {
        return Response.json(
          preflight({
            method: { category: 'browser', capability: 'carrier_browser', interactive: true },
            runner: { required: true, ...runnerSummary({ available: true, state: 'ready' }) },
          }),
        );
      }
      if (url.pathname === '/api/balance-checks/query' && init?.method === 'POST') {
        queued += 1;
        return Response.json(queryResponse(), { status: 202 });
      }
      return undefined;
    });
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check], canQueryBalances: true },
    });
    const query = view.getAllByRole('button', { name: '查询' })[0];
    if (query === undefined) throw new Error('no query button');
    await fireEvent.click(query);
    await waitFor(() => {
      expect(view.getByText('浏览器查询确认')).toBeTruthy();
    });
    expect(view.getByText(/滑块或图片验证/)).toBeTruthy();
    expect(queued).toBe(0);
    await fireEvent.click(view.getByRole('button', { name: '开始查询' }));
    await waitFor(() => {
      expect(queued).toBe(1);
    });
  });

  test('keeps browser jobs out of a batch until explicitly selected', async () => {
    const BatchBody = v.object({
      methods: v.array(v.string()),
      phone_iccids: v.array(v.string()),
    });
    const PreviewBody = v.object({ phone_iccids: v.array(v.string()) });
    const submittedMethods: string[][] = [];
    const previewScopes: string[][] = [];
    const submittedScopes: string[][] = [];
    stubApi((url, init) => {
      if (url.pathname === '/api/balance-checks/query-preview') {
        expect(init?.method).toBe('POST');
        previewScopes.push(jsonRequestBody(init, PreviewBody).phone_iccids);
        return Response.json(
          previewResponse({
            eligible: 6,
            method_summary: { direct_sms: 1, sms_ai: 2, browser: 3 },
            runner_capabilities: runnerCapabilities({
              sms_ai: runnerSummary({ available: true, state: 'ready' }),
              carrier_browser: runnerSummary({ available: true, state: 'ready' }),
            }),
          }),
        );
      }
      if (url.pathname === '/api/balance-checks/query-batch' && init?.method === 'POST') {
        const body = jsonRequestBody(init, BatchBody);
        submittedMethods.push(body.methods);
        submittedScopes.push(body.phone_iccids);
        return Response.json(batchResponse(), { status: 202 });
      }
      return undefined;
    });
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check], canQueryBalances: true },
    });
    await fireEvent.click(view.getByRole('button', { name: '批量查询' }));
    await waitFor(() => {
      expect(view.getByRole('button', { name: '确认查询 3 张卡' })).toBeTruthy();
    });
    const browser = inputOf(view.getByRole('checkbox', { name: /浏览器登录/ }));
    expect(browser.checked).toBe(false);
    await fireEvent.click(browser);
    expect(view.getByRole('button', { name: '确认查询 6 张卡' })).toBeTruthy();
    expect(view.getByText(/每张卡都可能需要人工验证/)).toBeTruthy();
    await fireEvent.click(view.getByRole('button', { name: '确认查询 6 张卡' }));
    await waitFor(() => {
      expect(previewScopes).toEqual([[phone.iccid]]);
      expect(submittedMethods).toEqual([['direct_sms', 'sms_ai', 'browser']]);
      expect(submittedScopes).toEqual(previewScopes);
    });
  });

  test('uses the current filters as the default batch scope', async () => {
    const unicomPhone = phoneRow({
      iccid: '89860117811049221140',
      sim_index: 3,
      number: '+8618600000000',
      carrier: 'China Unicom',
    });
    const PreviewBody = v.object({ phone_iccids: v.array(v.string()) });
    const previewScopes: string[][] = [];
    stubApi((url, init) => {
      if (url.pathname === '/api/balance-checks/query-preview') {
        previewScopes.push(jsonRequestBody(init, PreviewBody).phone_iccids);
        return Response.json(
          previewResponse({
            eligible: 1,
            method_summary: { direct_sms: 0, sms_ai: 0, browser: 1 },
            runner_capabilities: runnerCapabilities({
              carrier_browser: runnerSummary({ available: true, state: 'ready' }),
            }),
          }),
        );
      }
      return undefined;
    });
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone, unicomPhone], balanceChecks: [], canQueryBalances: true },
    });
    const carrierFilter = carrierSelect(view.getByLabelText('运营商筛选'));
    carrierFilter.value = 'china-unicom';
    await fireEvent.change(carrierFilter);
    await fireEvent.click(view.getByRole('button', { name: '批量查询' }));

    await waitFor(() => {
      expect(previewScopes).toEqual([[unicomPhone.iccid]]);
    });
    // The scope renders once the preview answers, after the request is sent.
    await waitFor(() => {
      expect(view.getByText(/查询范围：/).parentElement?.textContent).toContain('联通');
    });
    expect(view.getByText('范围内卡数')).toBeTruthy();
  });

  test('uses manually selected cards instead of the visible filter scope', async () => {
    const unicomPhone = phoneRow({
      iccid: '89860117811049221140',
      sim_index: 3,
      number: '+8618600000000',
      carrier: 'China Unicom',
    });
    const PreviewBody = v.object({ phone_iccids: v.array(v.string()) });
    const previewScopes: string[][] = [];
    stubApi((url, init) => {
      if (url.pathname === '/api/balance-checks/query-preview') {
        previewScopes.push(jsonRequestBody(init, PreviewBody).phone_iccids);
        return Response.json(
          previewResponse({
            eligible: 1,
            method_summary: { direct_sms: 1, sms_ai: 0, browser: 0 },
            runner_capabilities: runnerCapabilities(),
          }),
        );
      }
      return undefined;
    });
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone, unicomPhone], balanceChecks: [], canQueryBalances: true },
    });
    await fireEvent.click(view.getByRole('checkbox', { name: '选择 S02' }));
    expect(view.getByText('已选 1 张')).toBeTruthy();

    const carrierFilter = carrierSelect(view.getByLabelText('运营商筛选'));
    carrierFilter.value = 'china-unicom';
    await fireEvent.change(carrierFilter);
    await fireEvent.click(view.getByRole('button', { name: '批量查询' }));

    await waitFor(() => {
      expect(previewScopes).toEqual([[phone.iccid]]);
    });
    await waitFor(() => {
      expect(view.getByText(/手动选择 1 张卡/)).toBeTruthy();
    });
  });

  test('renders the compact mobile balance row and mobile-first search controls', () => {
    stubApi();
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check], canQueryBalances: true },
    });

    expect(view.container.querySelectorAll('[data-mobile-balance-row]')).toHaveLength(1);
    // One placeholder across every SIM search in the app.
    expect(inputOf(view.getByRole('searchbox', { name: '搜索 SIM' })).placeholder).toBe(
      '卡号 / 号码 / 运营商 / ICCID',
    );
    expect(view.getByRole('button', { name: '查询 S02 余额' })).toBeTruthy();
  });

  test('toggles overview and history table sorting from the column headers', async () => {
    stubApi();
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check] },
    });

    const simSort = view.getByRole('button', { name: '按卡号升序排列' });
    await fireEvent.click(simSort);
    expect(view.getByRole('button', { name: '按卡号降序排列' })).toBeTruthy();

    await fireEvent.click(view.getByRole('button', { name: '查询记录' }));
    const timeSort = view.getByRole('button', { name: '按时间升序排列' });
    await fireEvent.click(timeSort);
    expect(view.getByRole('button', { name: '按时间降序排列' })).toBeTruthy();
  });

  test('filters both the overview and query history by carrier', async () => {
    stubApi();
    const unicomPhone = phoneRow({
      iccid: '89860117811049221140',
      sim_index: 3,
      number: '+8618600000000',
      carrier: 'China Unicom',
    });
    const unicomCheck = {
      ...check,
      id: 'bal-s03',
      sim_iccid: unicomPhone.iccid,
      sim_index: unicomPhone.sim_index,
      sim_number: unicomPhone.number,
      profile_carrier: 'China Unicom',
    };
    const view = render(BalanceManagement, {
      props: {
        phoneNumbers: [phone, unicomPhone],
        balanceChecks: [check, unicomCheck],
      },
    });

    const carrierFilter = carrierSelect(view.getByLabelText('运营商筛选'));
    carrierFilter.value = 'china-unicom';
    await fireEvent.change(carrierFilter);
    await waitFor(() => {
      expect(view.container.querySelectorAll('tbody tr')).toHaveLength(1);
    });
    let rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('S03');
    expect(rows[0]?.textContent).not.toContain('S02');

    await fireEvent.click(view.getByRole('button', { name: '查询记录' }));
    rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('S03');
    expect(rows[0]?.textContent).not.toContain('S02');
  });

  test('filters Hong Kong Mobile separately from mainland China Mobile', async () => {
    stubApi();
    const cmhkPhone = phoneRow({
      iccid: '89852000000000000001',
      sim_index: 3,
      number: '+85260000000',
      country: 'HK',
      carrier: '移动',
    });
    const cmhkCheck = {
      ...check,
      id: 'bal-s03',
      sim_iccid: cmhkPhone.iccid,
      sim_index: cmhkPhone.sim_index,
      sim_number: cmhkPhone.number,
      profile_carrier: '移动',
      sim_country: 'HK',
    };
    const view = render(BalanceManagement, {
      props: {
        phoneNumbers: [{ ...phone, carrier: '移动' }, cmhkPhone],
        balanceChecks: [{ ...check, profile_carrier: '移动', sim_country: 'CN' }, cmhkCheck],
      },
    });

    const carrierFilter = carrierSelect(view.getByLabelText('运营商筛选'));
    const optionLabels = [...carrierFilter.options].map((option) => option.textContent);
    expect(optionLabels).toContain('移动');
    expect(optionLabels).toContain('CMHK');

    carrierFilter.value = 'cmhk';
    await fireEvent.change(carrierFilter);
    let rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('S03');
    expect(rows[0]?.textContent).not.toContain('S02');

    await fireEvent.click(view.getByRole('button', { name: '查询记录' }));
    rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('S03');
    expect(rows[0]?.textContent).not.toContain('S02');
  });
});
