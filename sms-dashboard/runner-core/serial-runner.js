export function abortableSleep(ms, signal) {
  if (!ms || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export async function runSerialCapability({
  runOne,
  once = false,
  signal = null,
  errorDelay = 15_000,
  onError = (error) => console.error(error.message),
  sleep = abortableSleep,
}) {
  do {
    if (signal?.aborted) break;
    try {
      const result = await runOne({ signal });
      if (once) break;
      if (result?.retryDelay) await sleep(result.retryDelay, signal);
    } catch (error) {
      onError(error);
      if (once) throw error;
      await sleep(errorDelay, signal);
    }
  } while (!signal?.aborted);
}
