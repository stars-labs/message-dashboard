const api = window.balanceAgent;
let current = null;

const labels = {
  signed_out: '未登录',
  authorizing: '等待授权',
  signed_in: '已连接',
  stopped: '已停止',
  starting: '启动中',
  ready: '就绪',
  busy: '查询中',
  degraded: '连接异常',
  configuration_required: '待配置',
};

function statusClass(value) {
  if (value === 'signed_in' || value === 'ready') return 'ready';
  if (value === 'busy' || value === 'authorizing' || value === 'starting') return 'busy';
  if (value === 'degraded') return 'error';
  if (value === 'configuration_required') return 'warning';
  return '';
}

function setCapability(prefix, value) {
  document.querySelector(`#${prefix}-state`).textContent = labels[value] || value;
  document.querySelector(`#${prefix}-dot`).className = `indicator ${statusClass(value)}`;
}

function render(state) {
  current = { ...current, ...state };
  const authAction = document.querySelector('#auth-action');
  const signedIn = current.auth === 'signed_in';
  document.querySelector('#overall-status').textContent = labels[current.auth] || current.auth;
  document.querySelector('#installation-name').textContent = current.settings?.installationName || '本机服务';
  document.querySelector('#auth-state').textContent = labels[current.auth] || current.auth;
  document.querySelector('#auth-detail').textContent = current.settings?.dashboardUrl || '未配置 Dashboard';
  document.querySelector('#auth-dot').className = `indicator ${statusClass(current.auth)}`;
  setCapability('sms', current.smsAi);
  setCapability('browser', current.browser);
  document.querySelector('#browser-state').textContent = current.browserDetail === 'human_verification_required'
    ? '需要人工验证'
    : (labels[current.browser] || current.browser);
  authAction.textContent = signedIn ? '退出登录' : '登录';
  authAction.disabled = current.auth === 'authorizing';

  const login = document.querySelector('#login-code');
  login.hidden = !current.login;
  document.querySelector('#user-code').textContent = current.login?.userCode || '';
  const error = document.querySelector('#error-message');
  error.hidden = !current.error;
  error.textContent = current.error || '';
  if (typeof current.openAtLogin === 'boolean') {
    document.querySelector('#open-at-login').checked = current.openAtLogin;
  }
}

function populateSettings(state) {
  const form = document.querySelector('#settings-form');
  for (const [key, value] of Object.entries(state.settings || {})) {
    if (form.elements[key]) form.elements[key].value = value;
  }
  if (!form.elements.aiProtocol.value) form.elements.aiProtocol.value = 'anthropic';
  form.elements.aiToken.placeholder = state.hasAiToken ? '已安全保存，保持空白则不修改' : '输入 AI token';
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const item of document.querySelectorAll('.tab')) item.classList.toggle('active', item === tab);
    document.querySelector('#status-panel').hidden = tab.dataset.tab !== 'status';
    document.querySelector('#settings-panel').hidden = tab.dataset.tab !== 'settings';
  });
}

document.querySelector('#auth-action').addEventListener('click', async () => {
  try {
    if (current.auth === 'signed_in') await api.signOut();
    else await api.signIn();
    const next = await api.getState();
    render(next);
    populateSettings(next);
  } catch (error) {
    render({ error: error.message });
  }
});

document.querySelector('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  if (!values.aiToken) delete values.aiToken;
  const result = await api.saveSettings(values);
  form.elements.aiToken.value = '';
  document.querySelector('#save-result').textContent = '已保存';
  render(result);
  populateSettings(result);
  setTimeout(() => { document.querySelector('#save-result').textContent = ''; }, 1800);
});

document.querySelector('#test-ai').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const resultNode = document.querySelector('#ai-test-result');
  const values = Object.fromEntries(new FormData(document.querySelector('#settings-form')));
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
    resultNode.textContent = `测试失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = '测试连接';
  }
});

function renderConfigurationResult(prefix, result) {
  const dot = document.querySelector(`#${prefix}-test-dot`);
  dot.className = `indicator ${result.ok ? 'ready' : 'error'}`;
  document.querySelector(`#${prefix}-test-result`).textContent = result.message;
}

document.querySelector('#test-configuration').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const panel = document.querySelector('#configuration-results');
  const values = Object.fromEntries(new FormData(document.querySelector('#settings-form')));
  button.disabled = true;
  button.textContent = '测试中...';
  panel.hidden = false;
  for (const prefix of ['dashboard', 'ai-full', 'browser']) {
    document.querySelector(`#${prefix}-test-dot`).className = 'indicator busy';
    document.querySelector(`#${prefix}-test-result`).textContent = '正在检查';
  }
  try {
    const results = await api.testConfiguration(values);
    renderConfigurationResult('dashboard', results.dashboard);
    renderConfigurationResult('ai-full', results.ai);
    renderConfigurationResult('browser', results.browser);
  } catch (error) {
    for (const prefix of ['dashboard', 'ai-full', 'browser']) {
      renderConfigurationResult(prefix, { ok: false, message: `检查失败：${error.message}` });
    }
  } finally {
    button.disabled = false;
    button.textContent = '测试全部配置';
  }
});

document.querySelector('#open-at-login').addEventListener('change', async (event) => {
  event.currentTarget.checked = await api.setOpenAtLogin(event.currentTarget.checked);
});

api.onState(render);
api.onOpenAtLogin((enabled) => render({ openAtLogin: enabled }));
const initial = await api.getState();
render(initial);
populateSettings(initial);
