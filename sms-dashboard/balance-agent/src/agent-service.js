import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { createControlClient } from '../../runner-core/control-client.js';
import { createRunnerPresence } from '../../runner-core/presence.js';
import { runSerialCapability } from '../../runner-core/serial-runner.js';
import { createSmsAiCapability } from '../../runner-core/capabilities/sms-ai.js';
import { createUnicomBrowserCapability } from '../../runner-core/capabilities/unicom-browser.js';
import { createUnicomBrowserJobProcessor } from '../../runner-core/capabilities/unicom-browser-workflow.js';
import { callCompanyAI, companyAIReachable } from '../../server/utils/company-ai.js';
import { createAuth0DeviceClient } from './auth0-device.js';
import { testAIConnection } from './ai-connection.js';
import { assertRunnerAccessToken } from './access-token.js';

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
  logger = console,
  onState = () => {},
}) {
  let settings = {};
  let accessToken = null;
  let accessTokenExpiresAt = 0;
  let loginController = null;
  let smsController = null;
  let smsPresence = null;
  let browserPresence = null;
  let smsLoop = null;
  let browserController = null;
  let browserLoop = null;
  let browserProcessor = null;
  const sessionId = randomUUID();
  const state = {
    auth: 'signed_out',
    smsAi: 'stopped',
    smsAiDetail: null,
    browser: 'configuration_required',
    browserDetail: 'browser_runtime_unavailable',
    login: null,
    error: null,
  };

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

  function authClient() {
    return createAuth0DeviceClient({
      issuer: settings.auth0Issuer,
      clientId: settings.auth0ClientId,
      audience: settings.auth0Audience,
    });
  }

  async function rememberTokens(payload) {
    assertRunnerAccessToken(payload.access_token, settings.auth0Audience);
    accessToken = payload.access_token;
    accessTokenExpiresAt = Date.now() + Math.max(0, Number(payload.expires_in || 0) - 60) * 1000;
    if (payload.refresh_token) await secureStore.set('auth0RefreshToken', payload.refresh_token);
  }

  async function getAccessToken() {
    if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
    const refreshToken = await secureStore.get('auth0RefreshToken');
    if (!refreshToken) throw new Error('Balance Agent is not signed in');
    const payload = await authClient().refresh(refreshToken);
    await rememberTokens(payload);
    return accessToken;
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
      const client = createControlClient({ baseUrl: dashboardUrl, getAccessToken });
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
    const aiToken = await secureStore.get('aiToken');
    const controlClient = createControlClient({
      baseUrl: settings.dashboardUrl,
      getAccessToken,
    });
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
        signal: browserController.signal,
        onError: (error) => {
          logger.error(error.message);
          publish({ browser: 'degraded', error: error.message });
        },
      });
    } else {
      await browserPresence.set('configuration_required', null, 'browser_runtime_unavailable');
    }

    if (!aiToken || !settings.aiBaseUrl || !settings.aiModel) {
      publish({
        smsAi: 'configuration_required',
        browser: browser && browserExecutablePath ? 'ready' : 'configuration_required',
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
      browser: browser && browserExecutablePath ? 'ready' : 'configuration_required',
      error: null,
    });
    smsLoop = runSerialCapability({
      runOne: async (options) => {
        const result = await capability.runOne(options);
        publish({ smsAi: 'ready', error: null });
        return result;
      },
      signal: smsController.signal,
      onError: (error) => {
        logger.error(error.message);
        publish({ smsAi: 'degraded', error: error.message });
      },
    });
  }

  async function snapshot() {
    return {
      ...state,
      settings: { ...settings },
      hasAiToken: Boolean(await secureStore.get('aiToken')),
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
      const hasRefreshToken = Boolean(await secureStore.get('auth0RefreshToken'));
      publish({ auth: hasRefreshToken ? 'signed_in' : 'signed_out' });
      if (hasRefreshToken) {
        try {
          await getAccessToken();
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
        const client = authClient();
        const device = await client.begin({ signal: loginController.signal });
        publish({
          login: {
            userCode: device.user_code,
            verificationUri: device.verification_uri,
          },
        });
        await openExternal(device.verification_uri_complete || device.verification_uri);
        const tokens = await client.poll(device, { signal: loginController.signal });
        await rememberTokens(tokens);
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
      await secureStore.set('auth0RefreshToken', null);
      accessToken = null;
      accessTokenExpiresAt = 0;
      publish({ auth: 'signed_out', login: null, error: null });
    },

    async showVerification() {
      return browserProcessor?.showActiveBrowser() || false;
    },

    async shutdown() {
      loginController?.abort();
      await stopCapabilities();
    },
  });
}
