const STATE_LABELS = Object.freeze({
  signed_out: '未登录',
  authorizing: '等待授权',
  signed_in: '已连接',
  stopped: '已停止',
  starting: '启动中',
  ready: '就绪',
  busy: '查询中',
  degraded: '连接异常',
  configuration_required: '待配置',
});

function stateLabel(value) {
  return STATE_LABELS[value] || String(value || '未知');
}

function truncatedError(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}

function statusIndicator(value) {
  if (value === 'ready' || value === 'signed_in') return 'ready';
  if (value === 'authorizing' || value === 'starting' || value === 'busy') return 'attention';
  if (value === 'degraded') return 'error';
  return 'inactive';
}

export function createMenuBarModel(state = {}, { openAtLogin = false } = {}) {
  const humanVerification = state.browserDetail === 'human_verification_required';
  const busy = ['authorizing', 'starting', 'busy'].some((value) =>
    [state.auth, state.smsAi, state.browser].includes(value));
  const degraded = state.error
    || state.smsAi === 'degraded'
    || state.browser === 'degraded';
  const ready = state.auth === 'signed_in'
    && state.smsAi === 'ready'
    && state.browser === 'ready';

  let appearance = 'idle';
  if (ready) appearance = 'ready';
  if (busy) appearance = 'busy';
  if (degraded) appearance = 'error';
  if (humanVerification) appearance = 'attention';

  const appearanceMeta = {
    ready: { fallbackTitle: 'BA', tooltip: 'Balance Agent · 就绪' },
    busy: { fallbackTitle: 'BA', tooltip: 'Balance Agent · 查询中' },
    attention: { fallbackTitle: 'BA', tooltip: 'Balance Agent · 需要操作' },
    error: { fallbackTitle: 'BA', tooltip: 'Balance Agent · 连接异常' },
    idle: { fallbackTitle: 'BA', tooltip: 'Balance Agent · 未就绪' },
  }[appearance];

  const browserLabel = humanVerification ? '需要人工验证' : stateLabel(state.browser);
  const installationName = state.settings?.installationName?.trim();
  const dashboardUrl = state.settings?.dashboardUrl?.trim();
  const error = truncatedError(state.error);
  const items = [
    {
      id: 'agent-header',
      label: installationName ? `Balance Agent · ${installationName}` : 'Balance Agent',
    },
    { type: 'separator' },
    {
      id: 'status-dashboard',
      label: `Dashboard · ${stateLabel(state.auth)}`,
      indicator: statusIndicator(state.auth),
    },
    {
      id: 'status-sms-ai',
      label: `AI 短信 · ${stateLabel(state.smsAi)}`,
      indicator: statusIndicator(state.smsAi),
    },
    {
      id: 'status-browser',
      label: `浏览器查询 · ${browserLabel}`,
      indicator: humanVerification ? 'attention' : statusIndicator(state.browser),
    },
  ];

  if (error) items.push({ id: 'status-error', label: `异常 · ${error}`, indicator: 'error' });
  if (humanVerification) {
    items.push(
      { type: 'separator' },
      { id: 'show-verification', label: '显示验证窗口' },
    );
  }

  items.push(
    { type: 'separator' },
    { id: 'open-dashboard', label: '打开 Dashboard', enabled: Boolean(dashboardUrl) },
    { id: 'open-settings', label: '设置...' },
    { id: 'open-at-login', label: '登录时自动启动', type: 'checkbox', checked: Boolean(openAtLogin) },
    { type: 'separator' },
    { id: 'quit', label: '退出 Balance Agent' },
  );

  return {
    appearance,
    dashboardUrl: dashboardUrl || null,
    ...appearanceMeta,
    items,
  };
}
