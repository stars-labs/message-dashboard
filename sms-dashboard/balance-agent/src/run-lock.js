import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function acquireRunLock(filePath, {
  pid = process.pid,
  isProcessRunning = processIsRunning,
} = {}) {
  await mkdir(dirname(filePath), { recursive: true });

  async function create() {
    const handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(`${pid}\n`);
    return handle;
  }

  let handle;
  try {
    handle = await create();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existingPid = Number.parseInt(await readFile(filePath, 'utf8').catch(() => ''), 10);
    if (Number.isSafeInteger(existingPid) && existingPid > 0 && isProcessRunning(existingPid)) {
      throw new Error(`Balance Agent CLI is already running (pid ${existingPid})`);
    }
    await unlink(filePath).catch((unlinkError) => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    });
    try {
      handle = await create();
    } catch (retryError) {
      if (retryError.code === 'EEXIST') {
        throw new Error('Balance Agent CLI was started by another process');
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
      await unlink(filePath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  };
}
