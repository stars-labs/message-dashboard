import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { balanceAgentReleaseTag, LATEST_BALANCE_AGENT } from './balance-agent-release.js';

describe('Balance Agent release', () => {
  test('the latest version is the one balance-agent/package.json ships', async () => {
    const { version } = v.parse(
      v.object({ version: v.string() }),
      await Bun.file(new URL('../balance-agent/package.json', import.meta.url)).json(),
    );
    expect(LATEST_BALANCE_AGENT).toEqual({
      version,
      release_url: `https://github.com/stars-labs/message-dashboard/releases/tag/balance-agent-v${version}`,
    });
  });

  test('tags a release by its version', () => {
    expect(balanceAgentReleaseTag('0.2.0')).toBe('balance-agent-v0.2.0');
  });
});
