#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import * as v from 'valibot';
import packageMetadata from '../package.json' with { type: 'json' };
import type { BalanceRunnerCapability } from '../../shared/api/balance-runners.js';
import { errorText } from '../../shared/error-text.js';
import { textOr } from '../../shared/text.js';
import { createAgentService, requiredSettings, type ServiceState } from './agent-service.js';
import { testAIConnection } from './ai-connection.js';
import type { CheckResult, Settings } from './ipc/contract.js';
import { createKeychainStore, type KeychainStore } from './keychain-store.js';
import { createAuthSession } from './runner/auth-session.js';
import type { BrowserLauncher } from './runner/capabilities/carrier-browser-workflow.js';
import { CompanyAIProtocol } from './runner/company-ai.js';
import { createControlClient } from './runner/control-client.js';
import { acquireRunLock } from './run-lock.js';
import { createSettingsStore, type SettingsStore } from './settings-store.js';

type RunnerCapabilityName = BalanceRunnerCapability['capability'];

const CAPABILITIES = {
  all: ['sms_ai', 'carrier_browser'],
  'sms-ai': ['sms_ai'],
  'carrier-browser': ['carrier_browser'],
} as const;

const CONFIGURATION_OPTIONS = {
  'dashboard-url': { type: 'string' },
  'auth0-issuer': { type: 'string' },
  'auth0-client-id': { type: 'string' },
  'auth0-audience': { type: 'string' },
  'ai-base-url': { type: 'string' },
  'ai-model': { type: 'string' },
  'ai-protocol': { type: 'string' },
  name: { type: 'string' },
} as const;

const CONFIGURATION_KEYS: Readonly<Record<keyof typeof CONFIGURATION_OPTIONS, keyof Settings>> = {
  'dashboard-url': 'dashboardUrl',
  'auth0-issuer': 'auth0Issuer',
  'auth0-client-id': 'auth0ClientId',
  'auth0-audience': 'auth0Audience',
  'ai-base-url': 'aiBaseUrl',
  'ai-model': 'aiModel',
  'ai-protocol': 'aiProtocol',
  name: 'installationName',
};

function isConfigurationFlag(flag: string): flag is keyof typeof CONFIGURATION_OPTIONS {
  return Object.hasOwn(CONFIGURATION_OPTIONS, flag);
}

function isCapabilityOption(value: string): value is keyof typeof CAPABILITIES {
  return Object.hasOwn(CAPABILITIES, value);
}

