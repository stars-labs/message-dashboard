import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { failureOf } from './test-support/failure-of.js';
import { acquireRunLock } from './run-lock.js';

let directory: string | null = null;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

describe('Balance Agent CLI run lock', () => {
  test('prevents a second live process and releases its own lock', async () => {
    directory = await mkdtemp(join(tmpdir(), 'balance-agent-lock-'));
    const lockPath = join(directory, 'agent.lock');
    const release = await acquireRunLock(lockPath, { pid: 100, isProcessRunning: () => true });
    expect(
      await failureOf(acquireRunLock(lockPath, { pid: 200, isProcessRunning: () => true })),
    ).toContain('already running (pid 100)');
    await release();
    const releaseSecond = await acquireRunLock(lockPath, {
      pid: 200,
      isProcessRunning: () => true,
    });
    await releaseSecond();
  });

  test('replaces a stale PID lock', async () => {
    directory = await mkdtemp(join(tmpdir(), 'balance-agent-lock-'));
    const lockPath = join(directory, 'agent.lock');
    await writeFile(lockPath, '100\n');
    const release = await acquireRunLock(lockPath, { pid: 200, isProcessRunning: () => false });
    await release();
  });
});
