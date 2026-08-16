#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import packageMetadata from '../package.json' with { type: 'json' };
import { createAuthSession } from '../../runner-core/auth-session.js';
import { createControlClient } from '../../runner-core/control-client.js';
import { createAgentService } from './agent-service.js';
import { testAIConnection } from './ai-connection.js';
import { createKeychainStore } from './keychain-store.js';
import { acquireRunLock } from './run-lock.js';
import { createSettingsStore } from './settings-store.js';

const CAPABILITIES = Object.freeze({
  all: ['sms_ai', 'unicom_browser'],
  'sms-ai': ['sms_ai'],
  'unicom-browser': ['unicom_browser'],
});

const CONFIGURATION_OPTIONS = Object.freeze({
  'dashboard-url': { type: 'string' },
  'auth0-issuer': { type: 'string' },
  'auth0-client-id': { type: 'string' },
  'auth0-audience': { type: 'string' },
  'ai-base-url': { type: 'string' },
  'ai-model': { type: 'string' },
  'ai-protocol': { type: 'string' },
  name: { type: 'string' },
});

const CONFIGURATION_KEYS = Object.freeze({
  'dashboard-url': 'dashboardUrl',
  'auth0-issuer': 'auth0Issuer',
  'auth0-client-id': 'auth0ClientId',
  'auth0-audience': 'auth0Audience',
  'ai-base-url': 'aiBaseUrl',
  'ai-model': 'aiModel',
  'ai-protocol': 'aiProtocol',
  name: 'installationName',
});

function help() {
  return `Balance Agent CLI

Usage:
  balance-agent configure [options]
  balance-agent credentials set-ai-token|clear-ai-token
  balance-agent login
  balance-agent logout
  balance-agent status
  balance-agent doctor [--capability all|sms-ai|unicom-browser]
  balance-agent run [--capability all|sms-ai|unicom-browser] [--once]

Configuration options:
  --dashboard-url URL
  --auth0-issuer URL
  --auth0-client-id ID
  --auth0-audience AUDIENCE
  --ai-base-url URL
  --ai-model MODEL
  --ai-protocol anthropic|openai
  --name NAME

Credentials are stored in macOS Keychain. The CLI never accepts secret values as
command-line arguments.`;
}

function defaultConfigPath({
  xdgConfigHome = process.env.XDG_CONFIG_HOME,
  home = homedir(),
} = {}) {
  const configHome = String(xdgConfigHome || '').trim() || join(home, '.config');
  return join(configHome, 'message-dashboard', 'balance-agent.json');
}

function defaultRunLockPath({
  xdgStateHome = process.env.XDG_STATE_HOME,
  home = homedir(),
} = {}) {
  const stateHome = String(xdgStateHome || '').trim() || join(home, '.local', 'state');
  return join(stateHome, 'message-dashboard', 'balance-agent-cli.lock');
}

function defaultBrowserExecutable(platform = process.platform) {
  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return '/usr/bin/google-chrome';
}

function requiredSettings(settings) {
  return ['dashboardUrl', 'auth0Issuer', 'auth0ClientId', 'auth0Audience']
    .filter((key) => !settings[key]);
}

function selectedCapabilities(value = 'all') {
  const capabilities = CAPABILITIES[value];
  if (!capabilities) {
    throw new Error(`Unknown capability ${value}; expected all, sms-ai, or unicom-browser`);
  }
  return capabilities;
}

function parseCommand(argv, options = {}) {
  return parseArgs({ args: argv, options, strict: true, allowPositionals: true });
}

async function ensureInstallation(settingsStore, settings) {
  if (settings.installationId) return settings;
  return settingsStore.save({
    ...settings,
    installationId: randomUUID(),
    installationName: settings.installationName || hostname(),
    aiProtocol: settings.aiProtocol || 'anthropic',
  });
}

