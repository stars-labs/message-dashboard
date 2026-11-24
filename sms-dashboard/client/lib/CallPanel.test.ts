import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import type { CallLogEntry, LiveCall } from '../../shared/api/calls.js';
import type { Phone } from '../../shared/api/phones.js';
import CallPanel from './CallPanel.svelte';

type DialablePhone = Phone & { flag: string };

interface DialRequest {
  iccid: string;
  number: string;
}

afterEach(cleanup);

function phone(overrides: Partial<DialablePhone> = {}): DialablePhone {
  return {
    id: 'phone-1',
    imei: null,
    iccid: '8965012306052373985',
    number: '+6597817169',
    country: 'SG',
    carrier: 'Singtel',
    service_type: 'postpaid',
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
    sim_index: 86,
    notes: null,
    created_at: null,
    updated_at: null,
    flag: '🇸🇬',
    ...overrides,
  };
}

function liveCall(overrides: Partial<LiveCall> = {}): LiveCall {
  return {
    id: 'call-1',
    direction: 'inbound',
    state: 'ringing',
    iccid: '8965012306052373985',
    number: '92953543',
    started_at: new Date().toISOString(),
    ...overrides,
  };
}

function loggedCall(overrides: Partial<CallLogEntry> = {}): CallLogEntry {
  return {
    id: 'c1',
    direction: 'inbound',
    iccid: '8965012306052373985',
    remote_number: '+6592401051',
    outcome: 'missed',
    end_reason: null,
    started_at: new Date().toISOString(),
    answered_at: null,
    ended_at: null,
    duration_seconds: 0,
    requested_by: null,
    answered_by: null,
    sim_index: 86,
    sim_number: null,
    sim_carrier: null,
    ...overrides,
  };
}

// Field names match /api/phones (device_view): `number`, not `phone_number`.
const phones: DialablePhone[] = [
  phone(),
  phone({
    id: 'phone-2',
    iccid: '8965030124051507919',
    number: '+6590421798',
    sim_index: 77,
    carrier: 'M1',
  }),
  phone({
    id: 'phone-3',
    iccid: '8986011781104922113',
    number: '+8617600419127',
    sim_index: 1,
    carrier: '联通',
    country: 'CN',
    flag: '🇨🇳',
  }),
];

interface Texts {
  getByText: (text: string) => HTMLElement;
}

function phoneAt(index: number): DialablePhone {
  const found = phones[index];
  if (!found) throw new Error(`no phone at ${index}`);
  return found;
}

function pickSim(view: Texts, cardNumber: string) {
  return fireEvent.click(view.getByText(cardNumber));
}

function button(view: Texts, text: string): HTMLButtonElement {
  const found = view.getByText(text);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`${text} is not a button`);
  return found;
}

describe('CallPanel dialing', () => {
  test('lists SIMs by card number and phone number, never by raw ICCID', () => {
    const view = render(CallPanel, { props: { phones } });

    expect(view.getByText('S86')).toBeTruthy();
    expect(view.getByText('+6597817169')).toBeTruthy();
    expect(view.container.textContent).not.toContain('8965012306052373985');
  });

  test('searching narrows the SIM list by card number, carrier or number', async () => {
    const view = render(CallPanel, { props: { phones } });

    await fireEvent.input(view.getByLabelText('搜索拨出卡'), { target: { value: 'M1' } });

    expect(view.getByText('S77')).toBeTruthy();
    expect(view.queryByText('S86')).toBeNull();
  });

  test('dial stays disabled until a SIM and a valid number are both chosen', async () => {
    const view = render(CallPanel, { props: { phones } });
    const dial = button(view, '拨打');

    expect(dial.disabled).toBe(true);

    await pickSim(view, 'S77');
    await fireEvent.input(view.getByLabelText('对方号码'), { target: { value: '91234567' } });
    expect(dial.disabled).toBe(true);
    expect(view.container.textContent).toContain('号码需要是国际格式');

    await fireEvent.input(view.getByLabelText('对方号码'), { target: { value: '+6591234567' } });
    expect(dial.disabled).toBe(false);
  });

  test('dials with the chosen SIM and a normalised number', async () => {
    const dialed: DialRequest[] = [];
    const view = render(CallPanel, {
      props: {
        phones,
        onDial: (request: DialRequest) => {
          dialed.push(request);
        },
      },
    });

    await pickSim(view, 'S77');
    await fireEvent.input(view.getByLabelText('对方号码'), {
      target: { value: ' +65 9123-4567 ' },
    });
    await fireEvent.click(view.getByText('拨打'));

    expect(dialed).toEqual([{ iccid: phoneAt(1).iccid, number: '+6591234567' }]);
  });

  test('a SIM with no mapped number cannot be dialled from', () => {
    const view = render(CallPanel, {
      props: { phones: [phone({ iccid: '8965000000000000000', sim_index: 12, number: '' })] },
    });

    expect(view.getByText('没有匹配的卡')).toBeTruthy();
  });

  test('an offline daemon blocks dialing and says why', async () => {
    const view = render(CallPanel, { props: { phones, daemonOnline: false } });

    await pickSim(view, 'S86');
    await fireEvent.input(view.getByLabelText('对方号码'), { target: { value: '+6591234567' } });

    expect(button(view, '拨打').disabled).toBe(true);
    expect(view.container.textContent).toContain('采集服务离线');
  });
});

