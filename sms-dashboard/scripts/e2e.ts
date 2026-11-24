// bun run e2e [-- --out <dir>]: every view, at desktop and mobile width, against
// the real Worker on a fresh local D1 built as test/schema.ts builds it, plus
// scripts/e2e/seed.sql, with Auth0 answered by scripts/e2e/fake-auth0.ts. A view
// fails on any console error or warning, page error, failed or 4xx/5xx request,
// a redirect away from it, or (mobile) horizontal overflow.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import * as v from 'valibot';
import type { PageIssue } from './page-report.ts';
import { sessionRecord, signedIn, visit, VIEWPORT_ORDER, VIEWPORTS, VIEWS } from './page-visit.ts';
import { startFakeAuth0 } from './e2e/fake-auth0.ts';
import { baselineThrough, databaseFiles } from './migration-rules.ts';

const READY_TIMEOUT_MS = 90_000;
const SESSION_TTL_S = 60 * 60;
const WRANGLER = ['node_modules/wrangler/bin/wrangler.js'];

const { values } = parseArgs({ options: { out: { type: 'string', default: 'e2e-results' } } });
const out = values.out;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });
}

async function run(command: string[], label: string): Promise<void> {
  const proc = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
    throw new Error(`${label} failed (${String(code)}):\n${output}`);
  }
}

// Wrangler runs workerd as a child; a process group lets one signal stop both.
function stopGroup(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid === undefined || child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => {
      resolve();
    });
    process.kill(-child.pid, 'SIGTERM');
  });
}

async function waitUntilServing(baseUrl: string, worker: ChildProcess, log: () => string) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`wrangler dev exited:\n${log()}`);
    try {
      await fetch(`${baseUrl}/api/auth/me`);
      return;
    } catch {
      await Bun.sleep(500);
    }
  }
  throw new Error(`wrangler dev did not answer within ${String(READY_TIMEOUT_MS)} ms:\n${log()}`);
}

await run(['bun', 'run', 'build:unified'], 'frontend build');

const state = await mkdtemp(join(tmpdir(), 'sms-dashboard-e2e-'));
const auth0 = startFakeAuth0();
let worker: ChildProcess | null = null;
const failures: string[] = [];

try {
  const local = ['--local', '--persist-to', state];
  const through = baselineThrough(await Bun.file('migrations/schema.sql').text());
  const database = databaseFiles(await readdir('migrations'), through).map(
    (name) => `migrations/${name}`,
  );
  for (const file of [...database, 'scripts/e2e/seed.sql']) {
    await run(
      ['node', ...WRANGLER, 'd1', 'execute', 'sms-dashboard', ...local, '--file', file, '--yes'],
      `applying ${file}`,
    );
  }

  const token = `e2e-${crypto.randomUUID()}`;
  await run(
    [
      'node',
      ...WRANGLER,
      'kv',
      'key',
      'put',
      '--binding',
      'SESSIONS',
      ...local,
      token,
      sessionRecord('auth0|e2e-admin', ['sms-admin'], SESSION_TTL_S),
    ],
    'writing the session',
  );

  const envFile = join(state, 'e2e.env');
  await writeFile(
    envFile,
    [
      `AUTH0_DOMAIN=${auth0.domain}`,
      'AUTH0_CLIENT_ID=e2e-client',
      'AUTH0_CLIENT_SECRET=e2e-client-secret',
      'AUTH0_M2M_CLIENT_ID=e2e-m2m',
      'AUTH0_M2M_CLIENT_SECRET=e2e-m2m-secret',
      'API_KEY=e2e-api-key',
      '',
    ].join('\n'),
  );

  const port = await freePort();
  const baseUrl = `http://localhost:${String(port)}`;
  let workerLog = '';
  worker = spawn(
    'node',
    [
      ...WRANGLER,
      'dev',
      ...local,
      '--port',
      String(port),
      '--env-file',
      envFile,
      '--show-interactive-dev-session=false',
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  worker.stdout?.on('data', (chunk: Buffer) => (workerLog += chunk.toString()));
  worker.stderr?.on('data', (chunk: Buffer) => (workerLog += chunk.toString()));
  await waitUntilServing(baseUrl, worker, () => workerLog);

  await mkdir(out, { recursive: true });
  // The repo installs no headless shell, so launch the full Chromium build.
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const context = await browser.newContext({ viewport: VIEWPORTS.desktop });
    await context.addCookies([{ name: 'auth_token', value: token, url: baseUrl, httpOnly: true }]);
    if (!(await signedIn(context, baseUrl))) throw new Error('the e2e session was not accepted');

    for (const view of VIEWS) {
      for (const viewport of VIEWPORT_ORDER) {
        const { page, issues, finalHash } = await visit(context, baseUrl, view, viewport);
        const problems: PageIssue[] = [...issues];
        if (finalHash !== `#${view}`) {
          problems.push({ kind: 'route', text: `ended on ${finalHash || '(no hash)'}` });
        }
        if (viewport === 'mobile') {
          const overflow = v.parse(
            v.number(),
            await page.evaluate(
              'document.documentElement.scrollWidth - document.documentElement.clientWidth',
            ),
          );
          if (overflow > 0) {
            problems.push({ kind: 'route', text: `scrolls ${String(overflow)}px sideways` });
          }
        }
        const name = `${view}-${viewport}`;
        await page.screenshot({ path: join(out, `${name}.png`) });
        if (problems.length > 0) {
          failures.push(`${name}:\n${problems.map((p) => `  ${p.kind}: ${p.text}`).join('\n')}`);
        }
        console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${name}`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  if (worker !== null) await stopGroup(worker);
  await auth0.stop();
  await rm(state, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.join('\n\n')}\n\nScreenshots: ${out}/`);
  process.exit(1);
}
console.log(`\nAll ${String(VIEWS.length * VIEWPORT_ORDER.length)} view checks passed.`);