async function configure(argv, { settingsStore, output }) {
  const { values, positionals } = parseCommand(argv, CONFIGURATION_OPTIONS);
  if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
  if (!Object.keys(values).length) {
    throw new Error('configure requires at least one configuration option');
  }
  if (values['ai-protocol'] && !['anthropic', 'openai'].includes(values['ai-protocol'])) {
    throw new Error('AI protocol must be anthropic or openai');
  }
  const current = await settingsStore.load();
  const updates = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [CONFIGURATION_KEYS[key], value]),
  );
  await ensureInstallation(settingsStore, await settingsStore.save({ ...current, ...updates }));
  output('Balance Agent configuration saved.');
}

async function credentials(argv, { secureStore, output }) {
  const [action, ...rest] = argv;
  if (rest.length) throw new Error(`Unexpected argument: ${rest[0]}`);
  if (action === 'set-ai-token') {
    output('Enter the company AI token at the macOS Keychain prompt.');
    await secureStore.promptSet('aiToken');
    output('Company AI token saved in macOS Keychain.');
    return;
  }
  if (action === 'clear-ai-token') {
    await secureStore.set('aiToken', null);
    output('Company AI token removed from macOS Keychain.');
    return;
  }
  throw new Error('Usage: balance-agent credentials set-ai-token|clear-ai-token');
}

function authSession(settings, secureStore) {
  return createAuthSession({ getConfiguration: () => settings, secureStore });
}

async function login(argv, { settingsStore, secureStore, output }) {
  if (argv.length) throw new Error(`Unexpected argument: ${argv[0]}`);
  const settings = await ensureInstallation(settingsStore, await settingsStore.load());
  const missing = requiredSettings(settings);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
  await authSession(settings, secureStore).signIn({
    onDeviceCode: ({ userCode, verificationUri, verificationUriComplete }) => {
      output(`Open: ${verificationUriComplete || verificationUri}`);
      output(`Authorization code: ${userCode}`);
      output('Waiting for authorization...');
    },
  });
  output('Balance Agent signed in.');
}

async function logout(argv, { settingsStore, secureStore, output }) {
  if (argv.length) throw new Error(`Unexpected argument: ${argv[0]}`);
  const settings = await settingsStore.load();
  await authSession(settings, secureStore).signOut();
  output('Balance Agent signed out locally.');
}

async function status(argv, { settingsStore, secureStore, output }) {
  if (argv.length) throw new Error(`Unexpected argument: ${argv[0]}`);
  const settings = await settingsStore.load();
  const missing = requiredSettings(settings);
  const [signedIn, hasAiToken] = await Promise.all([
    authSession(settings, secureStore).hasRefreshToken(),
    secureStore.get('aiToken').then(Boolean),
  ]);
  output(`Configuration: ${missing.length ? `incomplete (${missing.join(', ')})` : 'ready'}`);
  output(`Authentication: ${signedIn ? 'signed in' : 'signed out'}`);
  output(`SMS AI: ${settings.aiBaseUrl && settings.aiModel && hasAiToken ? 'configured' : 'configuration required'}`);
  output(`Browser: ${defaultBrowserExecutable()}`);
}

async function dashboardDiagnostic(settings, session) {
  try {
    const client = createControlClient({
      baseUrl: settings.dashboardUrl,
      getAccessToken: () => session.getAccessToken(),
    });
    const response = await client.request('/api/control/balance-runners/check');
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: 'login is invalid or lacks runner permissions' };
    }
    if (!response.ok) return { ok: false, message: `Dashboard returned ${response.status}` };
    return { ok: true, message: 'authentication and connection are valid' };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

