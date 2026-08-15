const HEARTBEAT_INTERVAL_MS = 30_000;

export function createRunnerPresence({
  controlClient,
  runnerId,
  sessionId,
  displayName,
  capability,
  version = 'development',
  platform,
  heartbeatInterval = HEARTBEAT_INTERVAL_MS,
  logger = console,
}) {
  let state = 'starting';
  let currentJobId = null;
  let detailCode = null;
  let timer = null;
  let inFlight = null;
  let lastError = null;

  async function send() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const response = await controlClient.request('/api/control/balance-runners/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          runner_id: runnerId,
          session_id: sessionId,
          display_name: displayName,
          platform,
          version,
          capabilities: [{
            capability,
            state,
            current_job_id: currentJobId,
            concurrency: 1,
            detail_code: detailCode,
          }],
        }),
      });
      if (!response.ok) throw new Error(`heartbeat rejected (${response.status})`);
      lastError = null;
    })().catch((error) => {
      if (error.message !== lastError) {
        logger.error(`Runner presence unavailable: ${error.message}`);
        lastError = error.message;
      }
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return Object.freeze({
    async start() {
      await send();
      timer = setInterval(send, heartbeatInterval);
      timer.unref?.();
    },
    async set(nextState, jobId = null, nextDetailCode = null) {
      state = nextState;
      currentJobId = jobId;
      detailCode = nextDetailCode;
      await send();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      state = 'stopping';
      currentJobId = null;
      detailCode = null;
      await send();
    },
  });
}
