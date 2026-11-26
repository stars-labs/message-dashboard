// The Balance Agent menu-bar app (balance-agent/src/main.ts) in its own user-data dir,
// so it never reads the operator's settings or collides with their running copy:
// the single-instance lock lives in that dir too.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { electronBinary } from './electron.ts';

const LAUNCH_TIMEOUT_MS = 30_000;
const SECOND_LAUNCH_TIMEOUT_MS = 20_000;
const WINDOW_TIMEOUT_MS = 10_000;
const QUIT_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 5_000;

export interface AgentApp {
  app: ElectronApplication;
  userData: string;
  /** Opens the app again, as a user does; the running instance shows its settings window. */
  open: () => Promise<Page>;
}

async function build(): Promise<void> {
  const proc = Bun.spawn(['bun', 'run', 'build'], {
    cwd: 'balance-agent',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`Balance Agent build failed (${String(code)}): ${stderr}`);
}

export async function launchAgentApp(): Promise<AgentApp & { close: () => Promise<void> }> {
  const binary = resolve(await electronBinary());
  await build();
  const userData = await mkdtemp(join(tmpdir(), 'sms-dashboard-agent-app-'));
  const args = [`--user-data-dir=${userData}`, resolve('balance-agent')];
  const app = await _electron
    .launch({ executablePath: binary, args, timeout: LAUNCH_TIMEOUT_MS })
    .catch(async (error: unknown) => {
      await rm(userData, { recursive: true, force: true });
      throw error;
    });

  return {
    app,
    userData,
    async open() {
      const second = Bun.spawn([binary, ...args], {
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: SECOND_LAUNCH_TIMEOUT_MS,
      });
      await second.exited;
      return app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
    },
    // A quit that hangs is a defect (GRA-230): the app is killed so teardown finishes,
    // and the run fails.
    async close() {
      const proc = app.process();
      try {
        const closing = app.close().then(
          () => true,
          () => true,
        );
        if (await Promise.race([closing, Bun.sleep(QUIT_TIMEOUT_MS).then(() => false)])) return;
        proc.kill('SIGKILL');
        await Promise.race([closing, Bun.sleep(KILL_TIMEOUT_MS)]);
        if (proc.exitCode === null && proc.signalCode === null) {
          throw new Error(`Balance Agent app (pid ${String(proc.pid)}) survived SIGKILL`);
        }
        throw new Error(
          `did not quit within ${String(QUIT_TIMEOUT_MS / 1000)}s and was killed (GRA-230)`,
        );
      } finally {
        await rm(userData, { recursive: true, force: true });
      }
    },
  };
}
