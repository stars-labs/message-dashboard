import type { AgentState, CheckResult, SettingsForm } from '../ipc/contract.js';
import { STATE_LABELS } from '../ipc/state-labels.js';

const api = window.balanceAgent;
let current = await api.getState();

function element<T extends Element>(selector: string, type: abstract new () => T): T {
  const node = document.querySelector(selector);
  if (node instanceof type) return node;
  throw new Error(`Missing element ${selector}`);
}

function textNode(selector: string): HTMLElement {
  return element(selector, HTMLElement);
}

function field(form: HTMLFormElement, name: string): HTMLInputElement | HTMLSelectElement {
  const control = form.elements.namedItem(name);
  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) return control;
  throw new Error(`Missing field ${name}`);
}

function input(form: HTMLFormElement, name: string): HTMLInputElement {
  const control = field(form, name);
  if (control instanceof HTMLInputElement) return control;
  throw new Error(`Field ${name} is not an input`);
}

function settingsForm(): HTMLFormElement {
  return element('#settings-form', HTMLFormElement);
}

function formValues(): SettingsForm {
  const form = settingsForm();
  return {
    dashboardUrl: field(form, 'dashboardUrl').value,
    auth0Issuer: field(form, 'auth0Issuer').value,
    auth0ClientId: field(form, 'auth0ClientId').value,
    auth0Audience: field(form, 'auth0Audience').value,
    aiBaseUrl: field(form, 'aiBaseUrl').value,
    aiModel: field(form, 'aiModel').value,
    aiProtocol: field(form, 'aiProtocol').value,
    installationName: field(form, 'installationName').value,
    aiToken: field(form, 'aiToken').value,
  };
}

function statusClass(value: AgentState['auth'] | AgentState['smsAi']): string {
  if (value === 'signed_in' || value === 'ready') return 'ready';
  if (value === 'busy' || value === 'authorizing' || value === 'starting') return 'busy';
  if (value === 'degraded') return 'error';
  if (value === 'configuration_required') return 'warning';
  return '';
}

function setCapability(prefix: string, value: AgentState['smsAi']) {
  textNode(`#${prefix}-state`).textContent = STATE_LABELS[value];
  textNode(`#${prefix}-dot`).className = `indicator ${statusClass(value)}`;
}

function render(state: AgentState) {
  current = state;
  const authAction = element('#auth-action', HTMLButtonElement);
  const signedIn = current.auth === 'signed_in';
  textNode('#overall-status').textContent = STATE_LABELS[current.auth];
  textNode('#installation-name').textContent = current.settings.installationName || '本机服务';
  textNode('#auth-state').textContent = STATE_LABELS[current.auth];
  textNode('#auth-detail').textContent = current.settings.dashboardUrl || '未配置 Dashboard';
  textNode('#auth-dot').className = `indicator ${statusClass(current.auth)}`;
  setCapability('sms', current.smsAi);
  setCapability('browser', current.browser);
  textNode('#browser-state').textContent =
    current.browserDetail === 'human_verification_required'
      ? '需要人工验证'
      : STATE_LABELS[current.browser];
  authAction.textContent = signedIn ? '退出登录' : '登录';
  authAction.disabled = current.auth === 'authorizing';

  textNode('#login-code').hidden = !current.login;
  textNode('#user-code').textContent = current.login?.userCode ?? '';
  const error = textNode('#error-message');
  error.hidden = !current.error;
  error.textContent = current.error ?? '';
  element('#open-at-login', HTMLInputElement).checked = current.openAtLogin;
}

function populateSettings(state: AgentState) {
  const form = settingsForm();
  for (const [key, value] of Object.entries(state.settings)) {
    const control = form.elements.namedItem(key);
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
      control.value = value;
    }
  }
  const protocol = field(form, 'aiProtocol');
  if (!protocol.value) protocol.value = 'anthropic';
  input(form, 'aiToken').placeholder = state.hasAiToken
    ? '已安全保存，保持空白则不修改'
    : '输入 AI token';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const item of document.querySelectorAll('.tab'))
      item.classList.toggle('active', item === tab);
    const selected = tab instanceof HTMLElement ? tab.dataset['tab'] : undefined;
    textNode('#status-panel').hidden = selected !== 'status';
    textNode('#settings-panel').hidden = selected !== 'settings';
  });
}

