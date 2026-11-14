import type { HealthSnapshot } from '../../shared/api/daemon-status.js';

/**
 * The daemon status the dashboard shows: the last /api/daemon/status answer,
 * or `error` when it could not be read, with whether the daemon counts as up.
 */
export interface DaemonView {
  status: string;
  message?: string;
  reasons?: string[];
  snapshot?: HealthSnapshot | null;
  last_heartbeat?: string;
  connected: boolean;
}

interface DaemonStatusMeta {
  label: string;
  dotClass: string;
  textClass: string;
}

type DaemonStatus = 'healthy' | 'degraded' | 'offline' | 'error' | 'unknown';

const STATUS_META = {
  healthy: { label: '正常', dotClass: 'bg-emerald-500', textClass: 'text-emerald-700' },
  degraded: { label: '部分异常', dotClass: 'bg-amber-500', textClass: 'text-amber-700' },
  offline: { label: '离线', dotClass: 'bg-red-500', textClass: 'text-red-700' },
  error: { label: '错误', dotClass: 'bg-red-500', textClass: 'text-red-700' },
  unknown: { label: '检测中', dotClass: 'bg-stone-400', textClass: 'text-stone-600' },
} as const satisfies Record<DaemonStatus, DaemonStatusMeta>;

function isDaemonStatus(status: string): status is DaemonStatus {
  return Object.hasOwn(STATUS_META, status);
}

export function normalizeDaemonStatus(status: string | null | undefined): DaemonStatus {
  if (status === 'online') return 'healthy';
  if (status === 'warning') return 'degraded';
  return status !== null && status !== undefined && isDaemonStatus(status) ? status : 'unknown';
}

export function getDaemonStatusMeta(status: string | null | undefined): DaemonStatusMeta {
  return STATUS_META[normalizeDaemonStatus(status)];
}

export function isDaemonConnected(status: string | null | undefined): boolean {
  const normalized = normalizeDaemonStatus(status);
  return normalized === 'healthy' || normalized === 'degraded';
}

export function formatTaskAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '尚未成功';
  if (!Number.isFinite(seconds) || seconds < 0) return '尚未成功';
  if (seconds < 60) return seconds < 10 ? '刚刚' : `${Math.floor(seconds)}秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
  return `${Math.floor(seconds / 3600)}小时前`;
}
