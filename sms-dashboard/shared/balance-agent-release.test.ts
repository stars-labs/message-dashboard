import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  balanceAgentReleaseTag,
  balanceAgentReleaseUrl,
  LATEST_BALANCE_AGENT,
  LatestBalanceAgent,
} from './balance-agent-release.js';

describe('Balance Agent release', () => {
  test('the latest version is the one balance-agent/package.json ships', async () => {
    const { version } = v.parse(
      v.object({ version: v.string() }),
      await Bun.file(new URL('../balance-agent/package.json', import.meta.url)).json(),
    );
    expect(LATEST_BALANCE_AGENT).toEqual({ version });
  });

  test('tags a release by its version, and links to that tag', () => {
    expect(balanceAgentReleaseTag('0.2.0')).toBe('balance-agent-v0.2.0');
    expect(balanceAgentReleaseUrl('0.2.0')).toBe(
      'https://github.com/stars-labs/message-dashboard/releases/tag/balance-agent-v0.2.0',
    );
  });

  test('accepts only a release version from the Dashboard', () => {
    expect(v.safeParse(LatestBalanceAgent, { version: '0.2.0' }).success).toBe(true);
    expect(v.safeParse(LatestBalanceAgent, { version: '0.2.0/../../evil' }).success).toBe(false);
  });
});
