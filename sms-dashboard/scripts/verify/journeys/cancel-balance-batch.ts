// Balance batches: a batch query shows its progress, and 取消未开始的 cancels the queries
// nobody has started (dashboard-balances, GRA-233).
import { join } from 'node:path';
import type { Journey } from '../journey.ts';

/** S02 in scripts/e2e/seed.sql: M1 prepaid, browser profile. */
const S02 = '8965000000000000002';

const journey: Journey = async ({ stack, page, out, evidence }) => {
  // The seeded M1 profile is discovery-only, which a batch skips; enable it as a fleet profile.
  await stack.d1(
    "UPDATE sim_balance_profiles SET enabled = 1, discovery_enabled = 0 WHERE id = 'sg-m1-prepaid-browser-v1'",
  );

  // The preview offers the browser method only while the admin has a ready runner. A
  // presence row stands in for one, so no Agent ever claims the job.
  await stack.d1(
    `INSERT INTO balance_runner_installations (
       id, display_name, auth_mode, auth_subject, platform, version
     ) VALUES ('verify-runner', 'Verify', 'auth0_device', 'auth0|e2e-admin', 'darwin', '1')`,
  );
  await stack.d1(
    `INSERT INTO balance_runner_capabilities (runner_id, capability, state, session_id)
     VALUES ('verify-runner', 'carrier_browser', 'ready', 'verify-session')`,
  );

  const desktop = await page('desktop');
  await desktop.goto(`${stack.baseUrl}/#balances`);
  await desktop.getByRole('checkbox', { name: '选择 S02', exact: true }).check();
  await desktop.getByRole('button', { name: '批量查询', exact: true }).click();
  const preview = desktop.getByRole('dialog', { name: '批量余额查询预览' });
  await preview.getByRole('checkbox', { name: /浏览器登录/ }).check();
  await preview.getByRole('button', { name: '确认查询 1 张卡' }).click();

  const progress = desktop.getByRole('region', { name: '批量查询进度' });
  await progress.getByText('完成 0/1').waitFor();
  await desktop.screenshot({ path: join(out, 'batch-progress.png') });

  await progress.getByRole('button', { name: '取消未开始的 1 张' }).click();
  await desktop.getByRole('button', { name: '取消这些查询' }).click();
  await progress.getByText('已取消 1').waitFor();
  await progress.getByRole('button', { name: /取消未开始/ }).waitFor({ state: 'detached' });
  await desktop.screenshot({ path: join(out, 'batch-cancelled.png') });

  const rows = await stack.d1(
    `SELECT c.status, j.status AS job, b.cancelled_at IS NOT NULL AS batch_cancelled
     FROM sim_balance_checks c
     JOIN sim_balance_batches b ON b.id = c.batch_id
     JOIN sim_balance_web_jobs j ON j.check_id = c.id
     WHERE c.sim_iccid = '${S02}'`,
  );
  if (
    JSON.stringify(rows) !==
    JSON.stringify([{ status: 'cancelled', job: 'stopped', batch_cancelled: 1 }])
  ) {
    throw new Error(`after cancelling: ${JSON.stringify(rows)}`);
  }

  // A cancelled check frees the SIM: a single query queues again.
  await desktop
    .getByRole('row')
    .filter({ hasText: 'S02' })
    .getByRole('button', { name: '查询', exact: true })
    .click();
  await desktop.getByRole('button', { name: '开始查询' }).click();
  await desktop.getByText('S02 已加入余额查询队列').waitFor();

  const mobile = await page('mobile');
  await mobile.goto(`${stack.baseUrl}/#balances`);
  await mobile.getByRole('button', { name: '查询 S02 余额' }).waitFor();
  await mobile.getByRole('region', { name: '批量查询进度' }).getByText('已取消 1').waitFor();
  await mobile.screenshot({ path: join(out, 'batch-mobile.png') });

  await evidence('cancelled-batch', { rows });
};

export default journey;
