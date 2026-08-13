const STATUS_META = {
  healthy: { label: '正常', dotClass: 'bg-emerald-500', textClass: 'text-emerald-700' },
  degraded: { label: '部分异常', dotClass: 'bg-amber-500', textClass: 'text-amber-700' },
  offline: { label: '离线', dotClass: 'bg-red-500', textClass: 'text-red-700' },
  error: { label: '错误', dotClass: 'bg-red-500', textClass: 'text-red-700' },
  unknown: { label: '检测中', dotClass: 'bg-stone-400', textClass: 'text-stone-600' },
};

export function normalizeDaemonStatus(status) {
  if (status === 'online') return 'healthy';
  if (status === 'warning') return 'degraded';
  return STATUS_META[status] ? status : 'unknown';
}

export function getDaemonStatusMeta(status) {
  return STATUS_META[normalizeDaemonStatus(status)];
}

export function isDaemonConnected(status) {
  const normalized = normalizeDaemonStatus(status);
  return normalized === 'healthy' || normalized === 'degraded';
}

export function formatTaskAge(seconds) {
  if (seconds === null || seconds === undefined) return '尚未成功';
  const age = Number(seconds);
  if (!Number.isFinite(age) || age < 0) return '尚未成功';
  if (age < 60) return age < 10 ? '刚刚' : `${Math.floor(age)}秒前`;
  if (age < 3600) return `${Math.floor(age / 60)}分钟前`;
  return `${Math.floor(age / 3600)}小时前`;
}
