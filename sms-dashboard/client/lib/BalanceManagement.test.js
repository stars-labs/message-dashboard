import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import BalanceManagement from './BalanceManagement.svelte';

const phone = {
  iccid: '89860117811049221139',
  sim_index: 2,
  number: '+8613520607015',
  country: 'CN',
  carrier: 'China Mobile',
  service_type: 'prepaid',
  service_type_source: 'carrier_account',
  flag: '🇨🇳',
};

const check = {
  id: 'bal-s02',
  sim_iccid: phone.iccid,
  sim_index: phone.sim_index,
  sim_number: phone.number,
  status: 'parsed',
  method: 'sms',
  profile_carrier: 'China Mobile',
  requested_at: '2026-08-14 04:41:01',
  completed_at: '2026-08-14 04:41:08',
  metrics: [{ metric_type: 'cash_balance', value: 264.33, currency: 'CNY' }],
};

afterEach(cleanup);

describe('balance management', () => {
  test('keeps each desktop table tab in its own scroll region', async () => {
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check] },
    });

    let scrollRegion = view.container.querySelector('[data-desktop-balance-scroll]');
    expect(scrollRegion).toBeTruthy();
    expect(scrollRegion.classList).toContain('lg:flex-1', 'lg:min-h-0', 'lg:overflow-auto');

    await fireEvent.click(view.getByRole('button', { name: '查询记录' }));
    scrollRegion = view.container.querySelector('[data-desktop-balance-scroll]');
    expect(scrollRegion).toBeTruthy();
    expect(scrollRegion.classList).toContain('lg:flex-1', 'lg:min-h-0', 'lg:overflow-auto');
  });

  test('shows the receiving-SIM postpaid bill queue without account configuration', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes('/api/balance-runners')) return Response.json({ success: true, capabilities: {} });
      if (value.includes('/api/carrier-billing/accounts')) {
        return Response.json({ success: true, accounts: [] });
      }
      if (value.includes('/api/carrier-bills')) {
        return Response.json({
          success: true,
          today: '2026-09-10',
          bills: [{
            id: 'bill-1',
            billing_account_id: 'account-1',
            account_display_name: 'Singtel corporate',
            account_ref_masked: '•••• 5678',
            carrier: 'Singtel',
            amount_minor: 4280,
            currency: 'SGD',
            due_date: '2026-09-14',
            urgency: 'due_soon',
            days_remaining: 4,
            action_status: 'unpaid',
            linked_sim_count: 1,
            notification_sim: { iccid: 'notification-sim', sim_index: 79 },
            version: 1,
          }],
        });
      }
      throw new Error(`Unexpected request: ${value}`);
    };
    try {
      const view = render(BalanceManagement, {
        props: { phoneNumbers: [phone], balanceChecks: [check] },
      });
      await fireEvent.click(view.getByRole('button', { name: '后付费账单' }));
      await waitFor(() => expect(view.getAllByText('S79').length).toBeGreaterThan(0));

      expect(view.getAllByText('SGD 42.80').length).toBeGreaterThan(0);
      expect(view.getAllByText('4 天后到期').length).toBeGreaterThan(0);
      expect(view.queryByText('•••• 5678')).toBeNull();
      expect(view.queryByText('账单账户')).toBeNull();
      expect(view.container.querySelector('[data-desktop-bill-scroll]')).toBeTruthy();
      expect(view.container.querySelector('[data-mobile-bill-list]')).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('shows retained bill evidence and admin actions but keeps viewers read-only', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes('/api/balance-runners')) return Response.json({ success: true, capabilities: {} });
      if (value.includes('/api/carrier-billing/accounts')) return Response.json({ success: true, accounts: [] });
      if (value.endsWith('/api/carrier-bills/bill-1')) {
        return Response.json({
          success: true,
          bill: {
            id: 'bill-1',
            account_ref_masked: '•••• 5678',
            account_display_name: 'Singtel corporate',
            carrier: 'Singtel',
            amount_minor: 4280,
            currency: 'SGD',
            due_date: '2026-09-14',
            urgency: 'due_soon',
            days_remaining: 4,
            action_status: 'unpaid',
            version: 1,
            linked_sims: [{ iccid: 'notification-sim', sim_index: 79 }],
            source_message: { content: 'retained bill source', sender: 'Singtel' },
            events: [{ id: 'event-1', event_type: 'detected', actor_type: 'system', created_at: '2026-08-20' }],
          },
        });
      }
      if (value.includes('/api/carrier-bills')) {
        return Response.json({
          success: true,
          bills: [{
            id: 'bill-1', account_ref_masked: '•••• 5678', account_display_name: 'Singtel corporate',
            carrier: 'Singtel', amount_minor: 4280, currency: 'SGD', due_date: '2026-09-14',
            urgency: 'due_soon', days_remaining: 4, action_status: 'unpaid', linked_sim_count: 1,
            notification_sim: { sim_index: 79 }, version: 1,
          }],
        });
      }
      throw new Error(`Unexpected request: ${value}`);
    };
    try {
      const adminView = render(BalanceManagement, {
        props: { phoneNumbers: [phone], balanceChecks: [check], canWriteBills: true },
      });
      await fireEvent.click(adminView.getByRole('button', { name: '后付费账单' }));
      await waitFor(() => expect(adminView.getAllByRole('button', { name: '查看账单' }).length).toBeGreaterThan(0));
      await fireEvent.click(adminView.getAllByRole('button', { name: '查看账单' })[0]);
      await waitFor(() => expect(adminView.getByText('retained bill source')).toBeTruthy());
      expect(adminView.getByRole('button', { name: '标记已付款' })).toBeTruthy();
      cleanup();

      const viewerView = render(BalanceManagement, {
        props: { phoneNumbers: [phone], balanceChecks: [check], canWriteBills: false },
      });
      await fireEvent.click(viewerView.getByRole('button', { name: '后付费账单' }));
      await waitFor(() => expect(viewerView.getAllByRole('button', { name: '查看账单' }).length).toBeGreaterThan(0));
      await fireEvent.click(viewerView.getAllByRole('button', { name: '查看账单' })[0]);
      await waitFor(() => expect(viewerView.getByText('retained bill source')).toBeTruthy());
      expect(viewerView.queryByRole('button', { name: '标记已付款' })).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('distinguishes SIMs with and without received bill SMS in the balance overview', async () => {
    const originalFetch = globalThis.fetch;
    const linked = { ...phone, iccid: 'linked-sim', sim_index: 79, service_type: 'postpaid' };
    const unlinked = { ...phone, iccid: 'unlinked-sim', sim_index: 80, service_type: 'postpaid' };
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes('/api/balance-runners')) return Response.json({ success: true, capabilities: {} });
      if (value.includes('/api/carrier-billing/accounts')) {
        return Response.json({
          success: true,
          accounts: [{
            id: 'account-1',
            account_ref_masked: '•••• 5678',
            linked_sims: [{ iccid: 'linked-sim', sim_index: 79 }],
          }],
        });
      }
      throw new Error(`Unexpected request: ${value}`);
    };
    try {
      const view = render(BalanceManagement, {
        props: { phoneNumbers: [linked, unlinked], balanceChecks: [] },
      });
      await waitFor(() => expect(view.getAllByText('已收到过账单短信').length).toBeGreaterThan(0));
      expect(view.getAllByText('等待账单短信').length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('loads received bill evidence when the SIM inventory arrives after mount', async () => {
    const originalFetch = globalThis.fetch;
    const linked = { ...phone, iccid: 'linked-sim', sim_index: 79, service_type: 'postpaid' };
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes('/api/balance-runners')) return Response.json({ success: true, capabilities: {} });
      if (value.includes('/api/carrier-billing/accounts')) {
        return Response.json({
          success: true,
          accounts: [{
            id: 'account-1',
            linked_sims: [{ iccid: 'linked-sim', sim_index: 79 }],
          }],
        });
      }
      throw new Error(`Unexpected request: ${value}`);
    };
    try {
      const view = render(BalanceManagement, {
        props: { phoneNumbers: [], balanceChecks: [] },
      });
      await view.rerender({ phoneNumbers: [linked], balanceChecks: [] });

      await waitFor(() => expect(view.getAllByText('已收到过账单短信').length).toBeGreaterThan(0));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('shows runner capability health from the control plane', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      expect(String(url)).toContain('/api/balance-runners');
      return new Response(JSON.stringify({
        success: true,
        capabilities: {
          sms_ai: { available: true, state: 'ready' },
          carrier_browser: {
            available: true,
            state: 'busy',
            detail_code: 'human_verification_required',
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const view = render(BalanceManagement, {
        props: { phoneNumbers: [phone], balanceChecks: [check] },
      });
      await waitFor(() => expect(view.getByText('已就绪')).toBeTruthy());
      expect(view.getByText('需要人工验证')).toBeTruthy();
      expect(view.getByText('浏览器任务逐张处理')).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('shows a per-SIM overview and opens the latest query', async () => {
    let opened = null;
    const view = render(BalanceManagement, {
      props: {
        phoneNumbers: [phone],
        balanceChecks: [check],
        onOpenBalance: (value) => { opened = value; },
      },
    });

    expect(view.getAllByText('S02').length).toBeGreaterThan(0);
    expect(view.getAllByText(/264\.33/).length).toBeGreaterThan(0);
    expect(view.getAllByText('预付费').length).toBeGreaterThan(0);
    expect(view.getAllByText('正常').length).toBeGreaterThan(0);

    await fireEvent.click(view.getByRole('button', { name: '查看' }));
    expect(opened).toBe(check);
  });

  test('shows balance and expiry risks at the same time', () => {
    const atRisk = {
      ...check,
      metrics: [
        { metric_type: 'cash_balance', value: 4.5, currency: 'CNY' },
        { metric_type: 'account_expiry', value: null, expires_at: '2026-08-30' },
      ],
    };
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [atRisk] },
    });

    expect(view.getAllByText('需要充值').length).toBeGreaterThan(0);
    expect(view.getAllByText('即将到期').length).toBeGreaterThan(0);
    expect(view.getAllByText('2026-08-30').length).toBeGreaterThan(0);
  });

  test('combines prepaid recharge and postpaid bill actions under payment due', async () => {
    const originalFetch = globalThis.fetch;
    const prepaid = { ...phone, iccid: 'prepaid-sim', sim_index: 2 };
    const postpaid = { ...phone, iccid: 'postpaid-sim', sim_index: 79, service_type: 'postpaid' };
    const clearPostpaid = { ...postpaid, iccid: 'clear-postpaid-sim', sim_index: 80 };
    const lowBalance = {
      ...check,
      sim_iccid: prepaid.iccid,
      sim_index: prepaid.sim_index,
      metrics: [{ metric_type: 'cash_balance', value: 4.5, currency: 'CNY' }],
    };
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes('/api/balance-runners')) return Response.json({ success: true, capabilities: {} });
      if (value.includes('/api/carrier-billing/accounts')) {
        return Response.json({
          success: true,
          accounts: [{
            id: 'account-1',
            payment_due_count: 1,
            notification_sim: { iccid: postpaid.iccid, sim_index: 79 },
            linked_sims: [{ iccid: postpaid.iccid, sim_index: 79 }],
          }],
        });
      }
      throw new Error(`Unexpected request: ${value}`);
    };
    try {
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
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not offer a prepaid balance query for postpaid SIMs', () => {
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
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check] },
    });

    await fireEvent.click(view.getByRole('button', { name: '查询记录' }));
    expect(view.getAllByText('已解析').length).toBeGreaterThan(0);
    expect(view.getAllByText('China Mobile').length).toBeGreaterThan(0);
    expect(view.getAllByRole('button', { name: '详情' }).length).toBeGreaterThan(0);
  });

  test('shows single and batch query controls only to authorised users', async () => {
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
    const originalFetch = globalThis.fetch;
    let queued = 0;
    globalThis.fetch = async (url, options = {}) => {
      const value = String(url);
      if (value.includes('/api/balance-runners')) {
        return Response.json({ success: true, capabilities: {} });
      }
      if (value.includes('/api/balance-checks/query-preflight')) {
        return Response.json({
          success: true,
          eligible: true,
          method: { category: 'sms_ai', capability: 'sms_ai', interactive: false },
          runner: { required: true, available: false, state: 'offline' },
        });
      }
      if (value.includes('/api/balance-checks/query') && options.method === 'POST') {
        queued += 1;
        return Response.json({ success: true }, { status: 202 });
      }
      throw new Error(`Unexpected request: ${value}`);
    };
    try {
      const view = render(BalanceManagement, {
        props: { phoneNumbers: [phone], balanceChecks: [check], canQueryBalances: true },
      });
      await fireEvent.click(view.getAllByRole('button', { name: '查询' })[0]);
      await waitFor(() => expect(view.getByText('查询助手未就绪')).toBeTruthy());
      expect(view.getByRole('link', { name: '打开查询助手' }).getAttribute('href'))
        .toBe('message-dashboard-runner://open');
      expect(queued).toBe(0);
      await fireEvent.click(view.getByRole('button', { name: '仍然排队' }));
      await waitFor(() => expect(queued).toBe(1));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('warns about human verification before queueing an available browser query', async () => {
    const originalFetch = globalThis.fetch;
    let queued = 0;
    globalThis.fetch = async (url, options = {}) => {
      const value = String(url);
      if (value.includes('/api/balance-runners')) {
        return Response.json({ success: true, capabilities: {} });
      }
      if (value.includes('/api/balance-checks/query-preflight')) {
        return Response.json({
          success: true,
          eligible: true,
          method: { category: 'browser', capability: 'carrier_browser', interactive: true },
          runner: { required: true, available: true, state: 'ready' },
        });
      }
      if (value.includes('/api/balance-checks/query') && options.method === 'POST') {
        queued += 1;
        return Response.json({ success: true }, { status: 202 });
      }
      throw new Error(`Unexpected request: ${value}`);
    };
    try {
      const view = render(BalanceManagement, {
        props: { phoneNumbers: [phone], balanceChecks: [check], canQueryBalances: true },
      });
      await fireEvent.click(view.getAllByRole('button', { name: '查询' })[0]);
      await waitFor(() => expect(view.getByText('浏览器查询确认')).toBeTruthy());
      expect(view.getByText(/滑块或图片验证/)).toBeTruthy();
      expect(queued).toBe(0);
      await fireEvent.click(view.getByRole('button', { name: '开始查询' }));
      await waitFor(() => expect(queued).toBe(1));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('keeps browser jobs out of a batch until explicitly selected', async () => {
    const originalFetch = globalThis.fetch;
    let submittedMethods = null;
    let previewScope = null;
    let submittedScope = null;
    globalThis.fetch = async (url, options = {}) => {
      const value = String(url);
      if (value.includes('/api/balance-runners')) {
        return Response.json({ success: true, capabilities: {} });
      }
      if (value.includes('/api/balance-checks/query-preview')) {
        expect(options.method).toBe('POST');
        previewScope = JSON.parse(options.body).phone_iccids;
        return Response.json({
          success: true,
          summary: { eligible: 6, cooldown: 0, offline: 0, unsupported: 0, unverified: 0, total: 6 },
          method_summary: { direct_sms: 1, sms_ai: 2, browser: 3 },
          runner_capabilities: {
            sms_ai: { available: true, state: 'ready' },
            carrier_browser: { available: true, state: 'ready' },
          },
        });
      }
      if (value.includes('/api/balance-checks/query-batch') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        submittedMethods = body.methods;
        submittedScope = body.phone_iccids;
        return Response.json({ success: true, summary: { queued: 6, failed_to_queue: 0 } }, { status: 202 });
      }
      throw new Error(`Unexpected request: ${value}`);
    };
    try {
      const view = render(BalanceManagement, {
        props: { phoneNumbers: [phone], balanceChecks: [check], canQueryBalances: true },
      });
      await fireEvent.click(view.getByRole('button', { name: '批量查询' }));
      await waitFor(() => expect(view.getByRole('button', { name: '确认查询 3 张卡' })).toBeTruthy());
      const browser = view.getByRole('checkbox', { name: /浏览器登录/ });
      expect(browser.checked).toBe(false);
      await fireEvent.click(browser);
      expect(view.getByRole('button', { name: '确认查询 6 张卡' })).toBeTruthy();
      expect(view.getByText(/每张卡都可能需要人工验证/)).toBeTruthy();
      await fireEvent.click(view.getByRole('button', { name: '确认查询 6 张卡' }));
      await waitFor(() => {
        expect(previewScope).toEqual([phone.iccid]);
        expect(submittedMethods).toEqual(['direct_sms', 'sms_ai', 'browser']);
        expect(submittedScope).toEqual(previewScope);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('uses the current filters as the default batch scope', async () => {
    const originalFetch = globalThis.fetch;
    const unicomPhone = {
      ...phone,
      iccid: '89860117811049221140',
      sim_index: 3,
      number: '+8618600000000',
      carrier: 'China Unicom',
    };
    let previewScope = null;
    globalThis.fetch = async (url, options = {}) => {
      const value = String(url);
      if (value.includes('/api/balance-runners')) {
        return Response.json({ success: true, capabilities: {} });
      }
      if (value.includes('/api/balance-checks/query-preview')) {
        previewScope = JSON.parse(options.body).phone_iccids;
        return Response.json({
          success: true,
          summary: { eligible: 1, cooldown: 0, offline: 0, unsupported: 0, unverified: 0, total: 1 },
          method_summary: { direct_sms: 0, sms_ai: 0, browser: 1 },
          runner_capabilities: { carrier_browser: { available: true, state: 'ready' } },
        });
      }
      throw new Error(`Unexpected request: ${value}`);
    };
    try {
      const view = render(BalanceManagement, {
        props: { phoneNumbers: [phone, unicomPhone], balanceChecks: [], canQueryBalances: true },
      });
      const carrierFilter = view.getByLabelText('运营商筛选');
      carrierFilter.value = 'china-unicom';
      await fireEvent.change(carrierFilter);
      await fireEvent.click(view.getByRole('button', { name: '批量查询' }));

      await waitFor(() => expect(previewScope).toEqual([unicomPhone.iccid]));
      expect(view.getByText(/查询范围：/).parentElement.textContent).toContain('联通');
      expect(view.getByText('范围内卡数')).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('uses manually selected cards instead of the visible filter scope', async () => {
    const originalFetch = globalThis.fetch;
    const unicomPhone = {
      ...phone,
      iccid: '89860117811049221140',
      sim_index: 3,
      number: '+8618600000000',
      carrier: 'China Unicom',
    };
    let previewScope = null;
    globalThis.fetch = async (url, options = {}) => {
      const value = String(url);
      if (value.includes('/api/balance-runners')) {
        return Response.json({ success: true, capabilities: {} });
      }
      if (value.includes('/api/balance-checks/query-preview')) {
        previewScope = JSON.parse(options.body).phone_iccids;
        return Response.json({
          success: true,
          summary: { eligible: 1, cooldown: 0, offline: 0, unsupported: 0, unverified: 0, total: 1 },
          method_summary: { direct_sms: 1, sms_ai: 0, browser: 0 },
          runner_capabilities: {},
        });
      }
      throw new Error(`Unexpected request: ${value}`);
    };
    try {
      const view = render(BalanceManagement, {
        props: { phoneNumbers: [phone, unicomPhone], balanceChecks: [], canQueryBalances: true },
      });
      await fireEvent.click(view.getByRole('checkbox', { name: '选择 S02' }));
      expect(view.getByText('已选 1 张')).toBeTruthy();

      const carrierFilter = view.getByLabelText('运营商筛选');
      carrierFilter.value = 'china-unicom';
      await fireEvent.change(carrierFilter);
      await fireEvent.click(view.getByRole('button', { name: '批量查询' }));

      await waitFor(() => expect(previewScope).toEqual([phone.iccid]));
      expect(view.getByText(/手动选择 1 张卡/)).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('renders the compact mobile balance row and mobile-first search controls', () => {
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check], canQueryBalances: true },
    });

    expect(view.container.querySelectorAll('[data-mobile-balance-row]')).toHaveLength(1);
    expect(view.getByRole('searchbox', { name: '搜索 SIM' }).placeholder).toBe('卡号 / 手机号 / ICCID');
    expect(view.getByRole('button', { name: '查询 S02 余额' })).toBeTruthy();
  });

  test('toggles overview and history table sorting from the column headers', async () => {
    const view = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check] },
    });

    const simSort = view.getByRole('button', { name: '按SIM升序排列' });
    await fireEvent.click(simSort);
    expect(view.getByRole('button', { name: '按SIM降序排列' })).toBeTruthy();

    await fireEvent.click(view.getByRole('button', { name: '查询记录' }));
    const timeSort = view.getByRole('button', { name: '按时间升序排列' });
    await fireEvent.click(timeSort);
    expect(view.getByRole('button', { name: '按时间降序排列' })).toBeTruthy();
  });

  test('filters both the overview and query history by carrier', async () => {
    const unicomPhone = {
      ...phone,
      iccid: '89860117811049221140',
      sim_index: 3,
      number: '+8618600000000',
      carrier: 'China Unicom',
    };
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

    const carrierFilter = view.getByLabelText('运营商筛选');
    carrierFilter.value = 'china-unicom';
    await fireEvent.change(carrierFilter);
    await waitFor(() => expect(view.container.querySelectorAll('tbody tr')).toHaveLength(1));
    let rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('S03');
    expect(rows[0].textContent).not.toContain('S02');

    await fireEvent.click(view.getByRole('button', { name: '查询记录' }));
    rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('S03');
    expect(rows[0].textContent).not.toContain('S02');
  });

  test('filters Hong Kong Mobile separately from mainland China Mobile', async () => {
    const cmhkPhone = {
      ...phone,
      iccid: '89852000000000000001',
      sim_index: 3,
      number: '+85260000000',
      country: 'HK',
      carrier: '移动',
      flag: '🇭🇰',
    };
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

    const carrierFilter = view.getByLabelText('运营商筛选');
    expect([...carrierFilter.options].map((option) => option.textContent)).toEqual(
      expect.arrayContaining(['移动', 'CMHK']),
    );

    carrierFilter.value = 'cmhk';
    await fireEvent.change(carrierFilter);
    let rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('S03');
    expect(rows[0].textContent).not.toContain('S02');

    await fireEvent.click(view.getByRole('button', { name: '查询记录' }));
    rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('S03');
    expect(rows[0].textContent).not.toContain('S02');
  });
});