async function toggleSignIn() {
  try {
    if (current.auth === 'signed_in') await api.signOut();
    else await api.signIn();
    const next = await api.getState();
    render(next);
    populateSettings(next);
  } catch (error) {
    render({ ...current, error: messageOf(error) });
  }
}

element('#auth-action', HTMLButtonElement).addEventListener('click', () => {
  void toggleSignIn();
});

async function saveSettings() {
  const { aiToken, ...values } = formValues();
  const result = await api.saveSettings(aiToken ? { ...values, aiToken } : values);
  field(settingsForm(), 'aiToken').value = '';
  textNode('#save-result').textContent = '已保存';
  render(result);
  populateSettings(result);
  setTimeout(() => {
    textNode('#save-result').textContent = '';
  }, 1800);
}

settingsForm().addEventListener('submit', (event) => {
  event.preventDefault();
  void saveSettings();
});

async function testAI() {
  const button = element('#test-ai', HTMLButtonElement);
  const resultNode = textNode('#ai-test-result');
  const values = formValues();
  button.disabled = true;
  button.textContent = '测试中...';
  resultNode.className = '';
  resultNode.textContent = '正在连接';
  try {
    const result = await api.testAI(values);
    resultNode.className = result.ok ? 'success' : 'failure';
    resultNode.textContent = result.ok
      ? `${result.message} · ${result.latencyMs} ms`
      : result.message;
  } catch (error) {
    resultNode.className = 'failure';
    resultNode.textContent = `测试失败：${messageOf(error)}`;
  } finally {
    button.disabled = false;
    button.textContent = '测试连接';
  }
}

element('#test-ai', HTMLButtonElement).addEventListener('click', () => {
  void testAI();
});

function renderConfigurationResult(prefix: string, result: CheckResult) {
  textNode(`#${prefix}-test-dot`).className = `indicator ${result.ok ? 'ready' : 'error'}`;
  textNode(`#${prefix}-test-result`).textContent = result.message;
}

async function testConfiguration() {
  const button = element('#test-configuration', HTMLButtonElement);
  const panel = textNode('#configuration-results');
  const values = formValues();
  button.disabled = true;
  button.textContent = '测试中...';
  panel.hidden = false;
  for (const prefix of ['dashboard', 'ai-full', 'browser']) {
    textNode(`#${prefix}-test-dot`).className = 'indicator busy';
    textNode(`#${prefix}-test-result`).textContent = '正在检查';
  }
  try {
    const results = await api.testConfiguration(values);
    renderConfigurationResult('dashboard', results.dashboard);
    renderConfigurationResult('ai-full', results.ai);
    renderConfigurationResult('browser', results.browser);
  } catch (error) {
    for (const prefix of ['dashboard', 'ai-full', 'browser']) {
      renderConfigurationResult(prefix, { ok: false, message: `检查失败：${messageOf(error)}` });
    }
  } finally {
    button.disabled = false;
    button.textContent = '测试全部配置';
  }
}

element('#test-configuration', HTMLButtonElement).addEventListener('click', () => {
  void testConfiguration();
});

async function changeOpenAtLogin() {
  const checkbox = element('#open-at-login', HTMLInputElement);
  checkbox.checked = await api.setOpenAtLogin(checkbox.checked);
}

element('#open-at-login', HTMLInputElement).addEventListener('change', () => {
  void changeOpenAtLogin();
});

api.onState(render);
api.onOpenAtLogin((enabled) => {
  render({ ...current, openAtLogin: enabled });
});
render(current);
populateSettings(current);
