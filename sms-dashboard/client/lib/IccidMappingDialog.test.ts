import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { CreateIccidMappingResponse } from '../../shared/api/iccid-mappings.js';
import type { Phone } from '../../shared/api/phones.js';
import { auth } from './auth.js';
import IccidMappingDialog from './IccidMappingDialog.svelte';

type SavedMapping = NonNullable<CreateIccidMappingResponse['data']>;

const originalBaseUrl = auth.baseUrl;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  auth.baseUrl = originalBaseUrl;
});

function stubFetch(handler: (input: string | URL | Request, init?: RequestInit) => Response): void {
  auth.baseUrl = 'https://example.com';
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (input: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(input, init)),
      { preconnect: () => undefined },
    ),
  );
}

function phone(overrides: Partial<Phone> = {}): Phone {
  return {
    id: 'phone-1',
    imei: '867012345678901',
    iccid: '898600520121F0517883',
    number: '+8613520607015',
    country: 'CN',
    carrier: 'China Mobile',
    service_type: 'unknown',
    service_type_source: null,
    service_type_verified_at: null,
    sim_role: 'standalone',
    primary_iccid: null,
    balance_threshold: null,
    status: 'active',
    signal: 71,
    operator: null,
    manufacturer: null,
    model: null,
    usb_port: null,
    usb_path: null,
    last_usb_path: null,
    modem_status: null,
    sim_index: 5,
    notes: 'rack 2',
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function saved(overrides: Partial<SavedMapping> = {}): SavedMapping {
  return {
    iccid: '898600520121F0517883',
    sim_index: 5,
    phone_number: '+8613520607015',
    country_code: 'CN',
    carrier: 'China Mobile',
    imei: '867012345678901',
    notes: 'rack 2',
    service_type: 'unknown',
    service_type_source: null,
    service_type_verified_at: null,
    sim_role: 'standalone',
    primary_iccid: null,
    balance_threshold: null,
    status: 'active',
    usb_path: null,
    last_usb_path: null,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function savedResponse(overrides: Partial<SavedMapping> = {}): Response {
  const body: CreateIccidMappingResponse = { success: true, data: saved(overrides) };
  return Response.json(body);
}

function field<T extends HTMLElement>(element: HTMLElement, type: new () => T): T {
  if (!(element instanceof type)) throw new Error('unexpected element type');
  return element;
}

function sentBody(): unknown {
  const call = fetchSpy?.mock.calls[0];
  const body = call?.[1]?.body;
  if (typeof body !== 'string') throw new Error('no request body was sent');
  const parsed: unknown = JSON.parse(body);
  return parsed;
}

function open(props: Partial<{ phone: Phone | null; show: boolean }> = {}) {
  const saves: unknown[] = [];
  let closes = 0;
  const view = render(IccidMappingDialog, {
    props: {
      phone: phone(),
      show: true,
      onsuccess: (value: unknown) => {
        saves.push(value);
      },
      onclose: () => {
        closes += 1;
      },
      ...props,
    },
  });
  return { view, saves, closeCount: () => closes };
}

describe('IccidMappingDialog form', () => {
  test('renders nothing when hidden or without a phone', () => {
    const hidden = open({ show: false });
    expect(hidden.view.queryByRole('dialog')).toBeNull();
    cleanup();

    const empty = open({ phone: null });
    expect(empty.view.queryByRole('dialog')).toBeNull();
  });

  test('fills the form from the phone and locks the ICCID', () => {
    const { view } = open();

    expect(view.getByRole('dialog', { name: '设置 ICCID 映射' })).toBeTruthy();
    expect(field(view.getByLabelText('ICCID'), HTMLInputElement).value).toBe(
      '898600520121F0517883',
    );
    expect(field(view.getByLabelText('ICCID'), HTMLInputElement).disabled).toBe(true);
    expect(field(view.getByLabelText(/电话号码/), HTMLInputElement).value).toBe('+8613520607015');
    expect(field(view.getByLabelText('国家'), HTMLSelectElement).value).toBe('CN');
    expect(field(view.getByLabelText('运营商'), HTMLInputElement).value).toBe('China Mobile');
    expect(field(view.getByLabelText(/SIM 索引/), HTMLInputElement).value).toBe('5');
    expect(field(view.getByLabelText(/IMEI/), HTMLInputElement).value).toBe('867012345678901');
    expect(field(view.getByLabelText('备注'), HTMLTextAreaElement).value).toBe('rack 2');
    expect(view.getByText('✓ 活动')).toBeTruthy();
  });

  test('starts an unmapped card with an empty number and no country', () => {
    const { view } = open({ phone: phone({ country: 'CN', number: '' }) });

    expect(field(view.getByLabelText(/电话号码/), HTMLInputElement).value).toBe('');
    expect(field(view.getByLabelText('国家'), HTMLSelectElement).value).toBe('CN');
  });

  test('shows an inactive status for a card that is not active', () => {
    const { view } = open({ phone: phone({ status: 'offline' }) });

    expect(view.getByText('○ 未激活')).toBeTruthy();
  });

  test('confirmation source is locked until a billing type is known', () => {
    const unknown = open();
    expect(field(unknown.view.getByLabelText('确认来源'), HTMLSelectElement).disabled).toBe(true);
    cleanup();

    const managed = open({ phone: phone({ service_type: 'balance_managed' }) });
    expect(field(managed.view.getByLabelText('确认来源'), HTMLSelectElement).disabled).toBe(true);
    cleanup();

    const prepaid = open({
      phone: phone({ service_type: 'prepaid', service_type_source: 'carrier_support' }),
    });
    const source = field(prepaid.view.getByLabelText('确认来源'), HTMLSelectElement);
    expect(source.disabled).toBe(false);
    expect(source.value).toBe('carrier_support');
  });

  test('asks for the primary ICCID only on a secondary card', () => {
    const standalone = open();
    expect(standalone.view.queryByLabelText('主卡 ICCID')).toBeNull();
    cleanup();

    const secondary = open({ phone: phone({ sim_role: 'secondary', primary_iccid: 'PRIMARY-1' }) });
    expect(field(secondary.view.getByLabelText('主卡 ICCID'), HTMLInputElement).value).toBe(
      'PRIMARY-1',
    );
  });
});

describe('IccidMappingDialog validation', () => {
  test('requires a phone number', async () => {
    stubFetch(() => savedResponse());
    const { view, saves } = open();

    await fireEvent.input(view.getByLabelText(/电话号码/), { target: { value: '   ' } });
    await fireEvent.click(view.getByText('保存'));

    expect(view.getByText('请输入电话号码')).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(saves).toHaveLength(0);
  });

  test('requires a SIM index from 1 to 95', async () => {
    stubFetch(() => savedResponse());
    const { view } = open();
    const index = view.getByLabelText(/SIM 索引/);

    for (const value of ['', '0', '-5', '96']) {
      await fireEvent.input(index, { target: { value } });
      await fireEvent.click(view.getByText('保存'));
      expect(view.getByText('请输入有效的 SIM 索引 (1-95)')).toBeTruthy();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  test('requires a confirmation source for a known billing type', async () => {
    stubFetch(() => savedResponse());
    const { view } = open({
      phone: phone({ service_type: 'postpaid', service_type_source: null }),
    });

    await fireEvent.click(view.getByText('保存'));

    expect(view.getByText('请选择计费类型的确认来源')).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe('IccidMappingDialog saving', () => {
  test('sends the form, hands the saved card to the caller and closes', async () => {
    stubFetch(() => savedResponse({ phone_number: '+8613520607016', carrier: 'China Unicom' }));
    const { view, saves, closeCount } = open();

    await fireEvent.input(view.getByLabelText(/电话号码/), { target: { value: '+8613520607016' } });
    await fireEvent.input(view.getByLabelText('运营商'), { target: { value: 'China Unicom' } });
    await fireEvent.input(view.getByLabelText(/SIM 索引/), { target: { value: '12' } });
    await fireEvent.click(view.getByText('保存'));

    await waitFor(() => {
      expect(closeCount()).toBe(1);
    });
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    expect(fetchSpy?.mock.calls[0]?.[0]).toBe('https://example.com/api/iccid-mappings');
    expect(sentBody()).toEqual({
      iccid: '898600520121F0517883',
      phone_number: '+8613520607016',
      sim_index: 12,
      country_code: 'CN',
      carrier: 'China Unicom',
      imei: '867012345678901',
      notes: 'rack 2',
      service_type: 'unknown',
      service_type_source: null,
      sim_role: 'standalone',
      primary_iccid: null,
    });
    expect(saves).toEqual([
      {
        phone_iccid: '898600520121F0517883',
        ...saved({ phone_number: '+8613520607016', carrier: 'China Unicom' }),
      },
    ]);
    expect(closeCount()).toBe(1);
  });

  test('sends empty optional fields as null', async () => {
    stubFetch(() => savedResponse());
    const { view } = open({
      phone: phone({ country: 'CN', carrier: null, imei: null, notes: null }),
    });

    await fireEvent.click(view.getByText('保存'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    expect(sentBody()).toMatchObject({
      country_code: 'CN',
      carrier: null,
      imei: null,
      notes: null,
    });
  });

  test('sends the confirmed billing type with its source', async () => {
    stubFetch(() => savedResponse());
    const { view } = open({
      phone: phone({ service_type: 'prepaid', service_type_source: 'contract_or_bill' }),
    });

    await fireEvent.click(view.getByText('保存'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    expect(sentBody()).toMatchObject({
      service_type: 'prepaid',
      service_type_source: 'contract_or_bill',
    });
  });

  test('a secondary card sends its primary ICCID', async () => {
    stubFetch(() => savedResponse({ sim_role: 'secondary', primary_iccid: 'PRIMARY-1' }));
    const { view, saves } = open({ phone: phone({ sim_role: 'secondary', primary_iccid: null }) });

    await fireEvent.input(view.getByLabelText('主卡 ICCID'), { target: { value: 'PRIMARY-1' } });
    await fireEvent.click(view.getByText('保存'));

    await waitFor(() => {
      expect(saves).toHaveLength(1);
    });
    expect(sentBody()).toMatchObject({ sim_role: 'secondary', primary_iccid: 'PRIMARY-1' });
    expect(saves[0]).toMatchObject({ sim_role: 'secondary', primary_iccid: 'PRIMARY-1' });
  });

  test('a standalone card never sends a primary ICCID', async () => {
    stubFetch(() => savedResponse());
    const { view } = open({ phone: phone({ primary_iccid: 'STALE-PRIMARY' }) });

    await fireEvent.click(view.getByText('保存'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    expect(sentBody()).toMatchObject({ primary_iccid: null });
  });

  test('a failed save shows the reason and keeps the dialog open', async () => {
    stubFetch(() => Response.json({ error: '卡号已被占用' }, { status: 409 }));
    const { view, saves, closeCount } = open();

    await fireEvent.click(view.getByText('保存'));

    await waitFor(() => {
      expect(view.getByText(/卡号已被占用/)).toBeTruthy();
    });
    expect(view.getByRole('dialog')).toBeTruthy();
    expect(field(view.getByText('保存'), HTMLButtonElement).disabled).toBe(false);
    expect(saves).toHaveLength(0);
    expect(closeCount()).toBe(0);
  });

  test('the save button is disabled while the request is in flight', async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    auth.baseUrl = 'https://example.com';
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(() => pending, { preconnect: () => undefined }),
    );
    const { view, closeCount } = open();

    await fireEvent.click(view.getByText('保存'));

    await waitFor(() => {
      expect(view.getByText('保存中...')).toBeTruthy();
    });
    expect(field(view.getByText('取消'), HTMLButtonElement).disabled).toBe(true);
    release(savedResponse());
    await waitFor(() => {
      expect(closeCount()).toBe(1);
    });
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('IccidMappingDialog dismissing', () => {
  test('cancel closes without saving', async () => {
    stubFetch(() => savedResponse());
    const { view, saves, closeCount } = open();

    await fireEvent.click(view.getByText('取消'));

    expect(view.queryByRole('dialog')).toBeNull();
    expect(closeCount()).toBe(1);
    expect(saves).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  test('Escape closes it', async () => {
    const { view, closeCount } = open();

    await fireEvent.keyDown(document, { key: 'Escape' });

    expect(view.queryByRole('dialog')).toBeNull();
    expect(closeCount()).toBe(1);
  });
});
