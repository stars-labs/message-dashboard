import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import CallPanel from './CallPanel.svelte';

afterEach(cleanup);

// Field names match /api/phones (device_view): `number`, not `phone_number`.
const phones = [
  { iccid: '8965012306052373985', number: '+6597817169', sim_index: 86, carrier: 'Singtel', flag: '🇸🇬' },
  { iccid: '8965030124051507919', number: '+6590421798', sim_index: 77, carrier: 'M1', flag: '🇸🇬' },
  { iccid: '8986011781104922113', number: '+8617600419127', sim_index: 1, carrier: '联通', flag: '🇨🇳' },
];

function pickSim(view, cardNumber) {
  return fireEvent.click(view.getByText(cardNumber));
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
    const dial = view.getByText('拨打');

    expect(dial.disabled).toBe(true);

    await pickSim(view, 'S77');
    await fireEvent.input(view.getByLabelText('对方号码'), { target: { value: '91234567' } });
    expect(dial.disabled).toBe(true);
    expect(view.container.textContent).toContain('号码需要是国际格式');

    await fireEvent.input(view.getByLabelText('对方号码'), { target: { value: '+6591234567' } });
    expect(dial.disabled).toBe(false);
  });

  test('dials with the chosen SIM and a normalised number', async () => {
    const dialed = [];
    const view = render(CallPanel, { props: { phones, onDial: (a) => dialed.push(a) } });

    await pickSim(view, 'S77');
    await fireEvent.input(view.getByLabelText('对方号码'), { target: { value: ' +65 9123-4567 ' } });
    await fireEvent.click(view.getByText('拨打'));

    expect(dialed).toEqual([{ iccid: phones[1].iccid, number: '+6591234567' }]);
  });

  test('a SIM with no mapped number cannot be dialled from', () => {
    const view = render(CallPanel, {
      props: { phones: [{ iccid: '8965000000000000000', sim_index: 12, number: null }] },
    });

    expect(view.getByText('没有匹配的卡')).toBeTruthy();
  });

  test('an offline daemon blocks dialing and says why', async () => {
    const view = render(CallPanel, { props: { phones, daemonOnline: false } });

    await pickSim(view, 'S86');
    await fireEvent.input(view.getByLabelText('对方号码'), { target: { value: '+6591234567' } });

    expect(view.getByText('拨打').disabled).toBe(true);
    expect(view.container.textContent).toContain('采集服务离线');
  });
});

describe('CallPanel during a call', () => {
  const inbound = { direction: 'inbound', state: 'ringing', number: '92953543', iccid: phones[0].iccid };

  test('a ringing inbound call shows the caller, its SIM, answer and reject', async () => {
    const answered = [];
    const hungUp = [];
    const view = render(CallPanel, {
      props: { phones, call: inbound, onAnswer: () => answered.push(true), onHangup: () => hungUp.push(true) },
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
    const muted = [];
    const view = render(CallPanel, {
      props: {
        phones,
        call: {
          direction: 'outbound',
          state: 'active',
          number: '+6591234567',
          iccid: phones[0].iccid,
          started_at: new Date(Date.now() - 65_000).toISOString(),
        },
        onToggleMute: () => muted.push(true),
      },
    });

    expect(view.getByTestId('call-state').textContent).toContain('01:05');
    await fireEvent.click(view.getByText('静音'));
    expect(muted).toHaveLength(1);
  });

  test('mute is unavailable before the audio path is up', () => {
    const view = render(CallPanel, {
      props: { phones, call: { direction: 'outbound', state: 'connecting', number: '+6591234567' } },
    });

    expect(view.getByText('静音').disabled).toBe(true);
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
  const history = [
    {
      id: 'c1', direction: 'inbound', outcome: 'missed', iccid: phones[0].iccid, sim_index: 86,
      remote_number: '+6592401051', started_at: new Date().toISOString(), duration_seconds: 0,
    },
    {
      id: 'c2', direction: 'outbound', outcome: 'answered', iccid: phones[1].iccid, sim_index: 77,
      remote_number: '+6591234567', started_at: new Date(Date.now() - 3_600_000).toISOString(),
      answered_at: new Date(Date.now() - 3_590_000).toISOString(), duration_seconds: 125,
    },
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
    const dialed = [];
    const view = render(CallPanel, { props: { phones, history, onDial: (a) => dialed.push(a) } });

    await fireEvent.click(view.getByText('+6592401051'));
    await fireEvent.click(view.getByText('拨打'));

    expect(dialed).toEqual([{ iccid: phones[0].iccid, number: '+6592401051' }]);
  });

  test('a log row whose SIM is gone explains why it cannot be redialled', async () => {
    const view = render(CallPanel, {
      props: {
        phones,
        history: [{ ...history[0], iccid: '8965999999999999999', sim_index: 99 }],
      },
    });

    await fireEvent.click(view.getByText('+6592401051'));
    expect(view.getByRole('alert').textContent).toContain('卡现在不可用');
  });

  test('the log is hidden while a call is up', () => {
    const view = render(CallPanel, {
      props: { phones, history, call: { direction: 'inbound', state: 'ringing', number: '92953543' } },
    });
    expect(view.queryByText('通话记录')).toBeNull();
  });
});
