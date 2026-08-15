import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import IccidMappings from './IccidMappings.svelte';

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('Device & Card sorting', () => {
  test('sorts rows by a clicked column and toggles direction', async () => {
    globalThis.fetch = async () => Response.json({
      success: true,
      data: {
        results: [
          { id: 'ten', iccid: 'iccid-10', phone_number: '+8610', carrier: '移动', country: 'CN', sim_index: 10, is_active: 'active' },
          { id: 'two', iccid: 'iccid-02', phone_number: '+8602', carrier: '联通', country: 'CN', sim_index: 2, is_active: 'active' },
        ],
      },
    });

    const view = render(IccidMappings);
    await waitFor(() => expect(view.getAllByText('S10').length).toBeGreaterThan(0));

    await fireEvent.click(view.getByRole('button', { name: '按卡号升序排列' }));
    let rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows[0].textContent).toContain('S02');

    await fireEvent.click(view.getByRole('button', { name: '按卡号降序排列' }));
    rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows[0].textContent).toContain('S10');
  });

  test('filters mappings by carrier', async () => {
    globalThis.fetch = async () => Response.json({
      success: true,
      data: {
        results: [
          { id: 'mobile', iccid: 'mobile-iccid', phone_number: '+86135', carrier: '移动', country: 'CN', sim_index: 2, is_active: 'active' },
          { id: 'unicom', iccid: 'unicom-iccid', phone_number: '+86186', carrier: '联通', country: 'CN', sim_index: 3, is_active: 'active' },
        ],
      },
    });

    const view = render(IccidMappings);
    await waitFor(() => expect(view.getAllByText('S02').length).toBeGreaterThan(0));

    const carrierFilter = view.getByLabelText('运营商筛选');
    carrierFilter.value = 'china-unicom';
    await fireEvent.change(carrierFilter);

    await waitFor(() => expect(view.container.querySelectorAll('tbody tr')).toHaveLength(1));
    const rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('S03');
    expect(rows[0].textContent).toContain('🇨🇳');
    expect(rows[0].textContent).toContain('联通');
    expect(rows[0].textContent).not.toContain('S02');
  });
});
