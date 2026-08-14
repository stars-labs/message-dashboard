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
});
