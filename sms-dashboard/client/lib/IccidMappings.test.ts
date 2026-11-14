import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { IccidMapping, IccidMappingsResponse } from '../../shared/api/iccid-mappings.js';
import IccidMappings from './IccidMappings.svelte';

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

function stubMappings(rows: Parameters<typeof mapping>[0][]): void {
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(() => Promise.resolve(Response.json(mappingsResponse(rows))), {
      preconnect: () => undefined,
    }),
  );
}

// A full GET /api/iccid-mappings row: the fields a test names, the rest empty.
function mapping(
  row: Partial<IccidMapping> & Pick<IccidMapping, 'iccid' | 'phone_number' | 'sim_index'>,
): IccidMapping {
  return {
    id: row.iccid,
    country: null,
    carrier: null,
    service_type: 'unknown',
    service_type_source: null,
    service_type_verified_at: null,
    sim_role: 'standalone',
    primary_iccid: null,
    balance_threshold: null,
    equipment_id: null,
    notes: null,
    is_active: 'active',
    signal_quality: null,
    modem_status: null,
    detected_iccid: null,
    operator: null,
    usb_path: null,
    last_usb_path: null,
    created_at: null,
    updated_at: null,
    ...row,
  };
}

function mappingsResponse(rows: Parameters<typeof mapping>[0][]): IccidMappingsResponse {
  return {
    success: true,
    data: rows.map(mapping),
    pagination: { page: 1, limit: 10000, total: rows.length, totalPages: 1 },
  };
}

function carrierSelect(container: ParentNode): HTMLSelectElement {
  const found = container.querySelector('#mapping-carrier-filter');
  if (!(found instanceof HTMLSelectElement)) throw new Error('no carrier filter rendered');
  return found;
}

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

describe('Device & Card sorting', () => {
  test('keeps the desktop table in its own scroll region', async () => {
    stubMappings([
      {
        id: 'two',
        iccid: 'iccid-02',
        phone_number: '+8602',
        carrier: '联通',
        country: 'CN',
        sim_index: 2,
        is_active: 'active',
      },
    ]);

    const view = render(IccidMappings);
    await waitFor(() => {
      expect(view.getAllByText('S02').length).toBeGreaterThan(0);
    });

    const scrollRegion = view.container.querySelector('[data-desktop-table-scroll]');
    if (!scrollRegion) throw new Error('no scroll region rendered');
    expect(scrollRegion.classList).toContain('lg:flex-1');
    expect(scrollRegion.classList).toContain('lg:min-h-0');
    expect(scrollRegion.classList).toContain('lg:overflow-auto');
  });

  test('sorts rows by a clicked column and toggles direction', async () => {
    stubMappings([
      {
        id: 'ten',
        iccid: 'iccid-10',
        phone_number: '+8610',
        carrier: '移动',
        country: 'CN',
        sim_index: 10,
        is_active: 'active',
      },
      {
        id: 'two',
        iccid: 'iccid-02',
        phone_number: '+8602',
        carrier: '联通',
        country: 'CN',
        sim_index: 2,
        is_active: 'active',
      },
    ]);

    const view = render(IccidMappings);
    await waitFor(() => {
      expect(view.getAllByText('S10').length).toBeGreaterThan(0);
    });

    await fireEvent.click(view.getByRole('button', { name: '按卡号升序排列' }));
    let rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows[0]?.textContent).toContain('S02');

    await fireEvent.click(view.getByRole('button', { name: '按卡号降序排列' }));
    rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows[0]?.textContent).toContain('S10');
  });

  test('filters mappings by carrier', async () => {
    stubMappings([
      {
        id: 'mobile',
        iccid: 'mobile-iccid',
        phone_number: '+86135',
        carrier: '移动',
        country: 'CN',
        sim_index: 2,
        is_active: 'active',
      },
      {
        id: 'unicom',
        iccid: 'unicom-iccid',
        phone_number: '+86186',
        carrier: '联通',
        country: 'CN',
        sim_index: 3,
        is_active: 'active',
      },
    ]);

    const view = render(IccidMappings);
    await waitFor(() => {
      expect(view.getAllByText('S02').length).toBeGreaterThan(0);
    });

    const carrierFilter = carrierSelect(view.container);
    carrierFilter.value = 'china-unicom';
    await fireEvent.change(carrierFilter);

    await waitFor(() => {
      expect(view.container.querySelectorAll('tbody tr')).toHaveLength(1);
    });
    const rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('S03');
    expect(rows[0]?.textContent).toContain('🇨🇳');
    expect(rows[0]?.textContent).toContain('联通');
    expect(rows[0]?.textContent).not.toContain('S02');
  });

  test('filters Hong Kong Mobile separately from mainland China Mobile', async () => {
    stubMappings([
      {
        id: 'cn-mobile',
        iccid: 'cn-mobile-iccid',
        phone_number: '+86135',
        carrier: '移动',
        country: 'CN',
        sim_index: 2,
        is_active: 'active',
      },
      {
        id: 'hk-mobile',
        iccid: 'hk-mobile-iccid',
        phone_number: '+85260000000',
        carrier: '移动',
        country: 'HK',
        sim_index: 3,
        is_active: 'active',
      },
    ]);

    const view = render(IccidMappings);
    await waitFor(() => {
      expect(view.getAllByText('S02').length).toBeGreaterThan(0);
    });

    const carrierFilter = carrierSelect(view.container);
    const optionLabels = [...carrierFilter.options].map((option) => option.textContent);
    expect(optionLabels).toContain('移动');
    expect(optionLabels).toContain('CMHK');
    carrierFilter.value = 'cmhk';
    await fireEvent.change(carrierFilter);

    await waitFor(() => {
      expect(view.container.querySelectorAll('tbody tr')).toHaveLength(1);
    });
    const rows = [...view.container.querySelectorAll('tbody tr')];
    expect(rows[0]?.textContent).toContain('S03');
    expect(rows[0]?.textContent).toContain('🇭🇰');
    expect(rows[0]?.textContent).not.toContain('S02');
  });
});
