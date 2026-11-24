import { describe, expect, test } from 'bun:test';
import { remoteBindings, strayKeychainServices, strayStacks } from './doctor.ts';

describe('verify doctor', () => {
  test('names every binding that would reach Cloudflare from a local run', () => {
    const toml = `
name = "sms-dashboard"

[[d1_databases]]
binding = "DB"
database_name = "sms-dashboard"

[[kv_namespaces]]
binding = "SESSIONS"
remote = true

[ai]
binding = "AI"
experimental_remote = true
`;
    expect(remoteBindings(toml)).toEqual(['kv_namespaces.SESSIONS', 'ai.AI']);
  });

  test('finds nothing remote in an all-local config', () => {
    expect(remoteBindings('[[d1_databases]]\nbinding = "DB"\n')).toEqual([]);
  });

  test('finds Keychain items a Balance Agent sandbox left behind, not the real ones', () => {
    const dump = [
      'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
      '    "acct"<blob>="aiToken"',
      '    "svce"<blob>="io.qzz.message-dashboard.balance-agent.verify-1b2c"',
      '    "acct"<blob>="aiToken"',
      '    "svce"<blob>="io.qzz.message-dashboard.balance-agent.cli"',
      '    "acct"<blob>="auth0RefreshToken"',
      '    "svce"<blob>="io.qzz.message-dashboard.balance-agent.verify-1b2c"',
    ].join('\n');
    expect(strayKeychainServices(dump)).toEqual([
      'io.qzz.message-dashboard.balance-agent.verify-1b2c',
    ]);
  });

  test('picks out processes a verify or e2e stack left running', () => {
    const ps = [
      '  101 node node_modules/wrangler/bin/wrangler.js dev --local --persist-to /tmp/sms-dashboard-stack-abc --port 5100',
      '  102 /path/workerd serve --config /tmp/sms-dashboard-stack-abc/x',
      '  103 node node_modules/wrangler/bin/wrangler.js dev --port 8787',
      '  104 /bin/zsh',
      '  105 /x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --user-data-dir=/tmp/sms-dashboard-agent-app-q1 /x/balance-agent',
      '  106 /Applications/Balance Agent.app/Contents/MacOS/Balance Agent',
    ].join('\n');
    expect(strayStacks(ps)).toEqual(['101', '102', '105']);
  });
});
