# Balance module

`#balances`, 余额管理: prepaid balances per SIM, postpaid bills, and starting a
balance query. A query only queues work: an SMS-method check writes a `sending`
message for the daemon, a browser-method check writes a web job for the Balance Agent.
Locally neither runs unless a journey starts the agent, so checks stay queued.

## Sub-features

- tabs: 余额概览 (overview) / 后付费账单 (bills) / 查询记录 (history).
- overview: table per SIM with search `搜索 SIM`, `运营商筛选`, selection checkboxes.
- single query: 查询 on a row → preflight → either queued at once or a dialog.
- runner-not-ready dialog: 查询助手未就绪 with 取消 / 仍然排队 / 打开查询助手, when the
  profile needs the Balance Agent and none is signed in.
- batch query: 批量查询 → 批量查询预览 → 确认查询 N 张卡.
- history: one row per check with method (BROWSER / SMS), status label (排队中,
  等待本机, 已解析, …) and 详情.
- detail drawer: `余额查询详情`, closed with `关闭`.
- runner status: region `余额查询助手状态`.
- runner admin (`runners.write` only): 管理 (`aria-label="管理查询助手"`) in the runner
  status bar opens dialog `管理查询助手`, every installation with owner, version, last
  heartbeat and 在线 / 离线 / 已撤销; `撤销 <name>` → confirm 撤销. A revoked runner's
  heartbeat, claims and calls on its leased jobs (except fail / release) answer 403;
  other runners keep working. Checked in:
  `scripts/verify/journeys/revoke-runner.ts`.

## How to get to it (user POV)

Desktop: nav 余额. Mobile: tab 余额 (cards; per-SIM query button
`aria-label="查询 S02 余额"`). Postpaid SIMs have no 查询; a secondary SIM's 查询 is
disabled (`title="副卡，余额随主卡查询"`).

## Driving it with bun run verify

```ts
const p = await page('desktop');
await p.goto(`${stack.baseUrl}/#balances`);
await p.getByText('余额管理').first().waitFor();
await p.getByRole('row').filter({ hasText: 'S02' })
  .getByRole('button', { name: '查询', exact: true }).click();
await p.getByRole('button', { name: '仍然排队' }).click(); // no agent signed in
await p.getByText('S02 已加入余额查询队列').waitFor();
await evidence('check', await stack.d1(`SELECT c.status, c.profile_id, j.status AS job
  FROM sim_balance_checks c LEFT JOIN sim_balance_web_jobs j ON j.check_id = c.id
  WHERE c.sim_iccid = '8965000000000000002'`));
// [{ status: 'queued', profile_id: 'sg-m1-prepaid-browser-v1', job: 'pending' }]
await p.getByRole('button', { name: '查询记录' }).click(); // row: S02 … BROWSER 等待本机
```

Proof: the notice, the check and job rows, and the history row.

## Gotchas

- Seed eligibility: S01 is postpaid (no 查询), S03 is a disconnected secondary, so
  S02 (M1 prepaid, browser profile) is the only SIM you can query as seeded.
  [agent-sms-ai-run](agent-sms-ai-run.md) makes S03 queryable through production
  paths.
- A query whose method needs the Balance Agent opens 查询助手未就绪 when none is
  signed in; 仍然排队 queues it anyway.
- Notices are inline and dismissible (`关闭提示`), not the toast stack.
- A second query for the same SIM within 24h is refused (429) by design.
- Statuses advance only when a runner acts: drive the agent journeys for 等待本机 →
  已解析. Carrier-browser runs are never automated (real portals, human verification).
- The page polls active checks every 2s for 15s after a queue, then every 5s; wait on
  text, not time.
