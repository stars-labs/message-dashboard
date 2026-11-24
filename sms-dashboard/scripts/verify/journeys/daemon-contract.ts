// The Orange Pi daemon's control calls, replayed in fixture shape
// (shared/control-fixtures/daemon/), and what the dashboard shows for each.
// See the daemon-*.md feature files.
import * as v from 'valibot';
import type { Journey } from '../journey.ts';

const S01 = '8965000000000000001';
const S02 = '8965000000000000002';
const SESSION = 'e2e-session';

const Pending = v.object({
  pending_messages: v.array(v.object({ id: v.string(), content: v.string() })),
});
const Ringing = v.object({ call: v.object({ id: v.string() }) });

function modem(n: number, iccid: string, operator: string, status: string) {
  return {
    equipment_id: `86000000000000${String(n)}`,
    detected_iccid: iccid,
    detected_operator: operator,
    detected_phone_number: null,
    manufacturer: 'Quectel',
    model: 'EC20F',
    firmware_revision: 'EC20CEFAG',
    hardware_revision: null,
    modem_index: n - 1,
    rssi: -60,
    signal_percent: 70,
    status,
    usb_path: `1-1.${String(n)}`,
    usb_port: n,
  };
}

function expectEqual(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

const journey: Journey = async ({ stack, daemon, page, evidence }) => {
  const p = await page('desktop');

  // Heartbeat → the health panel.
  const beat = await daemon('/api/control/heartbeat', {
    body: {
      schema_version: 3,
      session_id: SESSION,
      version: '8.0.2',
      uptime_seconds: 7200,
      last_message_read_success_age_seconds: 3,
      last_upload_success_age_seconds: 4,
      queue: { pending: 1, in_flight: 0, dead_letter: 2, oldest_unacknowledged_age_seconds: 90 },
    },
  });
  expectEqual('heartbeat status', beat.status, 200);
  await p.goto(`${stack.baseUrl}/#dashboard`);
  await p
    .getByRole('button', { name: /采集服务/ })
    .nth(0)
    .click();
  const panel = p.getByRole('dialog', { name: '采集服务状态' });
  await panel.getByText('2 条消息需要人工处理').waitFor();
  await panel.getByText('8.0.2').waitFor();
  await panel.getByRole('button', { name: '关闭' }).click();

  // Upload → the feed, with the code extracted.
  await daemon('/api/control/messages', {
    body: {
      messages: [
        {
          id: crypto.randomUUID(),
          direction: 'received',
          phone_iccid: S01,
          phone_number: 'BANK2',
          content: 'Your verification code is 135790.',
          timestamp: new Date().toISOString(),
        },
      ],
    },
  });
  await p.reload();
  await p.getByRole('button', { name: '135790', exact: true }).waitFor();
  expectEqual(
    'uploaded message',
    await stack.d1("SELECT verification_code FROM messages WHERE phone_number = 'BANK2'"),
    [{ verification_code: '135790' }],
  );

  // Device sync: S02's modem drops → S02 offline.
  await daemon('/api/control/devices', {
    body: {
      session_id: SESSION,
      sync_mode: 'full',
      timestamp: new Date().toISOString(),
      removed_equipment_ids: [],
      modem_reports: [modem(1, S01, 'SingTel', 'connected'), modem(2, S02, 'M1', 'disconnected')],
    },
  });
  expectEqual(
    'S02 after sync',
    await stack.d1(`SELECT sim_status FROM device_view WHERE iccid = '${S02}'`),
    [{ sim_status: 'offline' }],
  );
  await p.reload();
  await p.getByRole('button', { name: '离线 2' }).waitFor();

  // Outbox: a send from the UI → poll → failure reported → 发送失败.
  await p.getByRole('button', { name: '发送短信' }).nth(0).click();
  const drawer = p.getByRole('button', { name: '关闭发送短信' }).locator('xpath=../..');
  await drawer.getByPlaceholder('卡号 / 号码 / 运营商 / ICCID').click();
  await drawer.getByRole('button', { name: /S01/ }).click();
  await drawer.getByPlaceholder('输入手机号或短号…').fill('91234567');
  await drawer.getByPlaceholder('输入短信内容…').fill('daemon contract');
  await drawer.getByRole('button', { name: '发送短信', exact: true }).click();
  await drawer.getByText('已提交，等待发送').waitFor();
  await p.getByRole('button', { name: '关闭发送短信' }).click();
  const pending = v.parse(
    Pending,
    (await daemon('/api/control/pending-sms', { sessionId: SESSION })).body,
  );
  const sent = pending.pending_messages.find((message) => message.content === 'daemon contract');
  if (sent === undefined) throw new Error('the send was not offered to the daemon');
  expectEqual(
    'status after poll',
    await stack.d1(`SELECT status FROM messages WHERE id = '${sent.id}'`),
    [{ status: 'processing' }],
  );
  await daemon('/api/control/sms-result', {
    body: { message_id: sent.id, outcome: 'failed', error_message: 'CMS ERROR: 500' },
  });
  await p.reload();
  await p
    .locator('[data-message-row]')
    .filter({ hasText: 'daemon contract' })
    .getByText('发送失败')
    .waitFor();

  // Calls: ringing on S01; a ring on another SIM is busy; hang-up unanswered → missed.
  const ring = await daemon('/api/control/calls/incoming', {
    body: { from: '+6591230000', iccid: S01 },
  });
  const callId = v.parse(Ringing, ring.body).call.id;
  const busy = await daemon('/api/control/calls/incoming', {
    body: { from: '+6591230001', iccid: S02 },
  });
  expectEqual('busy', busy, { status: 409, body: { ok: false, reason: 'another call is active' } });
  await daemon('/api/control/calls/ended', {
    body: { call_id: callId, iccid: S01, reason: 'remote_hangup' },
  });
  expectEqual(
    'call record',
    await stack.d1("SELECT outcome FROM calls WHERE remote_number = '+6591230000'"),
    [{ outcome: 'missed' }],
  );

  await evidence('daemon-contract', { heartbeat: beat, outbox: sent, busy });
};

export default journey;
