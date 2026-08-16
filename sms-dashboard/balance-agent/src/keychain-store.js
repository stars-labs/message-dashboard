import { spawn } from 'node:child_process';

const DEFAULT_SERVICE = 'io.qzz.message-dashboard.balance-agent.cli';

function runSecurityCommand(args, { input = null, inherit = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, {
      stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    if (!inherit) {
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      if (input == null) child.stdin.end();
      else child.stdin.end(`${input}\n`);
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function notFound(result) {
  return result.code === 44 || /could not be found/i.test(result.stderr);
}

function commandError(operation, result) {
  const detail = result.stderr.trim().replace(/\s+/g, ' ');
  return new Error(`macOS Keychain ${operation} failed${detail ? `: ${detail}` : ''}`);
}

export function createKeychainStore({
  service = DEFAULT_SERVICE,
  platform = process.platform,
  runCommand = runSecurityCommand,
} = {}) {
  function requireMacOS() {
    if (platform !== 'darwin') {
      throw new Error('The Balance Agent CLI credential store currently supports macOS only');
    }
  }

  function identity(key) {
    return ['-a', key, '-s', service];
  }

  return Object.freeze({
    async get(key) {
      requireMacOS();
      const result = await runCommand(['find-generic-password', ...identity(key), '-w']);
      if (notFound(result)) return null;
      if (result.code !== 0) throw commandError('read', result);
      return result.stdout.replace(/\r?\n$/, '') || null;
    },

    async set(key, value) {
      requireMacOS();
      if (value == null || value === '') {
        const result = await runCommand(['delete-generic-password', ...identity(key)]);
        if (result.code !== 0 && !notFound(result)) throw commandError('delete', result);
        return;
      }
      const result = await runCommand(
        ['add-generic-password', ...identity(key), '-U', '-w'],
        { input: String(value) },
      );
      if (result.code !== 0) throw commandError('write', result);
    },

    async promptSet(key) {
      requireMacOS();
      const result = await runCommand(
        ['add-generic-password', ...identity(key), '-U', '-w'],
        { inherit: true },
      );
      if (result.code !== 0) throw commandError('write', result);
    },
  });
}

export { DEFAULT_SERVICE };
