// A Balance Agent CLI that cannot see the operator's installation: its own config
// and state dirs, and its own Keychain service (balance-agent/src/keychain-store.ts),
// all removed by stop().
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVICE_PREFIX = 'io.qzz.message-dashboard.balance-agent.verify-';
const SECRET_KEYS = ['aiToken', 'auth0RefreshToken'] as const;
const CLI_TIMEOUT_MS = 60_000;

export type Security = (
  args: string[],
  input?: string,
) => Promise<{ code: number | null; stderr: string }>;

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface AgentSandbox {
  root: string;
  service: string;
  env: Record<string, string>;
  /** Stores the token the fake AI accepts, as `credentials set-ai-token` would. */
  setAiToken(token: string): Promise<void>;
  /** Runs `balance-agent <args>` in the sandbox; killed after `timeoutMs`. */
  cli(args: string[], timeoutMs?: number): Promise<CliResult>;
  stop(): Promise<void>;
}

/** Runs `binary` the way the sandbox runs `security`; tests pass a harmless binary. */
export const commandRunner =
  (binary: string): Security =>
  (args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.once('error', reject);
      child.once('close', (code) => {
        resolve({ code, stderr });
      });
      // `security -w` prompts for the password and then a retype; one line stores "".
      child.stdin.end(input === undefined ? '' : `${input}\n${input}\n`);
    });

const runSecurity = commandRunner('/usr/bin/security');

const notFound = (code: number | null, stderr: string) =>
  code === 44 || /could not be found/i.test(stderr);

export async function startAgentSandbox({
  security = runSecurity,
}: { security?: Security } = {}): Promise<AgentSandbox> {
  const root = await mkdtemp(join(tmpdir(), 'sms-dashboard-agent-'));
  const service = `${SERVICE_PREFIX}${crypto.randomUUID()}`;
  const env = {
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
    BALANCE_AGENT_KEYCHAIN_SERVICE: service,
  };

  return {
    root,
    service,
    env,
    async setAiToken(token) {
      const result = await security(
        ['add-generic-password', '-a', 'aiToken', '-s', service, '-U', '-w'],
        token,
      );
      if (result.code !== 0) throw new Error(`Keychain write failed: ${result.stderr.trim()}`);
    },
    async cli(args, timeoutMs = CLI_TIMEOUT_MS) {
      const proc = Bun.spawn(['bun', 'src/cli.ts', ...args], {
        cwd: 'balance-agent',
        env: { ...process.env, ...env },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: timeoutMs,
      });
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code, stdout, stderr };
    },
    async stop() {
      const failures: string[] = [];
      for (const key of SECRET_KEYS) {
        const result = await security(['delete-generic-password', '-a', key, '-s', service]);
        if (result.code !== 0 && !notFound(result.code, result.stderr)) {
          failures.push(`${key}: ${result.stderr.trim()}`);
        }
      }
      await rm(root, { recursive: true, force: true });
      if (failures.length > 0) {
        throw new Error(`Keychain cleanup failed: ${failures.join('; ')}`);
      }
    },
  };
}
