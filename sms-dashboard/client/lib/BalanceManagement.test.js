import { cleanup, fireEvent, render } from '@testing-library/svelte';
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

  test('shows single and batch query controls only to authorised users', () => {
    const adminView = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check], canQueryBalances: true },
    });
    expect(adminView.getByRole('button', { name: '批量查询' })).toBeTruthy();
    expect(adminView.getAllByRole('button', { name: '查询' }).length).toBeGreaterThan(0);
    cleanup();

    const viewerView = render(BalanceManagement, {
      props: { phoneNumbers: [phone], balanceChecks: [check], canQueryBalances: false },
    });
    expect(viewerView.queryByRole('button', { name: '批量查询' })).toBeNull();
    expect(viewerView.queryByRole('button', { name: '查询' })).toBeNull();
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
});
