const HEARTBEAT_INTERVAL_MS = 30_000;

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
}) {
  const states = new Map(capabilities.map((capability) => [capability, {
    capability,
    state: 'starting',
    current_job_id: null,
    concurrency: 1,
    detail_code: null,
  }]));
  let timer = null;
  let pending = Promise.resolve();
  let lastError = null;

  function snapshots(selected = states.keys()) {
    return [...selected].map((capability) => ({ ...states.get(capability) }));
  }

  function send(selected = []) {
    const capabilitySnapshots = snapshots(selected);
    pending = pending.then(async () => {
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
    }).catch((error) => {
      if (error.message !== lastError) {
        logger.error(`Runner presence unavailable: ${error.message}`);
        lastError = error.message;
      }
    });
    return pending;
  }

  return Object.freeze({
    async start() {
      await send(states.keys());
      timer = setIntervalFn(() => send(), heartbeatInterval);
      timer.unref?.();
    },
    async set(capability, nextState, jobId = null, nextDetailCode = null) {
      const current = states.get(capability);
      if (!current) throw new Error(`Unknown runner capability: ${capability}`);
      if (current.state === nextState
        && current.current_job_id === jobId
        && current.detail_code === nextDetailCode) return;
      states.set(capability, {
        ...current,
        state: nextState,
        current_job_id: jobId,
        detail_code: nextDetailCode,
      });
      await send([capability]);
    },
    async stop() {
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
