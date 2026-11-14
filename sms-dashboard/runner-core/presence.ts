import type { BalanceRunnerCapability } from '../shared/api/balance-runners.js';
import type { ControlClient } from './control-client.js';
import { errorMessage } from './error-message.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

type RunnerCapabilityName = BalanceRunnerCapability['capability'];

type CapabilityState = Pick<
  BalanceRunnerCapability,
  'capability' | 'state' | 'current_job_id' | 'concurrency' | 'detail_code'
>;

export interface CapabilityPresence {
  set(
    state: CapabilityState['state'],
    jobId?: string | null,
    detailCode?: string | null,
  ): Promise<void>;
}

interface Logger {
  error(message: string): void;
}

export function createRunnerPresence({
  controlClient,
  runnerId,
  sessionId,
  displayName,
  capabilities,
  version = 'development',
  platform,
  heartbeatInterval = HEARTBEAT_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
}: {
  controlClient: ControlClient;
  runnerId: string;
  sessionId: string;
  displayName: string;
  capabilities: readonly RunnerCapabilityName[];
  version?: string;
  platform: string;
  heartbeatInterval?: number;
  setIntervalFn?: (
    callback: () => Promise<void>,
    interval: number,
  ) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
  logger?: Logger;
}) {
  const states = new Map<RunnerCapabilityName, CapabilityState>(
    capabilities.map((capability) => [
      capability,
      {
        capability,
        state: 'starting',
        current_job_id: null,
        concurrency: 1,
        detail_code: null,
      },
    ]),
  );
  let timer: ReturnType<typeof setInterval> | null = null;
  let pending: Promise<void> = Promise.resolve();
  let lastError: string | null = null;

  function snapshots(selected: Iterable<RunnerCapabilityName>): CapabilityState[] {
    return [...selected].flatMap((capability) => {
      const current = states.get(capability);
      return current ? [{ ...current }] : [];
    });
  }

  function send(selected: Iterable<RunnerCapabilityName> = []): Promise<void> {
    const capabilitySnapshots = snapshots(selected);
    pending = pending
      .then(async () => {
        const response = await controlClient.request('/api/control/balance-runners/heartbeat', {
          method: 'POST',
          body: JSON.stringify({
            runner_id: runnerId,
            session_id: sessionId,
            display_name: displayName,
            platform,
            version,
            capabilities: capabilitySnapshots,
          }),
        });
        if (!response.ok) throw new Error(`heartbeat rejected (${response.status})`);
        lastError = null;
      })
      .catch((error: unknown) => {
        const message = errorMessage(error);
        if (message !== lastError) {
          logger.error(`Runner presence unavailable: ${message}`);
          lastError = message;
        }
      });
    return pending;
  }

  return Object.freeze({
    async start(): Promise<void> {
      await send(states.keys());
      timer = setIntervalFn(() => send(), heartbeatInterval);
      timer.unref();
    },
    async set(
      capability: RunnerCapabilityName,
      nextState: CapabilityState['state'],
      jobId: string | null = null,
      nextDetailCode: string | null = null,
    ): Promise<void> {
      const current = states.get(capability);
      if (!current) throw new Error(`Unknown runner capability: ${capability}`);
      if (
        current.state === nextState &&
        current.current_job_id === jobId &&
        current.detail_code === nextDetailCode
      )
        return;
      states.set(capability, {
        ...current,
        state: nextState,
        current_job_id: jobId,
        detail_code: nextDetailCode,
      });
      await send([capability]);
    },
    async stop(): Promise<void> {
      if (timer) clearIntervalFn(timer);
      timer = null;
      for (const [capability, current] of states) {
        states.set(capability, {
          ...current,
          state: 'stopping',
          current_job_id: null,
          detail_code: null,
        });
      }
      await send(states.keys());
    },
  });
}
