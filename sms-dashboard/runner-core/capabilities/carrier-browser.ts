import { CarrierWebBalanceJob } from '../../shared/api/carrier-web-balance.js';
import { readJson } from '../../shared/parse-json.js';
import type { ControlClient } from '../control-client.js';
import type { CapabilityPresence } from '../presence.js';
import type { RunOutcome } from '../serial-runner.js';

function claimPath(runnerId: string): string {
  return `/api/control/carrier-web-balance/jobs/claim?runner_id=${encodeURIComponent(runnerId)}`;
}

export function createCarrierBrowserCapability({
  controlClient,
  presence,
  runnerId,
  processJob,
}: {
  controlClient: ControlClient;
  presence: CapabilityPresence;
  runnerId: string;
  processJob: (
    job: CarrierWebBalanceJob,
    options: { signal: AbortSignal | null },
  ) => Promise<RunOutcome>;
}) {
  return Object.freeze({
    async runOne({ signal = null }: { signal?: AbortSignal | null } = {}): Promise<RunOutcome> {
      const response = await controlClient.request(claimPath(runnerId), { signal });
      if (response.status === 204) return { handled: false, retryDelay: 5_000 };
      if (!response.ok) {
        throw new Error(
          `Could not claim a web balance job (${response.status}): ${(await response.text()).slice(0, 300)}`,
        );
      }

      const claimed = await readJson(response, CarrierWebBalanceJob);
      if (!claimed.ok)
        throw new Error(`Could not read the claimed web balance job: ${claimed.error}`);
      const job = claimed.value;
      await presence.set('busy', job.id);
      try {
        return await processJob(job, { signal });
      } finally {
        await presence.set('ready');
      }
    },
  });
}
