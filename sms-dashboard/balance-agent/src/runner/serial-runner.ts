import { errorText } from '../../../shared/error-text.js';

export interface RunOutcome {
  handled?: boolean;
  retryDelay?: number;
}

type Sleep = (ms: number, signal?: AbortSignal | null) => Promise<void>;

export function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
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
  onError = (error) => {
    console.error(errorText(error));
  },
  sleep = abortableSleep,
}: {
  runOne: (context: { signal: AbortSignal | null }) => Promise<RunOutcome>;
  once?: boolean;
  signal?: AbortSignal | null;
  errorDelay?: number;
  onError?: (error: unknown) => void;
  sleep?: Sleep;
}): Promise<void> {
  do {
    if (signal?.aborted) break;
    try {
      const result = await runOne({ signal });
      if (once) break;
      if (result.retryDelay) await sleep(result.retryDelay, signal);
    } catch (error) {
      onError(error);
      if (once) throw error;
      await sleep(errorDelay, signal);
    }
  } while (!signal?.aborted);
}