async function doctor(argv, { settingsStore, secureStore, output }) {
  const { values, positionals } = parseCommand(argv, {
    capability: { type: 'string', default: 'all' },
  });
  if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
  const capabilities = selectedCapabilities(values.capability);
  const settings = await settingsStore.load();
  const missing = requiredSettings(settings);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);

  const results = [];
  const session = authSession(settings, secureStore);
  results.push(['Dashboard', await dashboardDiagnostic(settings, session)]);

  if (capabilities.includes('sms_ai')) {
    const aiToken = await secureStore.get('aiToken');
    const result = await testAIConnection({ ...settings, aiToken });
    results.push(['SMS AI', result]);
  }
  if (capabilities.includes('unicom_browser')) {
    const executable = defaultBrowserExecutable();
    const result = await access(executable)
      .then(() => ({ ok: true, message: executable }))
      .catch(() => ({ ok: false, message: `browser not found at ${executable}` }));
    results.push(['Browser', result]);
  }

  for (const [label, result] of results) {
    output(`${result.ok ? 'OK' : 'FAIL'}  ${label}: ${result.message}`);
  }
  return results.every(([, result]) => result.ok) ? 0 : 1;
}

async function run(argv, {
  settingsStore,
  secureStore,
  output,
  createService = createAgentService,
  acquireLock = acquireRunLock,
  runLockPath = defaultRunLockPath(),
}) {
  const { values, positionals } = parseCommand(argv, {
    capability: { type: 'string', default: 'all' },
    once: { type: 'boolean', default: false },
  });
  if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
  const capabilities = selectedCapabilities(values.capability);
  const settings = await ensureInstallation(settingsStore, await settingsStore.load());
  const missing = requiredSettings(settings);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);

  let browser = null;
  let browserExecutablePath = null;
  if (capabilities.includes('unicom_browser')) {
    ({ chromium: browser } = await import('playwright-core'));
    browserExecutablePath = defaultBrowserExecutable();
  }

  const service = createService({
    settingsStore,
    secureStore,
    openExternal: async () => {},
    browser,
    browserExecutablePath,
    appVersion: packageMetadata.version,
    enabledCapabilities: capabilities,
    once: values.once,
  });
  const releaseLock = await acquireLock(runLockPath);
  let stopping = false;
  let stopResolve;
  const stopped = new Promise((resolve) => { stopResolve = resolve; });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    stopResolve();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await service.initialize();
    const state = await service.snapshot();
    if (state.auth !== 'signed_in') {
      throw new Error(state.error || 'Balance Agent is not signed in; run balance-agent login');
    }
    const active = capabilities.some((capability) => {
      const value = capability === 'sms_ai' ? state.smsAi : state.browser;
      return value !== 'configuration_required' && value !== 'stopped';
    });
    if (!active) throw new Error('No selected capability is configured');

    output(`Balance Agent started (${values.capability}${values.once ? ', once' : ''}).`);
    if (values.once) await service.wait();
    else await stopped;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    try {
      await service.shutdown();
    } finally {
      await releaseLock();
    }
  }
  return 0;
}

export async function runCli(argv, dependencies = {}) {
  const output = dependencies.output || ((message) => console.log(message));
  const error = dependencies.error || ((message) => console.error(message));
  const settingsStore = dependencies.settingsStore
    || createSettingsStore(dependencies.configPath || defaultConfigPath());
  const secureStore = dependencies.secureStore || createKeychainStore();
  const context = { ...dependencies, output, error, settingsStore, secureStore };
  const [command = 'help', ...rest] = argv;

  try {
    if (command === 'help' || command === '--help' || command === '-h') {
      output(help());
      return 0;
    }
    if (command === 'configure') return await configure(rest, context) ?? 0;
    if (command === 'credentials') return await credentials(rest, context) ?? 0;
    if (command === 'login') return await login(rest, context) ?? 0;
    if (command === 'logout') return await logout(rest, context) ?? 0;
    if (command === 'status') return await status(rest, context) ?? 0;
    if (command === 'doctor') return await doctor(rest, context);
    if (command === 'run') return await run(rest, context);
    throw new Error(`Unknown command: ${command}`);
  } catch (caught) {
    error(`balance-agent: ${caught.message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}

export {
  defaultBrowserExecutable,
  defaultConfigPath,
  defaultRunLockPath,
  help,
  selectedCapabilities,
};
