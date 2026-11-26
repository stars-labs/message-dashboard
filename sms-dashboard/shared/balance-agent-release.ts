import * as v from 'valibot';
import agentPackage from '../balance-agent/package.json' with { type: 'json' };

const RELEASES_URL = 'https://github.com/stars-labs/message-dashboard/releases';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** The git tag `nix run .#release-balance-agent` publishes a version under. */
export function balanceAgentReleaseTag(version: string): string {
  return `balance-agent-v${version}`;
}

export const LatestBalanceAgent = v.object({
  version: v.pipe(v.string(), v.regex(VERSION)),
  release_url: v.pipe(v.string(), v.url()),
});

export type LatestBalanceAgent = v.InferOutput<typeof LatestBalanceAgent>;

/**
 * The version in balance-agent/package.json, which the release command publishes and
 * the Worker, built from the same commit, announces. Release before deploying.
 */
export const LATEST_BALANCE_AGENT: LatestBalanceAgent = v.parse(LatestBalanceAgent, {
  version: agentPackage.version,
  release_url: `${RELEASES_URL}/tag/${balanceAgentReleaseTag(agentPackage.version)}`,
});
