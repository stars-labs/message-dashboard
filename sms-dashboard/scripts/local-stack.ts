// The Worker on a fresh local D1 (scripts/init-local-db.ts) plus
// scripts/e2e/seed.sql, with Auth0 answered by scripts/e2e/fake-auth0.ts and an
// admin session in local KV. Everything lives in a temp dir that stop() removes.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionRecord } from './page-visit.ts';
import { startFakeAuth0 } from './e2e/fake-auth0.ts';

const READY_TIMEOUT_MS = 90_000;
const SESSION_TTL_S = 60 * 60;
const WRANGLER = ['node_modules/wrangler/bin/wrangler.js'];

export interface LocalStack {
  baseUrl: string;
  /** The admin session, sent as the `auth_token` cookie. */
  token: string;
  stop(): Promise<void>;
}

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

export async function startLocalStack(): Promise<LocalStack> {
  await run(['bun', 'run', 'build:unified'], 'frontend build');

  const state = await mkdtemp(join(tmpdir(), 'sms-dashboard-stack-'));
  const auth0 = startFakeAuth0();
  let worker: ChildProcess | null = null;
  const stop = async () => {
    if (worker !== null) await stopGroup(worker);
    await auth0.stop();
    await rm(state, { recursive: true, force: true });
  };

  try {
    const local = ['--local', '--persist-to', state];
    await run(['bun', 'scripts/init-local-db.ts', '--persist-to', state], 'building the local D1');
    await run(
      [
        'node',
        ...WRANGLER,
        'd1',
        'execute',
        'sms-dashboard',
        ...local,
        '--file',
        'scripts/e2e/seed.sql',
        '--yes',
      ],
      'applying scripts/e2e/seed.sql',
    );

    const token = `stack-${crypto.randomUUID()}`;
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

    const envFile = join(state, 'stack.env');
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

    return { baseUrl, token, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
