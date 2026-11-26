// Balance runners: an admin revokes one Balance Agent installation from the Balance
// page; that runner's heartbeat and claims are refused, the other runner keeps working
// (dashboard-balances, GRA-234).
import { join } from 'node:path';
import type { Journey } from '../journey.ts';

const RUNNERS = [
  { runner_id: 'verify-lost-mac', session_id: 'verify-lost-session', display_name: 'Lost MacBook' },
  { runner_id: 'verify-kept-mac', session_id: 'verify-kept-session', display_name: 'Kept iMac' },
] as const;

const journey: Journey = async ({ stack, page, out, evidence }) => {
  const control = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const response = await fetch(`${stack.baseUrl}${path}`, {
      method,
      headers: { 'x-api-key': stack.apiKey, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response.status;
  };
  const heartbeat = (runner: (typeof RUNNERS)[number]) =>
    control('POST', '/api/control/balance-runners/heartbeat', {
      ...runner,
      platform: 'darwin',
      version: '9.9.9',
      capabilities: [{ capability: 'sms_ai', state: 'ready' }],
    });
  const claim = (sessionId: string) =>
    control('GET', `/api/control/balance-skills/jobs/claim?runner_id=${sessionId}`);

  for (const runner of RUNNERS) {
    const status = await heartbeat(runner);
    if (status !== 200) throw new Error(`heartbeat for ${runner.runner_id} answered ${status}`);
  }
  const before = await claim('verify-lost-session');
  if (before !== 204) throw new Error(`a registered runner's claim answered ${before}, not 204`);

  const desktop = await page('desktop');
  await desktop.goto(`${stack.baseUrl}/#balances`);
  await desktop.getByRole('button', { name: '管理查询助手' }).click();
  const dialog = desktop.getByRole('dialog', { name: '管理查询助手' });
  await dialog.getByText('Lost MacBook').waitFor();
  await desktop.screenshot({ path: join(out, 'runner-admin-desktop.png') });

  await dialog.getByRole('button', { name: '撤销 Lost MacBook' }).click();
  await desktop.getByRole('button', { name: '撤销', exact: true }).click();
  await dialog.getByRole('button', { name: '撤销 Lost MacBook' }).waitFor({ state: 'detached' });
  const lostRow = dialog.getByRole('row').filter({ hasText: 'Lost MacBook' });
  if (!(await lostRow.innerText()).includes('已撤销')) {
    throw new Error('the revoked runner is not shown as 已撤销');
  }
  await desktop.screenshot({ path: join(out, 'runner-admin-revoked.png') });

  const after = {
    lostClaim: await claim('verify-lost-session'),
    lostHeartbeat: await heartbeat(RUNNERS[0]),
    keptClaim: await claim('verify-kept-session'),
    keptHeartbeat: await heartbeat(RUNNERS[1]),
  };
  const expected = { lostClaim: 403, lostHeartbeat: 403, keptClaim: 204, keptHeartbeat: 200 };
  if (JSON.stringify(after) !== JSON.stringify(expected)) {
    throw new Error(
      `after revoking: ${JSON.stringify(after)}, expected ${JSON.stringify(expected)}`,
    );
  }

  const mobile = await page('mobile');
  await mobile.goto(`${stack.baseUrl}/#balances`);
  await mobile.getByRole('button', { name: '管理查询助手' }).click();
  await mobile.getByRole('dialog', { name: '管理查询助手' }).getByText('Kept iMac').waitFor();
  await mobile.screenshot({ path: join(out, 'runner-admin-mobile.png') });

  await evidence('revoke-runner', {
    before: { lostClaim: before },
    after,
    rows: await stack.d1(
      "SELECT id, revoked_at IS NOT NULL AS revoked FROM balance_runner_installations WHERE id LIKE 'verify-%' ORDER BY id",
    ),
  });
};

export default journey;
