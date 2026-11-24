import { textOr } from '../../shared/text.js';
import type { AgentState } from './ipc/contract.js';
import { STATE_LABELS } from './ipc/state-labels.js';

export interface MenuState {
  auth: AgentState['auth'];
  smsAi: AgentState['smsAi'];
  browser: AgentState['browser'];
  browserDetail?: string | null;
  error?: string | null;
  settings: { installationName?: string; dashboardUrl?: string };
}

export type MenuItemId =
  | 'agent-header'
  | 'status-dashboard'
  | 'status-sms-ai'
  | 'status-browser'
  | 'status-error'
  | 'show-verification'
  | 'open-dashboard'
  | 'open-settings'
  | 'open-at-login'
  | 'quit';

export type MenuIndicator = 'ready' | 'attention' | 'error' | 'inactive';

export type MenuItem =
  | { type: 'separator' }
  | {
      id: MenuItemId;
      label: string;
      indicator?: MenuIndicator;
      enabled?: boolean;
      type?: 'checkbox';
      checked?: boolean;
    };

type Appearance = 'ready' | 'busy' | 'attention' | 'error' | 'idle';

export interface MenuBarModel {
  appearance: Appearance;
  dashboardUrl: string | null;
  fallbackTitle: string;
  tooltip: string;
  items: MenuItem[];
}

function truncatedError(value: string | null | undefined): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}

function statusIndicator(value: MenuState['auth'] | MenuState['smsAi']): MenuIndicator {
  if (value === 'ready' || value === 'signed_in') return 'ready';
  if (value === 'authorizing' || value === 'starting' || value === 'busy') return 'attention';
  if (value === 'degraded') return 'error';
  return 'inactive';
}

const APPEARANCE_META: Readonly<Record<Appearance, { fallbackTitle: string; tooltip: string }>> =
  Object.freeze({
    ready: { fallbackTitle: 'BA', tooltip: 'Balance Agent · 就绪' },
    busy: { fallbackTitle: 'BA', tooltip: 'Balance Agent · 查询中' },
    attention: { fallbackTitle: 'BA', tooltip: 'Balance Agent · 需要操作' },
    error: { fallbackTitle: 'BA', tooltip: 'Balance Agent · 连接异常' },
    idle: { fallbackTitle: 'BA', tooltip: 'Balance Agent · 未就绪' },
  });

export function createMenuBarModel(
  state: MenuState,
  { openAtLogin = false }: { openAtLogin?: boolean } = {},
): MenuBarModel {
  const humanVerification = state.browserDetail === 'human_verification_required';
  const states: readonly string[] = [state.auth, state.smsAi, state.browser];
  const busy = ['authorizing', 'starting', 'busy'].some((value) => states.includes(value));
  const degraded =
    Boolean(state.error) || state.smsAi === 'degraded' || state.browser === 'degraded';
  const ready = state.auth === 'signed_in' && state.smsAi === 'ready' && state.browser === 'ready';

  let appearance: Appearance = 'idle';
  if (ready) appearance = 'ready';
  if (busy) appearance = 'busy';
  if (degraded) appearance = 'error';
  if (humanVerification) appearance = 'attention';

  const browserLabel = humanVerification ? '需要人工验证' : STATE_LABELS[state.browser];
  const installationName = state.settings.installationName?.trim();
  const dashboardUrl = state.settings.dashboardUrl?.trim();
  const error = truncatedError(state.error);
  const items: MenuItem[] = [
    {
      id: 'agent-header',
      label: installationName ? `Balance Agent · ${installationName}` : 'Balance Agent',
    },
    { type: 'separator' },
    {
      id: 'status-dashboard',
      label: `Dashboard · ${STATE_LABELS[state.auth]}`,
      indicator: statusIndicator(state.auth),
    },
    {
      id: 'status-sms-ai',
      label: `AI 短信 · ${STATE_LABELS[state.smsAi]}`,
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
    items.push({ type: 'separator' }, { id: 'show-verification', label: '显示验证窗口' });
  }

  items.push(
    { type: 'separator' },
    { id: 'open-dashboard', label: '打开 Dashboard', enabled: Boolean(dashboardUrl) },
    { id: 'open-settings', label: '设置...' },
    {
      id: 'open-at-login',
      label: '登录时自动启动',
      type: 'checkbox',
      checked: openAtLogin,
    },
    { type: 'separator' },
    { id: 'quit', label: '退出 Balance Agent' },
  );

  return {
    appearance,
    dashboardUrl: textOr(dashboardUrl, null),
    ...APPEARANCE_META[appearance],
    items,
  };
}
