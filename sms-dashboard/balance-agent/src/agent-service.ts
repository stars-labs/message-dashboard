import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import * as v from 'valibot';
import type { BalanceRunnerCapability } from '../../shared/api/balance-runners.js';
import { errorText } from '../../shared/error-text.js';
import { textOr } from '../../shared/text.js';
import {
  testAIConnection,
  type AiConnectionInput,
  type ConnectionLogger,
} from './ai-connection.js';
import {
  BLANK_SETTINGS,
  type AgentState,
  type AiTestResult,
  type CheckResult,
  type ConfigurationResults,
  type Settings,
  type SettingsForm,
} from './ipc/contract.js';
import { createAuthSession } from './runner/auth-session.js';
import { createCarrierBrowserCapability } from './runner/capabilities/carrier-browser.js';
import {
  createCarrierBrowserJobProcessor,
  type BrowserLauncher,
} from './runner/capabilities/carrier-browser-workflow.js';
import { createSmsAiCapability } from './runner/capabilities/sms-ai.js';
import { callCompanyAI, companyAIReachable, CompanyAIProtocol } from './runner/company-ai.js';
import { createControlClient } from './runner/control-client.js';
import { createRunnerPresence, type CapabilityPresence } from './runner/presence.js';
import { runSerialCapability } from './runner/serial-runner.js';
import type { SecureStore } from './secure-store.js';
import type { SettingsStore } from './settings-store.js';

type RunnerCapabilityName = BalanceRunnerCapability['capability'];

export type ServiceState = Omit<AgentState, 'settings' | 'hasAiToken' | 'openAtLogin'>;

export type AgentSnapshot = Omit<AgentState, 'openAtLogin'>;

interface ServiceLogger extends ConnectionLogger {
  log(message: string): void;
}

const REQUIRED_SETTING_KEYS = [
  'dashboardUrl',
  'auth0Issuer',
  'auth0ClientId',
  'auth0Audience',
] as const;

type RequiredSettingKey = (typeof REQUIRED_SETTING_KEYS)[number];

export const INITIAL_SERVICE_STATE: ServiceState = Object.freeze({
  auth: 'signed_out',
  smsAi: 'stopped',
  smsAiDetail: null,
  browser: 'configuration_required',
  browserDetail: 'browser_runtime_unavailable',
  login: null,
  error: null,
});

export function requiredSettings(
  settings: Pick<Settings, RequiredSettingKey>,
): RequiredSettingKey[] {
  return REQUIRED_SETTING_KEYS.filter((key) => !settings[key]);
}