describe('CallPanel during a call', () => {
  const inbound = liveCall({ iccid: phoneAt(0).iccid });

  test('a ringing inbound call shows the caller, its SIM, answer and reject', async () => {
    const answered: boolean[] = [];
    const hungUp: boolean[] = [];
    const view = render(CallPanel, {
      props: {
        phones,
        call: inbound,
        onAnswer: () => {
          answered.push(true);
        },
        onHangup: () => {
          hungUp.push(true);
        },
      },
    });

    expect(view.getByTestId('call-number').textContent).toBe('92953543');
    expect(view.getByTestId('call-state').textContent).toContain('正在振铃');
    expect(view.container.textContent).toContain('S86');

    await fireEvent.click(view.getByText('拒接'));
    expect(hungUp).toHaveLength(1);

    await fireEvent.click(view.getByText('接听'));
    expect(answered).toHaveLength(1);
    expect(view.queryByText('拨打')).toBeNull();
  });

  test('an active call shows a duration and can be muted', async () => {
    const muted: boolean[] = [];
    const view = render(CallPanel, {
      props: {
        phones,
        call: liveCall({
          direction: 'outbound',
          state: 'active',
          number: '+6591234567',
          iccid: phoneAt(0).iccid,
          started_at: new Date(Date.now() - 65_000).toISOString(),
        }),
        onToggleMute: () => {
          muted.push(true);
        },
      },
    });

    expect(view.getByTestId('call-state').textContent).toContain('01:05');
    await fireEvent.click(view.getByText('静音'));
    expect(muted).toHaveLength(1);
  });

  test('mute is unavailable before the audio path is up', () => {
    const view = render(CallPanel, {
      props: {
        phones,
        call: liveCall({ direction: 'outbound', state: 'connecting', number: '+6591234567' }),
      },
    });

    expect(button(view, '静音').disabled).toBe(true);
    expect(view.queryByText('接听')).toBeNull();
    expect(view.getByText('挂断')).toBeTruthy();
  });

  test('an unknown caller id is shown explicitly rather than blank', () => {
    const view = render(CallPanel, {
      props: { phones, call: { ...inbound, number: null } },
    });
    expect(view.getByTestId('call-number').textContent).toBe('未知号码');
  });

  test('errors are surfaced as an alert', () => {
    const view = render(CallPanel, { props: { phones, error: '另一路通话正在进行' } });
    expect(view.getByRole('alert').textContent).toContain('另一路通话');
  });
});

describe('CallPanel call log', () => {
  const missed = loggedCall({ iccid: phoneAt(0).iccid });
  const history: CallLogEntry[] = [
    missed,
    loggedCall({
      id: 'c2',
      direction: 'outbound',
      outcome: 'answered',
      iccid: phoneAt(1).iccid,
      sim_index: 77,
      remote_number: '+6591234567',
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      answered_at: new Date(Date.now() - 3_590_000).toISOString(),
      duration_seconds: 125,
    }),
  ];

  test('shows missed calls, answered calls and their durations', () => {
    const view = render(CallPanel, { props: { phones, history } });

    expect(view.container.textContent).toContain('未接');
    expect(view.container.textContent).toContain('+6592401051');
    expect(view.container.textContent).toContain('02:05');
  });

  test('says so when there is nothing yet', () => {
    const view = render(CallPanel, { props: { phones, history: [] } });
    expect(view.getByText('还没有通话记录')).toBeTruthy();
  });

  test('tapping a log row loads it back into the dialer', async () => {
    const dialed: DialRequest[] = [];
    const view = render(CallPanel, {
      props: {
        phones,
        history,
        onDial: (request: DialRequest) => {
          dialed.push(request);
        },
      },
    });

    await fireEvent.click(view.getByText('+6592401051'));
    await fireEvent.click(view.getByText('拨打'));

    expect(dialed).toEqual([{ iccid: phoneAt(0).iccid, number: '+6592401051' }]);
  });

  test('a log row whose SIM is gone explains why it cannot be redialled', async () => {
    const view = render(CallPanel, {
      props: {
        phones,
        history: [{ ...missed, iccid: '8965999999999999999', sim_index: 99 }],
      },
    });

    await fireEvent.click(view.getByText('+6592401051'));
    expect(view.getByRole('alert').textContent).toContain('卡现在不可用');
  });

  test('the log is hidden while a call is up', () => {
    const view = render(CallPanel, {
      props: {
        phones,
        history,
        call: liveCall(),
      },
    });
    expect(view.queryByText('通话记录')).toBeNull();
  });
});
