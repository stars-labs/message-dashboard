import * as v from 'valibot';
import { CarrierWebBalanceJob } from '../../../../shared/api/carrier-web-balance.js';
import type { ControlClient } from '../control-client.js';
import { pollDelayMs } from '../pace.js';
import type { CapabilityPresence } from '../presence.js';
import type { RunOutcome } from '../serial-runner.js';

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
      const claim = await controlClient.carrierWebJobs.claim(
        { query: { runner_id: runnerId } },
        signal === null ? {} : { signal },
      );
      if (claim.status === 204) return { handled: false, retryDelay: pollDelayMs(claim.headers) };

      // The wire passes the skill on as stored; each provider's fields are read here.
      const claimed = v.safeParse(CarrierWebBalanceJob, claim.body);
      if (!claimed.success) {
        throw new Error(`Could not read the claimed web balance job: ${claimed.issues[0].message}`);
      }
      const job = claimed.output;
      await presence.set('busy', job.id);
      try {
        return await processJob(job, { signal });
      } finally {
        await presence.set('ready');
      }
    },
  });
}