export function createAgentService({
  settingsStore,
  secureStore,
  openExternal,
  browser = null,
  browserExecutablePath = null,
  appVersion = 'development',
  platform = process.platform,
  enabledCapabilities = ['sms_ai', 'carrier_browser'],
  once = false,
  logger = console,
  onState = () => undefined,
}: {
  settingsStore: SettingsStore;
  secureStore: Pick<SecureStore, 'get' | 'set'>;
  openExternal: (url: string) => Promise<unknown>;
  browser?: BrowserLauncher | null;
  browserExecutablePath?: string | null;
  appVersion?: string;
  platform?: string;
  enabledCapabilities?: readonly RunnerCapabilityName[];
  once?: boolean;
  logger?: ServiceLogger;
  onState?: (state: ServiceState) => void;
}) {
  let settings: Settings = BLANK_SETTINGS;
  let loginController: AbortController | null = null;
  let smsController: AbortController | null = null;
  let runnerPresence: ReturnType<typeof createRunnerPresence> | null = null;
  let smsLoop: Promise<void> | null = null;
  let browserController: AbortController | null = null;
  let browserLoop: Promise<void> | null = null;
  let browserProcessor: ReturnType<typeof createCarrierBrowserJobProcessor> | null = null;
  const sessionId = randomUUID();
  const enabled = new Set(enabledCapabilities);
  const authSession = createAuthSession({
    getConfiguration: () => settings,
    secureStore,
  });
  const state: ServiceState = { ...INITIAL_SERVICE_STATE };

  function configuredBrowserState(): ServiceState['browser'] {
    if (!enabled.has('carrier_browser')) return 'stopped';
    return browser && browserExecutablePath ? 'ready' : 'configuration_required';
  }

  function publish(patch: Partial<ServiceState> = {}) {
    Object.assign(state, patch);
    onState({ ...state });
  }

  function publishingPresence(
    presence: NonNullable<typeof runnerPresence>,
    capability: RunnerCapabilityName,
    toPatch: (
      nextState: Parameters<CapabilityPresence['set']>[0],
      detailCode: string | null,
    ) => Partial<ServiceState>,
  ): CapabilityPresence {
    return Object.freeze<CapabilityPresence>({
      async set(nextState, jobId, detailCode) {
        publish(toPatch(nextState, textOr(detailCode, null)));
        await presence.set(capability, nextState, jobId, detailCode);
      },
    });
  }

  async function runAiTest(input: SettingsForm): Promise<AiTestResult> {
    const candidate = { ...settings, ...input };
    const typedToken = (input.aiToken ?? '').trim();
    const candidateInput: AiConnectionInput = {
      aiBaseUrl: candidate.aiBaseUrl,
      aiModel: candidate.aiModel,
      aiProtocol: textOr(candidate.aiProtocol, 'anthropic').trim(),
      aiToken: textOr(typedToken, null) ?? (await secureStore.get('aiToken')),
    };
    return testAIConnection(candidateInput, { logger });
  }

  async function testDashboard(input: SettingsForm): Promise<CheckResult> {
    if (state.auth !== 'signed_in') return { ok: false, message: '请先登录 Dashboard' };
    const dashboardUrl = textOr(input.dashboardUrl, settings.dashboardUrl).trim();
    if (!dashboardUrl) return { ok: false, message: '请先填写 Dashboard URL' };
    try {
      const client = createControlClient({
        baseUrl: dashboardUrl,
        getAccessToken: () => authSession.getAccessToken(),
      });
      const response = await client.request('/api/control/balance-runners/check');
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: '登录无效或缺少 Runner 权限' };
      }
      if (!response.ok) return { ok: false, message: `Dashboard 返回 ${response.status}` };
      return { ok: true, message: '认证和连接正常' };
    } catch (error) {
      return { ok: false, message: `无法连接 Dashboard：${errorText(error)}` };
    }
  }

  async function testBrowser(): Promise<CheckResult> {
    if (!browser || !browserExecutablePath) {
      return { ok: false, message: '浏览器运行时不可用' };
    }
    try {
      await access(browserExecutablePath);
      return { ok: true, message: '浏览器运行时可用' };
    } catch {
      return { ok: false, message: '找不到浏览器运行文件，请重新安装 Agent' };
    }
  }

  async function stopCapabilities() {
    smsController?.abort();
    browserController?.abort();
    smsController = null;
    browserController = null;
    browserProcessor = null;
    await Promise.all(
      [smsLoop, browserLoop]
        .filter((loop) => loop !== null)
        .map((loop) => loop.catch(() => undefined)),
    );
    smsLoop = null;
    browserLoop = null;
    await runnerPresence?.stop();
    runnerPresence = null;
    publish({
      smsAi: 'stopped',
      smsAiDetail: null,
      browser: 'configuration_required',
      browserDetail: 'browser_runtime_unavailable',
    });
  }

  async function startCapabilities() {
    await stopCapabilities();
    const missing = requiredSettings(settings);
    if (missing.length) {
      publish({ error: `Missing configuration: ${missing.join(', ')}` });
      return;
    }
    const aiToken = enabled.has('sms_ai') ? await secureStore.get('aiToken') : null;
    const controlClient = createControlClient({
      baseUrl: settings.dashboardUrl,
      getAccessToken: () => authSession.getAccessToken(),
    });
    const presence = createRunnerPresence({
      controlClient,
      runnerId: settings.installationId,
      sessionId,
      displayName: textOr(settings.installationName, hostname()),
      version: appVersion,
      platform,
      logger,
      capabilities: [...enabled],
    });
    runnerPresence = presence;
    await presence.start();
    if (enabled.has('carrier_browser')) {
      const browserPresence = publishingPresence(presence, 'carrier_browser', (next, detail) => ({
        browser: next,
        browserDetail: detail,
      }));
      if (browser && browserExecutablePath) {
        await browserPresence.set('ready');
        const processor = createCarrierBrowserJobProcessor({
          controlClient,
          presence: browserPresence,
          runnerId: sessionId,
          browser,
          executablePath: browserExecutablePath,
          logger,
        });
        browserProcessor = processor;
        const browserCapability = createCarrierBrowserCapability({
          controlClient,
          presence: browserPresence,
          runnerId: sessionId,
          processJob: processor.processJob,
        });
        browserController = new AbortController();
        browserLoop = runSerialCapability({
          runOne: browserCapability.runOne,
          once,
          signal: browserController.signal,
          onError: (error) => {
            logger.error(errorText(error));
            publish({ browser: 'degraded', error: errorText(error) });
          },
        });
      } else {
        await browserPresence.set('configuration_required', null, 'browser_runtime_unavailable');
      }
    } else {
      publish({ browser: 'stopped', browserDetail: null });
    }

    if (!enabled.has('sms_ai')) {
      publish({ smsAi: 'stopped', smsAiDetail: null, error: null });
      return;
    }
    const smsPresence = publishingPresence(presence, 'sms_ai', (next, detail) => ({
      smsAi: next,
      smsAiDetail: detail,
    }));
    const aiProtocol = v.safeParse(CompanyAIProtocol, textOr(settings.aiProtocol, 'anthropic'));
    if (!aiToken || !settings.aiBaseUrl || !settings.aiModel || !aiProtocol.success) {
      await smsPresence.set('configuration_required', null, 'ai_configuration_required');
      publish({
        smsAi: 'configuration_required',
        browser: configuredBrowserState(),
        error: null,
      });
      return;
    }

    const capability = createSmsAiCapability({
      controlClient,
      presence: smsPresence,
      runnerId: sessionId,
      aiBaseUrl: settings.aiBaseUrl,
      aiToken,
      aiModel: settings.aiModel,
      aiProtocol: aiProtocol.output,
      callAI: callCompanyAI,
      isAIReachable: companyAIReachable,
      logger,
    });
    smsController = new AbortController();
    await smsPresence.set('ready');
    publish({
      smsAi: 'ready',
      browser: configuredBrowserState(),
      error: null,
    });
    smsLoop = runSerialCapability({
      runOne: async (options) => {
        const result = await capability.runOne(options);
        publish({ smsAi: 'ready', error: null });
        return result;
      },
      once,
      signal: smsController.signal,
      onError: (error) => {
        logger.error(errorText(error));
        publish({ smsAi: 'degraded', error: errorText(error) });
      },
    });
  }

  async function snapshot(): Promise<AgentSnapshot> {
    const hasAiToken = enabled.has('sms_ai') && Boolean(await secureStore.get('aiToken'));
    return {
      ...state,
      settings: { ...settings },
      hasAiToken,
    };
  }

  return Object.freeze({
    async initialize() {
      settings = await settingsStore.load();
      if (!settings.installationId) {
        settings = await settingsStore.save({
          ...settings,
          installationId: randomUUID(),
          installationName: textOr(settings.installationName, hostname()),
        });
      }
      const hasRefreshToken = await authSession.hasRefreshToken();
      publish({ auth: hasRefreshToken ? 'signed_in' : 'signed_out' });
      if (hasRefreshToken) {
        try {
          await authSession.getAccessToken();
          await startCapabilities();
        } catch (error) {
          publish({ auth: 'signed_out', error: errorText(error) });
        }
      }
    },

    snapshot,

    async saveSettings(input: SettingsForm) {
      const { aiToken, ...fields } = input;
      settings = await settingsStore.save({ ...settings, ...fields });
      if (Object.hasOwn(input, 'aiToken')) await secureStore.set('aiToken', aiToken);
      publish({ error: null });
      if (state.auth === 'signed_in') await startCapabilities();
      return snapshot();
    },

    testAI(input: SettingsForm) {
      return runAiTest(input);
    },

    async testConfiguration(input: SettingsForm): Promise<ConfigurationResults> {
      const [dashboard, ai, browserResult] = await Promise.all([
        testDashboard(input),
        runAiTest(input),
        testBrowser(),
      ]);
      return { dashboard, ai, browser: browserResult };
    },

    async signIn() {
      if (requiredSettings(settings).length)
        throw new Error('Save dashboard and Auth0 settings first');
      loginController?.abort();
      const controller = new AbortController();
      loginController = controller;
      publish({ auth: 'authorizing', error: null });
      try {
        await authSession.signIn({
          signal: controller.signal,
          onDeviceCode: async ({ userCode, verificationUri, verificationUriComplete }) => {
            publish({ login: { userCode, verificationUri } });
            const target = textOr(verificationUriComplete, verificationUri ?? null);
            if (!target) throw new Error('Auth0 returned no verification URL');
            await openExternal(target);
          },
        });
        publish({ auth: 'signed_in', login: null });
        await startCapabilities();
      } catch (error) {
        publish({ auth: 'signed_out', login: null, error: errorText(error) });
        throw error;
      } finally {
        loginController = null;
      }
    },

    async signOut() {
      loginController?.abort();
      await stopCapabilities();
      await authSession.signOut();
      publish({ auth: 'signed_out', login: null, error: null });
    },

    async showVerification() {
      return (await browserProcessor?.showActiveBrowser()) ?? false;
    },

    async wait() {
      await Promise.all([smsLoop, browserLoop].filter((loop) => loop !== null));
    },

    async shutdown() {
      loginController?.abort();
      await stopCapabilities();
    },
  });
}

export type AgentService = ReturnType<typeof createAgentService>;
