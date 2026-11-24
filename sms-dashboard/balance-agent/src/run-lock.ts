import { mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

export async function acquireRunLock(
  filePath: string,
  {
    pid = process.pid,
    isProcessRunning = processIsRunning,
  }: { pid?: number; isProcessRunning?: (pid: number) => boolean } = {},
): Promise<() => Promise<void>> {
  await mkdir(dirname(filePath), { recursive: true });

  async function create(): Promise<FileHandle> {
    const handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(`${pid}\n`);
    return handle;
  }

  let handle: FileHandle;
  try {
    handle = await create();
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    const existingPid = Number.parseInt(await readFile(filePath, 'utf8').catch(() => ''), 10);
    if (Number.isSafeInteger(existingPid) && existingPid > 0 && isProcessRunning(existingPid)) {
      throw new Error(`Balance Agent CLI is already running (pid ${existingPid})`, {
        cause: error,
      });
    }
    await unlink(filePath).catch((unlinkError: unknown) => {
      if (errorCode(unlinkError) !== 'ENOENT') throw unlinkError;
    });
    try {
      handle = await create();
    } catch (retryError) {
      if (errorCode(retryError) === 'EEXIST') {
        throw new Error('Balance Agent CLI was started by another process', { cause: retryError });
      }
      throw retryError;
    }
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close();
    const owner = Number.parseInt(await readFile(filePath, 'utf8').catch(() => ''), 10);
    if (owner === pid) {
      await unlink(filePath).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
    }
  };
}
