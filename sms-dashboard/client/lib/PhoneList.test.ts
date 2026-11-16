import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import type { Phone } from '../../shared/api/phones.js';
import PhoneList from './PhoneList.svelte';

type ListedPhone = Phone & { flag: string };

interface Handed {
  iccid: string;
}

function phone(overrides: Partial<ListedPhone> = {}): ListedPhone {
  return {
    id: 'phone-1',
    imei: null,
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
    manufacturer: null,
    model: null,
    usb_port: null,
    usb_path: null,
    last_usb_path: null,
    modem_status: null,
    sim_index: 5,
    notes: null,
    created_at: null,
    updated_at: null,
    flag: '🇨🇳',
    ...overrides,
  };
}

const fleet: ListedPhone[] = [
  phone({ id: 'p-9', iccid: 'ICCID-09', sim_index: 9, number: '+8613000000009' }),
  phone({
    id: 'p-3',
    iccid: 'ICCID-03',
    sim_index: 3,
    number: '+6591110003',
    country: 'SG',
    carrier: 'Singtel',
    operator: null,
    flag: '🇸🇬',
  }),
  phone({
    id: 'p-7',
    iccid: 'ICCID-07',
    sim_index: 7,
    status: 'offline',
    number: '+8613000000007',
    signal: null,
  }),
  phone({
    id: 'p-1',
    iccid: 'ICCID-01',
    sim_index: 1,
    status: 'sim_error',
    number: '+8613000000001',
  }),
  phone({
    id: 'p-2',
    iccid: 'ICCID-02',
    sim_index: 2,
    status: 'active',
    number: '+8613000000002',
  }),
];

afterEach(cleanup);

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="button"]'));
}

function cardsInOrder(container: HTMLElement): string[] {
  return rows(container).map(
    (row) => row.querySelector('span.font-mono')?.textContent.trim() ?? '',
  );
}

describe('PhoneList desktop panel', () => {
  test('clips its contents to the rounded panel boundary', () => {
    const view = render(PhoneList, { props: { phoneNumbers: [] } });

    const panel = view.container.firstElementChild;
    expect(panel).toBeInstanceOf(HTMLElement);
    expect(panel?.classList).toContain('rounded-xl');
    expect(panel?.classList).toContain('overflow-hidden');
  });

  test('lists cards by status then card number', () => {
    const view = render(PhoneList, { props: { phoneNumbers: fleet } });

    expect(cardsInOrder(view.container)).toEqual(['S02', 'S03', 'S09', 'S07', 'S01']);
  });

  test('shows each card with its flag, number and carrier', () => {
    const view = render(PhoneList, { props: { phoneNumbers: fleet } });

    expect(view.getByText('+6591110003')).toBeTruthy();
    expect(view.getByText('🇸🇬')).toBeTruthy();
    expect(view.getByText('Singtel')).toBeTruthy();
    expect(view.getByText('ICCID-03', { exact: false })).toBeTruthy();
  });

  test('names a faulted card status on its row', () => {
    const view = render(PhoneList, { props: { phoneNumbers: fleet } });

    expect(view.getByText('读卡失败')).toBeTruthy();
    expect(view.queryByText('待映射')).toBeNull();
  });

  test('says the list could not load when there are no cards', () => {
    const view = render(PhoneList, { props: { phoneNumbers: [] } });

    expect(view.getByText('无法加载设备数据')).toBeTruthy();
  });

  test('shows placeholders instead of cards while loading', () => {
    const view = render(PhoneList, { props: { phoneNumbers: fleet, isLoading: true } });

    expect(rows(view.container)).toHaveLength(0);
    expect(view.queryByText('无法加载设备数据')).toBeNull();
    expect(view.container.querySelectorAll('.animate-pulse')).toHaveLength(5);
  });
});

