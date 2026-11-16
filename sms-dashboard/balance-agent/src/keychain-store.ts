import { spawn } from 'node:child_process';
import type { SecretKey } from './secure-store.js';

const DEFAULT_SERVICE = 'io.qzz.message-dashboard.balance-agent.cli';

interface CommandOptions {
  input?: string | null;
  inherit?: boolean;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunCommand = (args: string[], options?: CommandOptions) => Promise<CommandResult>;

export interface KeychainStore {
  get(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string | null | undefined): Promise<void>;
  promptSet(key: SecretKey): Promise<void>;
}

const runSecurityCommand: RunCommand = (args, { input = null, inherit = false } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, {
      stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    if (!inherit) {
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      if (input === null) child.stdin?.end();
      else child.stdin?.end(`${input}\n`);
    }
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });

function notFound(result: CommandResult): boolean {
  return result.code === 44 || /could not be found/i.test(result.stderr);
}

function commandError(operation: string, result: CommandResult): Error {
  const detail = result.stderr.trim().replace(/\s+/g, ' ');
  return new Error(`macOS Keychain ${operation} failed${detail ? `: ${detail}` : ''}`);
}

export function createKeychainStore({
  service = DEFAULT_SERVICE,
  platform = process.platform,
  runCommand = runSecurityCommand,
}: {
  service?: string;
  platform?: string;
  runCommand?: RunCommand;
} = {}): KeychainStore {
  function requireMacOS() {
    if (platform !== 'darwin') {
      throw new Error('The Balance Agent CLI credential store currently supports macOS only');
    }
  }

  function identity(key: SecretKey) {
    return ['-a', key, '-s', service];
  }

  return Object.freeze<KeychainStore>({
    async get(key) {
      requireMacOS();
      const result = await runCommand(['find-generic-password', ...identity(key), '-w']);
      if (notFound(result)) return null;
      if (result.code !== 0) throw commandError('read', result);
      return result.stdout.replace(/\r?\n$/, '') || null;
    },

    async set(key, value) {
      requireMacOS();
      if (value === null || value === undefined || value === '') {
        const result = await runCommand(['delete-generic-password', ...identity(key)]);
        if (result.code !== 0 && !notFound(result)) throw commandError('delete', result);
        return;
      }
      const result = await runCommand(['add-generic-password', ...identity(key), '-U', '-w'], {
        input: value,
      });
      if (result.code !== 0) throw commandError('write', result);
    },

    async promptSet(key) {
      requireMacOS();
      const result = await runCommand(['add-generic-password', ...identity(key), '-U', '-w'], {
        inherit: true,
      });
      if (result.code !== 0) throw commandError('write', result);
    },
  });
}