interface CliService {
  initialize(): Promise<void>;
  snapshot(): Promise<Pick<ServiceState, 'auth' | 'smsAi' | 'browser'> & { error?: string | null }>;
  wait(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface CliDependencies {
  output?: (message: string) => void;
  error?: (message: string) => void;
  settingsStore?: SettingsStore;
  secureStore?: KeychainStore;
  configPath?: string;
  createService?: (options: Parameters<typeof createAgentService>[0]) => CliService;
  acquireLock?: (filePath: string) => Promise<() => Promise<void>>;
  runLockPath?: string;
}

interface CliContext {
  output: (message: string) => void;
  settingsStore: SettingsStore;
  secureStore: KeychainStore;
  createService?: CliDependencies['createService'];
  acquireLock?: CliDependencies['acquireLock'];
  runLockPath?: string;
}

function help() {
  return `Balance Agent CLI

Usage:
  balance-agent configure [options]
  balance-agent credentials set-ai-token|clear-ai-token
  balance-agent login
  balance-agent logout
  balance-agent status
  balance-agent doctor [--capability all|sms-ai|carrier-browser]
  balance-agent run [--capability all|sms-ai|carrier-browser] [--once]

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
  xdgConfigHome = process.env['XDG_CONFIG_HOME'],
  home = homedir(),
}: { xdgConfigHome?: string | undefined; home?: string } = {}) {
  const configHome = textOr((xdgConfigHome ?? '').trim(), join(home, '.config'));
  return join(configHome, 'message-dashboard', 'balance-agent.json');
}

function defaultRunLockPath({
  xdgStateHome = process.env['XDG_STATE_HOME'],
  home = homedir(),
}: { xdgStateHome?: string | undefined; home?: string } = {}) {
  const stateHome = textOr((xdgStateHome ?? '').trim(), join(home, '.local', 'state'));
  return join(stateHome, 'message-dashboard', 'balance-agent-cli.lock');
}

function defaultBrowserExecutable(platform: string = process.platform) {
  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return '/usr/bin/google-chrome';
}

export function selectedCapabilities(value = 'all'): readonly RunnerCapabilityName[] {
  if (!isCapabilityOption(value)) {
    throw new Error(`Unknown capability ${value}; expected all, sms-ai, or carrier-browser`);
  }
  return CAPABILITIES[value];
}

function parseCommand<const Options extends ParseArgsOptionsConfig>(
  argv: string[],
  options: Options,
) {
  return parseArgs({ args: argv, options, strict: true, allowPositionals: true });
}

async function ensureInstallation(settingsStore: SettingsStore, settings: Settings) {
  if (settings.installationId) return settings;
  return settingsStore.save({
    ...settings,
    installationId: randomUUID(),
    installationName: textOr(settings.installationName, hostname()),
    aiProtocol: textOr(settings.aiProtocol, 'anthropic'),
  });
}

async function configure(argv: string[], { settingsStore, output }: CliContext) {
  const { values, positionals } = parseCommand(argv, CONFIGURATION_OPTIONS);
  const [unexpected] = positionals;
  if (unexpected !== undefined) throw new Error(`Unexpected argument: ${unexpected}`);
  if (!Object.keys(values).length) {
    throw new Error('configure requires at least one configuration option');
  }
  const protocol = values['ai-protocol'];
  if (protocol && !v.is(CompanyAIProtocol, protocol)) {
    throw new Error('AI protocol must be anthropic or openai');
  }
  const current = await settingsStore.load();
  const updates: { -readonly [K in keyof Settings]?: string } = {};
  for (const [flag, value] of Object.entries(values)) {
    if (isConfigurationFlag(flag) && typeof value === 'string') {
      updates[CONFIGURATION_KEYS[flag]] = value;
    }
  }
  await ensureInstallation(settingsStore, await settingsStore.save({ ...current, ...updates }));
  output('Balance Agent configuration saved.');
}

async function credentials(argv: string[], { secureStore, output }: CliContext) {
  const [action, ...rest] = argv;
  const [extra] = rest;
  if (extra !== undefined) throw new Error(`Unexpected argument: ${extra}`);
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

function authSession(settings: Settings, secureStore: KeychainStore) {
  return createAuthSession({ getConfiguration: () => settings, secureStore });
}

function assertNoArguments([first]: readonly string[]) {
  if (first !== undefined) throw new Error(`Unexpected argument: ${first}`);
}

async function login(argv: string[], { settingsStore, secureStore, output }: CliContext) {
  assertNoArguments(argv);
  const settings = await ensureInstallation(settingsStore, await settingsStore.load());
  const missing = requiredSettings(settings);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
  await authSession(settings, secureStore).signIn({
    onDeviceCode: ({ userCode, verificationUri, verificationUriComplete }) => {
      output(`Open: ${textOr(verificationUriComplete, verificationUri ?? '')}`);
      output(`Authorization code: ${userCode}`);
      output('Waiting for authorization...');
    },
  });
  output('Balance Agent signed in.');
}

async function logout(argv: string[], { settingsStore, secureStore, output }: CliContext) {
  assertNoArguments(argv);
  const settings = await settingsStore.load();
  await authSession(settings, secureStore).signOut();
  output('Balance Agent signed out locally.');
}

async function status(argv: string[], { settingsStore, secureStore, output }: CliContext) {
  assertNoArguments(argv);
  const settings = await settingsStore.load();
  const missing = requiredSettings(settings);
  const [signedIn, hasAiToken] = await Promise.all([
    authSession(settings, secureStore).hasRefreshToken(),
    secureStore.get('aiToken').then(Boolean),
  ]);
  output(`Configuration: ${missing.length ? `incomplete (${missing.join(', ')})` : 'ready'}`);
  output(`Authentication: ${signedIn ? 'signed in' : 'signed out'}`);
  output(
    `SMS AI: ${settings.aiBaseUrl && settings.aiModel && hasAiToken ? 'configured' : 'configuration required'}`,
  );
  output(`Browser: ${defaultBrowserExecutable()}`);
}

async function dashboardDiagnostic(
  settings: Settings,
  session: ReturnType<typeof authSession>,
): Promise<CheckResult> {
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
    return { ok: false, message: errorText(error) };
  }
}

async function doctor(argv: string[], { settingsStore, secureStore, output }: CliContext) {
  const { values, positionals } = parseCommand(argv, {
    capability: { type: 'string', default: 'all' },
  });
  assertNoArguments(positionals);
  const capabilities = selectedCapabilities(values.capability);
  const settings = await settingsStore.load();
  const missing = requiredSettings(settings);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);

  const results: [string, CheckResult][] = [];
  const session = authSession(settings, secureStore);
  results.push(['Dashboard', await dashboardDiagnostic(settings, session)]);

  if (capabilities.includes('sms_ai')) {
    const aiToken = await secureStore.get('aiToken');
    const result = await testAIConnection({ ...settings, aiToken });
    results.push(['SMS AI', result]);
  }
  if (capabilities.includes('carrier_browser')) {
    const executable = defaultBrowserExecutable();
    const result: CheckResult = await access(executable)
      .then(() => ({ ok: true, message: executable }))
      .catch(() => ({ ok: false, message: `browser not found at ${executable}` }));
    results.push(['Browser', result]);
  }

  for (const [label, result] of results) {
    output(`${result.ok ? 'OK' : 'FAIL'}  ${label}: ${result.message}`);
  }
  return results.every(([, result]) => result.ok) ? 0 : 1;
}

async function run(
  argv: string[],
  {
    settingsStore,
    secureStore,
    output,
    createService = createAgentService,
    acquireLock = acquireRunLock,
    runLockPath = defaultRunLockPath(),
  }: CliContext,
) {
  const { values, positionals } = parseCommand(argv, {
    capability: { type: 'string', default: 'all' },
    once: { type: 'boolean', default: false },
  });
  assertNoArguments(positionals);
  const capabilities = selectedCapabilities(values.capability);
  const settings = await ensureInstallation(settingsStore, await settingsStore.load());
  const missing = requiredSettings(settings);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);

  let browser: BrowserLauncher | null = null;
  let browserExecutablePath: string | null = null;
  if (capabilities.includes('carrier_browser')) {
    ({ chromium: browser } = await import('playwright-core'));
    browserExecutablePath = defaultBrowserExecutable();
  }

  const service = createService({
    settingsStore,
    secureStore,
    openExternal: () => Promise.resolve(),
    browser,
    browserExecutablePath,
    appVersion: packageMetadata.version,
    enabledCapabilities: capabilities,
    once: values.once,
  });
  const releaseLock = await acquireLock(runLockPath);
  let stopping = false;
  let stopResolve: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });
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
      throw new Error(
        textOr(state.error, 'Balance Agent is not signed in; run balance-agent login'),
      );
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

export async function runCli(argv: string[], dependencies: CliDependencies = {}) {
  const output =
    dependencies.output ??
    ((message: string) => {
      console.log(message);
    });
  const error =
    dependencies.error ??
    ((message: string) => {
      console.error(message);
    });
  const settingsStore =
    dependencies.settingsStore ??
    createSettingsStore(dependencies.configPath ?? defaultConfigPath());
  const secureStore = dependencies.secureStore ?? createKeychainStore();
  const context: CliContext = {
    ...dependencies,
    output,
    settingsStore,
    secureStore,
  };
  const [command = 'help', ...rest] = argv;

  try {
    if (command === 'help' || command === '--help' || command === '-h') {
      output(help());
      return 0;
    }
    if (command === 'configure') {
      await configure(rest, context);
      return 0;
    }
    if (command === 'credentials') {
      await credentials(rest, context);
      return 0;
    }
    if (command === 'login') {
      await login(rest, context);
      return 0;
    }
    if (command === 'logout') {
      await logout(rest, context);
      return 0;
    }
    if (command === 'status') {
      await status(rest, context);
      return 0;
    }
    if (command === 'doctor') return await doctor(rest, context);
    if (command === 'run') return await run(rest, context);
    throw new Error(`Unknown command: ${command}`);
  } catch (caught) {
    error(`balance-agent: ${errorText(caught)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}

export { defaultBrowserExecutable, defaultConfigPath, defaultRunLockPath, help };