describe('PhoneList selection', () => {
  test('selecting a card hands it to the callback and clicking it again clears it', async () => {
    const picked: (Handed | null)[] = [];
    const view = render(PhoneList, {
      props: {
        phoneNumbers: fleet,
        onSelectPhone: (value: Handed | null) => {
          picked.push(value);
        },
      },
    });

    const target = rows(view.container)[1];
    if (!target) throw new Error('no row rendered');
    await fireEvent.click(target);
    await fireEvent.click(target);

    expect(picked).toEqual([fleet[1] ?? null, null]);
  });

  test('Enter selects the focused card', async () => {
    const picked: (Handed | null)[] = [];
    const view = render(PhoneList, {
      props: {
        phoneNumbers: fleet,
        onSelectPhone: (value: Handed | null) => {
          picked.push(value);
        },
      },
    });

    const target = rows(view.container)[0];
    if (!target) throw new Error('no row rendered');
    await fireEvent.keyDown(target, { key: 'a' });
    expect(picked).toHaveLength(0);
    await fireEvent.keyDown(target, { key: 'Enter' });

    expect(picked).toEqual([fleet[4] ?? null]);
  });

  test('on mobile a selected card stays selected when tapped again', async () => {
    const picked: (Handed | null)[] = [];
    const view = render(PhoneList, {
      props: {
        phoneNumbers: fleet,
        mobile: true,
        onSelectPhone: (value: Handed | null) => {
          picked.push(value);
        },
      },
    });

    const target = rows(view.container).find((row) => row.textContent.includes('S03'));
    if (!target) throw new Error('no row rendered');
    await fireEvent.click(target);
    await fireEvent.click(target);

    expect(picked).toEqual([fleet[1] ?? null, fleet[1] ?? null]);
  });

  test('on mobile the all-devices row clears the selection', async () => {
    const picked: (Handed | null)[] = [];
    const view = render(PhoneList, {
      props: {
        phoneNumbers: fleet,
        mobile: true,
        selectedPhoneIccid: 'ICCID-03',
        onSelectPhone: (value: Handed | null) => {
          picked.push(value);
        },
      },
    });

    await fireEvent.click(view.getByText('全部设备'));

    expect(picked).toEqual([null]);
  });

  test('the all-devices row exists only on mobile', () => {
    const desktop = render(PhoneList, { props: { phoneNumbers: fleet } });

    expect(desktop.queryByText('全部设备')).toBeNull();
  });

  test('a card with no number offers a mapping without selecting it', async () => {
    const picked: (Handed | null)[] = [];
    const mapped: Handed[] = [];
    const unmapped = phone({ iccid: 'ICCID-40', sim_index: 40, number: '', status: 'unassigned' });
    const view = render(PhoneList, {
      props: {
        phoneNumbers: [unmapped],
        onSelectPhone: (value: Handed | null) => {
          picked.push(value);
        },
        onSetIccidMapping: (value: Handed) => {
          mapped.push(value);
        },
      },
    });

    expect(view.getByText('未设置号码')).toBeTruthy();
    await fireEvent.click(view.getByText('映射'));

    expect(mapped).toEqual([unmapped]);
    expect(picked).toHaveLength(0);
  });

  test('no mapping button without a handler or an ICCID', () => {
    const withoutHandler = render(PhoneList, {
      props: { phoneNumbers: [phone({ number: '' })] },
    });
    expect(withoutHandler.queryByText('映射')).toBeNull();
    cleanup();

    const withoutIccid = render(PhoneList, {
      props: {
        phoneNumbers: [phone({ number: '', iccid: '' })],
        onSetIccidMapping: () => undefined,
      },
    });
    expect(withoutIccid.queryByText('映射')).toBeNull();
  });
});

