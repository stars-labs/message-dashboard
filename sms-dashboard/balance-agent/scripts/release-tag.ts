// bun scripts/release-tag.ts: prints `<version> <tag>` for `nix run .#release-balance-agent`,
// so the release and the Worker that announces it name the tag the same way.
import {
  LATEST_BALANCE_AGENT,
  balanceAgentReleaseTag,
} from '../../shared/balance-agent-release.js';

const { version } = LATEST_BALANCE_AGENT;
console.log(`${version} ${balanceAgentReleaseTag(version)}`);
