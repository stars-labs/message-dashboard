/** Convert API/D1 timestamps to epoch milliseconds. */
export function toEpochMilliseconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;

  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;

  // D1 CURRENT_TIMESTAMP omits a timezone suffix but is always UTC.
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatTimeAgo(value, now = Date.now()) {
  const timestamp = toEpochMilliseconds(value);
  if (timestamp === null) return value ? '未知' : '从未';

  const diff = Math.max(0, now - timestamp);
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return `${Math.floor(diff / 86400000)}天前`;
}

/**
 * Absolute event time, Beijing. `HH:MM` for today, `MM/DD HH:MM` before that.
 *
 * One format for every event in the app. Seconds were noise — nobody triages an
 * OTP to the second — and they cost column width on a phone; the year was noise
 * too, and it appeared in one balance tab but not its neighbour.
 */
export function formatClock(value, now = Date.now()) {
  const timestamp = toEpochMilliseconds(value);
  if (timestamp === null) return '';
  const zone = { timeZone: 'Asia/Shanghai' };
  const date = new Date(timestamp);
  const sameDay = date.toLocaleDateString('zh-CN', zone) === new Date(now).toLocaleDateString('zh-CN', zone);
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, ...zone })
    : date.toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, ...zone,
      });
}

/** The same instant with its year, for detail views where the date matters. */
export function formatFullTime(value) {
  const timestamp = toEpochMilliseconds(value);
  if (timestamp === null) return '—';
  return new Date(timestamp).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