describe('PhoneList filtering', () => {
  test('chips count cards by status and hide the empty buckets', () => {
    const view = render(PhoneList, { props: { phoneNumbers: fleet } });

    expect(view.getByRole('button', { name: '全部 5' })).toBeTruthy();
    expect(view.getByRole('button', { name: '在线 3' })).toBeTruthy();
    expect(view.getByRole('button', { name: '离线 1' })).toBeTruthy();
    expect(view.getByRole('button', { name: '异常 1' })).toBeTruthy();
    cleanup();

    const healthy = render(PhoneList, { props: { phoneNumbers: [phone()] } });
    expect(healthy.queryByRole('button', { name: /^离线/ })).toBeNull();
    expect(healthy.queryByRole('button', { name: /^异常/ })).toBeNull();
  });

  test('a status chip narrows the list without changing the counts', async () => {
    const view = render(PhoneList, { props: { phoneNumbers: fleet } });

    await fireEvent.click(view.getByRole('button', { name: '异常 1' }));
    expect(cardsInOrder(view.container)).toEqual(['S01']);
    expect(view.getByRole('button', { name: '在线 3' })).toBeTruthy();

    await fireEvent.click(view.getByRole('button', { name: '离线 1' }));
    expect(cardsInOrder(view.container)).toEqual(['S07']);

    await fireEvent.click(view.getByRole('button', { name: '在线 3' }));
    expect(cardsInOrder(view.container)).toEqual(['S02', 'S03', 'S09']);

    await fireEvent.click(view.getByRole('button', { name: '全部 5' }));
    expect(rows(view.container)).toHaveLength(5);
  });

  test('the country filter keeps cards of that country, inferred from the number when unset', () => {
    const view = render(PhoneList, {
      props: {
        phoneNumbers: [
          ...fleet,
          phone({ iccid: 'ICCID-50', sim_index: 50, country: null, number: '+6598765432' }),
        ],
        selectedCountry: 'SG',
      },
    });

    expect(cardsInOrder(view.container)).toEqual(['S03', 'S50']);
  });

  test('searching waits for a pause, then matches card, number, carrier, ICCID or operator', async () => {
    const view = render(PhoneList, { props: { phoneNumbers: fleet } });
    const box = view.getByPlaceholderText('卡号 / 号码 / 运营商 / ICCID');

    await fireEvent.input(box, { target: { value: 'singtel' } });
    expect(rows(view.container)).toHaveLength(5);
    await waitFor(() => {
      expect(cardsInOrder(view.container)).toEqual(['S03']);
    });

    await fireEvent.input(box, { target: { value: 's09' } });
    await waitFor(() => {
      expect(cardsInOrder(view.container)).toEqual(['S09']);
    });

    await fireEvent.input(box, { target: { value: '0000007' } });
    await waitFor(() => {
      expect(cardsInOrder(view.container)).toEqual(['S07']);
    });

    await fireEvent.input(box, { target: { value: 'iccid-01' } });
    await waitFor(() => {
      expect(cardsInOrder(view.container)).toEqual(['S01']);
    });

    await fireEvent.input(box, { target: { value: 'chn-unicom' } });
    await waitFor(() => {
      expect(rows(view.container)).toHaveLength(4);
    });
  });

  test('a search with no match can be cleared', async () => {
    const view = render(PhoneList, { props: { phoneNumbers: fleet } });
    const box = view.getByPlaceholderText('卡号 / 号码 / 运营商 / ICCID');
    if (!(box instanceof HTMLInputElement)) throw new Error('search is not an input');

    await fireEvent.input(box, { target: { value: 'nothing-like-this' } });
    await waitFor(() => {
      expect(view.getByText('无匹配设备')).toBeTruthy();
    });

    await fireEvent.click(view.getByText('清除筛选'));

    expect(box.value).toBe('');
    expect(rows(view.container)).toHaveLength(5);
  });

  test('clearing the filters also resets the status chip', async () => {
    const view = render(PhoneList, { props: { phoneNumbers: fleet } });

    await fireEvent.click(view.getByRole('button', { name: '异常 1' }));
    await fireEvent.input(view.getByPlaceholderText('卡号 / 号码 / 运营商 / ICCID'), {
      target: { value: 'singtel' },
    });
    await waitFor(() => {
      expect(view.getByText('无匹配设备')).toBeTruthy();
    });

    await fireEvent.click(view.getByText('清除筛选'));

    expect(rows(view.container)).toHaveLength(5);
  });

  test('on mobile an ICCID shows only when the search matched it', async () => {
    const view = render(PhoneList, { props: { phoneNumbers: fleet, mobile: true } });
    expect(view.queryByText('ICCID-03', { exact: false })).toBeNull();

    await fireEvent.input(view.getByPlaceholderText('卡号 / 号码 / 运营商 / ICCID'), {
      target: { value: 'iccid-03' },
    });

    await waitFor(() => {
      expect(view.getByText('ICCID-03', { exact: false })).toBeTruthy();
    });
  });
});
