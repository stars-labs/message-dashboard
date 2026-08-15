import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import BalanceManagement from './BalanceManagement.svelte';

const phone = {
  iccid: '89860117811049221139',
  sim_index: 2,
  number: '+8613520607015',
  country: 'CN',
  carrier: 'China Mobile',
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
  test('shows runner capability health from the control plane', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      expect(String(url)).toContain('/api/balance-runners');
      return new Response(JSON.stringify({
        success: true,
        capabilities: {
          sms_ai: { available: true, state: 'ready' },
          unicom_browser: {
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
    expect(view.getAllByText('正常').length).toBeGreaterThan(0);

    await fireEvent.click(view.getByRole('button', { name: '查看' }));
    expect(opened).toBe(check);
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
          method: { category: 'browser', capability: 'unicom_browser', interactive: true },
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
            unicom_browser: { available: true, state: 'ready' },
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
          runner_capabilities: { unicom_browser: { available: true, state: 'ready' } },
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
});
