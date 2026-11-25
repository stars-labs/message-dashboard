// Balance query through the sms-ai capability, across all three clients: the dashboard
// queues a check, the daemon (replayed) sends it and uploads the carrier's menu, the
// Balance Agent CLI asks the (fake) company AI and applies its answer, and the Worker
// queues the follow-up SMS. See agent-sms-ai-run.md and cross-component-journeys.md.
import * as v from 'valibot';
import type { Journey } from '../journey.ts';

/** S03 in scripts/e2e/seed.sql: China Mobile, seeded as a secondary SIM on a disconnected modem. */
const S03 = '8986000000000000003';
/** Carriers put each option on its own line; extractBalanceMenuOptions needs that. */
const MENU = '尊敬的客户，请回复数字：\n201.查询话费余额\n202.查询流量余额';
const SESSION = 'e2e-session';

const Pending = v.object({
  pending_messages: v.array(v.object({ id: v.string(), recipient: v.string() })),
});

function modemReport(n: number, iccid: string, operator: string) {
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
    status: 'connected',
    usb_path: `1-1.${String(n)}`,
    usb_port: n,
  };
}

const journey: Journey = async ({ stack, ai, daemon, agent, page, evidence }) => {
  // Preconditions through production paths: the daemon reports S03's modem connected...
  const synced = await daemon('/api/control/devices', {
    body: {
      session_id: SESSION,
      sync_mode: 'full',
      timestamp: new Date().toISOString(),
      removed_equipment_ids: [],
      modem_reports: [
        modemReport(1, '8965000000000000001', 'SingTel'),
        modemReport(2, '8965000000000000002', 'M1'),
        modemReport(3, S03, 'China Mobile'),
      ],
    },
  });
  if (synced.status !== 200) throw new Error(`device sync answered ${String(synced.status)}`);

  // ...and the operator makes it a standalone, verified-prepaid SIM.
  const p = await page('desktop');
  await p.goto(`${stack.baseUrl}/#iccid-mappings`);
  await p.getByRole('row').filter({ hasText: S03 }).getByRole('button', { name: '编辑' }).click();
  const dialog = p.getByRole('dialog', { name: '编辑映射' });
  await dialog.getByLabel('主副卡').selectOption({ label: '独立' });
  await dialog.getByLabel('计费类型').selectOption({ label: '预付费' });
  await dialog.getByLabel('确认来源').selectOption({ label: '运营商客服' });
  await dialog.getByRole('button', { name: '保存' }).click();
  await dialog.waitFor({ state: 'hidden' });

  await p.getByRole('button', { name: '余额' }).nth(0).click();
  await p
    .getByRole('row')
    .filter({ hasText: 'S03' })
    .getByRole('button', { name: '查询', exact: true })
    .click();
  await p.getByRole('button', { name: '仍然排队' }).click(); // no agent is signed in yet
  await p.getByText('S03 已加入余额查询队列').waitFor();

  // The daemon sends it, then uploads the carrier's menu.
  const pending = v.parse(
    Pending,
    (await daemon('/api/control/pending-sms', { sessionId: SESSION })).body,
  );
  const outbound = pending.pending_messages.find((message) => message.recipient === '10086');
  if (outbound === undefined) throw new Error('no balance SMS to 10086 was pending');
  await daemon('/api/control/sms-result', {
    body: { message_id: outbound.id, outcome: 'confirmed', error_message: null },
  });
  await daemon('/api/control/messages', {
    body: {
      messages: [
        {
          id: crypto.randomUUID(),
          direction: 'received',
          phone_iccid: S03,
          phone_number: '10086',
          content: MENU,
          timestamp: new Date().toISOString(),
        },
      ],
    },
  });

  // The Balance Agent claims the skill job, asks the AI, and applies its answer.
  const cli = await agent();
  await cli.setAiToken(ai.token);
  for (const args of [
    [
      'configure',
      '--dashboard-url',
      stack.baseUrl,
      '--auth0-issuer',
      `http://${stack.auth0.domain}`,
      '--auth0-client-id',
      stack.auth0.nativeClientId,
      '--auth0-audience',
      stack.auth0.audience,
      '--ai-base-url',
      ai.baseUrl,
      '--ai-model',
      'fake-model',
      '--ai-protocol',
      'anthropic',
    ],
    ['login'],
  ]) {
    const result = await cli.cli(args);
    if (result.code !== 0) throw new Error(`balance-agent ${args[0] ?? ''}: ${result.stderr}`);
  }
  ai.answer({
    action: 'reply',
    selected_option: '201',
    balance: null,
    currency: null,
    confidence: 0.95,
    reason: '201 asks for the cash balance',
    evidence: '201.查询话费余额',
  });
  const run = await cli.cli(['run', '--capability', 'sms-ai', '--once']);
  if (!run.stdout.includes('Applied reply decision'))
    throw new Error(`run --once: ${run.stdout}${run.stderr}`);

  // Proof: the job completed and the Worker queued the follow-up "201" to 10086.
  const jobs = await stack.d1('SELECT status FROM sim_balance_skill_jobs');
  const followUp = await stack.d1(
    `SELECT content, status FROM messages WHERE phone_iccid = '${S03}' AND type = 'sent' AND content = '201'`,
  );
  await evidence('sms-ai', { prompts: ai.prompts, jobs, followUp });
  if (jobs[0]?.['status'] !== 'completed') throw new Error(`skill job is ${JSON.stringify(jobs)}`);
  if (followUp[0]?.['status'] !== 'sending')
    throw new Error(`no follow-up 201: ${JSON.stringify(followUp)}`);
};

export default journey;
