import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { createControlClient } from '../../runner-core/control-client.js';
import { createAuthSession } from '../../runner-core/auth-session.js';
import { createRunnerPresence } from '../../runner-core/presence.js';
import { runSerialCapability } from '../../runner-core/serial-runner.js';
import { createSmsAiCapability } from '../../runner-core/capabilities/sms-ai.js';
import { createUnicomBrowserCapability } from '../../runner-core/capabilities/unicom-browser.js';
import { createUnicomBrowserJobProcessor } from '../../runner-core/capabilities/unicom-browser-workflow.js';
import { callCompanyAI, companyAIReachable } from '../../server/utils/company-ai.js';
import { testAIConnection } from './ai-connection.js';

function requiredSettings(settings) {
  return ['dashboardUrl', 'auth0Issuer', 'auth0ClientId', 'auth0Audience']
    .filter((key) => !settings[key]);
}

export function createAgentService({
  settingsStore,
  secureStore,
  openExternal,
  browser = null,
  browserExecutablePath = null,
  appVersion = 'development',
  platform = process.platform,
  enabledCapabilities = ['sms_ai', 'unicom_browser'],
  once = false,
  logger = console,
  onState = () => {},
}) {
  let settings = {};
  let loginController = null;
  let smsController = null;
  let smsPresence = null;
  let browserPresence = null;
  let smsLoop = null;
  let browserController = null;
  let browserLoop = null;
  let browserProcessor = null;
  const sessionId = randomUUID();
  const enabled = new Set(enabledCapabilities);
  const authSession = createAuthSession({
    getConfiguration: () => settings,
    secureStore,
  });
  const state = {
    auth: 'signed_out',
    smsAi: 'stopped',
    smsAiDetail: null,
    browser: 'configuration_required',
    browserDetail: 'browser_runtime_unavailable',
    login: null,
    error: null,
  };

  function configuredBrowserState() {
    if (!enabled.has('unicom_browser')) return 'stopped';
    return browser && browserExecutablePath ? 'ready' : 'configuration_required';
  }

  function publish(patch = {}) {
    Object.assign(state, patch);
    onState({ ...state });
  }

  function publishingPresence(controlClient, capability, stateKey) {
    const presence = createRunnerPresence({
      controlClient,
      runnerId: settings.installationId,
      sessionId,
      displayName: settings.installationName || hostname(),
      version: appVersion,
      platform,
      logger,
      capability,
    });
    return Object.freeze({
      start: () => presence.start(),
      stop: () => presence.stop(),
      async set(nextState, jobId, detailCode) {
        publish({
          [stateKey]: nextState,
          [`${stateKey}Detail`]: detailCode || null,
        });
        await presence.set(nextState, jobId, detailCode);
      },
    });
  }

  async function runAiTest(input = {}) {
    const candidate = { ...settings, ...input };
    candidate.aiProtocol = String(candidate.aiProtocol || 'anthropic').trim();
    candidate.aiToken = String(input?.aiToken || '').trim()
      || await secureStore.get('aiToken');
    return testAIConnection(candidate);
  }

  async function testDashboard(input = {}) {
    if (state.auth !== 'signed_in') return { ok: false, message: '请先登录 Dashboard' };
    const dashboardUrl = String(input.dashboardUrl || settings.dashboardUrl || '').trim();
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
      return { ok: false, message: `无法连接 Dashboard：${error.message}` };
    }
  }

  async function testBrowser() {
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
    await Promise.all([smsLoop, browserLoop].filter(Boolean).map((loop) => loop.catch(() => {})));
    smsLoop = null;
    browserLoop = null;
    await Promise.all([
      smsPresence?.stop(),
      browserPresence?.stop(),
    ].filter(Boolean));
    smsPresence = null;
    browserPresence = null;
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
    if (enabled.has('unicom_browser')) {
      browserPresence = publishingPresence(controlClient, 'unicom_browser', 'browser');
      await browserPresence.start();
      if (browser && browserExecutablePath) {
        browserProcessor = createUnicomBrowserJobProcessor({
          controlClient,
          presence: browserPresence,
          runnerId: sessionId,
          browser,
          executablePath: browserExecutablePath,
          logger,
        });
        const browserCapability = createUnicomBrowserCapability({
          controlClient,
          presence: browserPresence,
          runnerId: sessionId,
          processJob: browserProcessor.processJob,
        });
        browserController = new AbortController();
        browserLoop = runSerialCapability({
          runOne: browserCapability.runOne,
          once,
          signal: browserController.signal,
          onError: (error) => {
            logger.error(error.message);
            publish({ browser: 'degraded', error: error.message });
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
    if (!aiToken || !settings.aiBaseUrl || !settings.aiModel) {
      publish({
        smsAi: 'configuration_required',
        browser: configuredBrowserState(),
        error: null,
      });
      return;
    }

    smsPresence = publishingPresence(controlClient, 'sms_ai', 'smsAi');
    const capability = createSmsAiCapability({
      controlClient,
      presence: smsPresence,
      runnerId: sessionId,
      aiBaseUrl: settings.aiBaseUrl,
      aiToken,
      aiModel: settings.aiModel,
      aiProtocol: settings.aiProtocol || 'anthropic',
      callAI: callCompanyAI,
      isAIReachable: companyAIReachable,
      logger,
    });
    smsController = new AbortController();
    await smsPresence.start();
    publish({
      smsAi: 'starting',
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
        logger.error(error.message);
        publish({ smsAi: 'degraded', error: error.message });
      },
    });
  }

  async function snapshot() {
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
        settings.installationId = randomUUID();
        settings.installationName ||= hostname();
        settings = await settingsStore.save(settings);
      }
      const hasRefreshToken = await authSession.hasRefreshToken();
      publish({ auth: hasRefreshToken ? 'signed_in' : 'signed_out' });
      if (hasRefreshToken) {
        try {
          await authSession.getAccessToken();
          await startCapabilities();
        } catch (error) {
          publish({ auth: 'signed_out', error: error.message });
        }
      }
    },

    snapshot,

    async saveSettings(input) {
      settings = await settingsStore.save({ ...settings, ...input });
      if (Object.hasOwn(input, 'aiToken')) await secureStore.set('aiToken', input.aiToken);
      publish({ error: null });
      if (state.auth === 'signed_in') await startCapabilities();
      return snapshot();
    },

    async testAI(input) {
      return runAiTest(input);
    },

    async testConfiguration(input) {
      const [dashboard, ai, browserResult] = await Promise.all([
        testDashboard(input),
        runAiTest(input),
        testBrowser(),
      ]);
      return { dashboard, ai, browser: browserResult };
    },

    async signIn() {
      if (requiredSettings(settings).length) throw new Error('Save dashboard and Auth0 settings first');
      loginController?.abort();
      loginController = new AbortController();
      publish({ auth: 'authorizing', error: null });
      try {
        await authSession.signIn({
          signal: loginController.signal,
          onDeviceCode: async ({ userCode, verificationUri, verificationUriComplete }) => {
            publish({ login: { userCode, verificationUri } });
            await openExternal(verificationUriComplete || verificationUri);
          },
        });
        publish({ auth: 'signed_in', login: null });
        await startCapabilities();
      } catch (error) {
        publish({ auth: 'signed_out', login: null, error: error.message });
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
      return browserProcessor?.showActiveBrowser() || false;
    },

    async wait() {
      await Promise.all([smsLoop, browserLoop].filter(Boolean));
    },

    async shutdown() {
      loginController?.abort();
      await stopCapabilities();
    },
  });
}
