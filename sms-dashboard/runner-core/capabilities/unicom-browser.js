function claimPath(runnerId) {
  return `/api/control/unicom-web-balance/jobs/claim?runner_id=${encodeURIComponent(runnerId)}`;
}

export function createUnicomBrowserCapability({
  controlClient,
  presence,
  runnerId,
  processJob,
}) {
  return Object.freeze({
    async runOne({ signal } = {}) {
      await presence.set('ready');
      const response = await controlClient.request(claimPath(runnerId), { signal });
      if (response.status === 204) return { handled: false, retryDelay: 5_000 };
      if (!response.ok) {
        throw new Error(
          `Could not claim a web balance job (${response.status}): ${(await response.text()).slice(0, 300)}`,
        );
      }

      const job = await response.json();
      await presence.set('busy', job.id);
      try {
        return await processJob(job, { signal });
      } finally {
        await presence.set('ready');
      }
    },
  });
}
