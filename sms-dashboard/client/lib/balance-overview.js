import {
  getBalanceTimestamp,
  getCashBalance,
  normalizeUtcTimestamp,
} from './balance-query.js';

export const BALANCE_STALE_DAYS = 35;

const THRESHOLDS = {
  CNY: 100,
  SGD: 10,
  HKD: 100,
};

const COUNTRY_CURRENCIES = {
  CN: 'CNY',
  SG: 'SGD',
  HK: 'HKD',
};

export const BALANCE_HEALTH_META = {
  normal: {
    label: '正常',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dotClass: 'bg-emerald-500',
  },
  low: {
    label: '需要充值',
    className: 'bg-red-50 text-red-700 border-red-200',
    dotClass: 'bg-red-500',
  },
  stale: {
    label: '数据过期',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
    dotClass: 'bg-amber-500',
  },
  failed: {
    label: '查询失败',
    className: 'bg-red-50 text-red-700 border-red-200',
    dotClass: 'bg-red-500',
  },
  unknown: {
    label: '尚未取得',
    className: 'bg-stone-100 text-stone-600 border-stone-200',
    dotClass: 'bg-stone-300',
  },
};

function timestampValue(check) {
  const value = normalizeUtcTimestamp(getBalanceTimestamp(check));
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

// Cancellations and superseded jobs are operational noise — not real query failures.
// They should not make a SIM appear as "查询失败" when no balance was ever obtained.
function isCancelledCheck(check) {
  const err = check?.error || '';
  return (
    err.startsWith('Cancelled') ||
    err.startsWith('Manually cancelled') ||
    err.startsWith('Superseded')
  );
}

export function getBalanceThreshold(phone, metric = null) {
  const currency = metric?.currency || COUNTRY_CURRENCIES[phone?.country] || null;
  // Per-SIM override wins; empty falls back to the currency default.
  const override = phone?.balance_threshold;
  if (override != null && override !== '' && Number.isFinite(Number(override))) {
    return { value: Number(override), currency };
  }
  const value = currency ? THRESHOLDS[currency] : null;
  return value == null ? null : { value, currency };
}

export function buildBalanceRows(phones = [], checks = [], now = new Date()) {
  const checksByIccid = new Map();
  for (const check of checks || []) {
    if (!check?.sim_iccid) continue;
    const group = checksByIccid.get(check.sim_iccid) || [];
    group.push(check);
    checksByIccid.set(check.sim_iccid, group);
  }

  const staleBefore = now.getTime() - BALANCE_STALE_DAYS * 24 * 60 * 60 * 1000;

  return (phones || []).map((phone) => {
    const phoneChecks = (checksByIccid.get(phone.iccid) || [])
      .slice()
      .sort((a, b) => timestampValue(b) - timestampValue(a));
    // Use the newest non-cancelled check for health classification so that
    // operational cancellations (rate-limit holds, triggered-in-error batches)
    // don't permanently mark a SIM as 查询失败 when no balance was ever obtained.
    const latestCheck = phoneChecks[0] || null;
    const latestSignificantCheck =
      phoneChecks.find((check) => !isCancelledCheck(check)) || null;
    const balanceCheck = phoneChecks.find((check) => getCashBalance(check)) || null;
    const balanceMetric = getCashBalance(balanceCheck);
    const threshold = getBalanceThreshold(phone, balanceMetric);
    const balanceTimestamp = balanceCheck ? getBalanceTimestamp(balanceCheck) : null;
    const balanceTime = balanceTimestamp
      ? new Date(normalizeUtcTimestamp(balanceTimestamp)).getTime()
      : 0;

    // Secondary SIMs follow their primary's balance — health is not independently meaningful.
    let health = 'normal';
    if (phone.sim_role === 'secondary') {
      health = 'unknown';
    } else if (latestSignificantCheck && ['failed', 'timed_out'].includes(latestSignificantCheck.status)) {
      health = 'failed';
    } else if (!balanceMetric) {
      health = 'unknown';
    } else if (!Number.isFinite(balanceTime) || balanceTime < staleBefore) {
      health = 'stale';
    } else if (threshold && Number(balanceMetric.value) < threshold.value) {
      health = 'low';
    }

    return {
      phone,
      checks: phoneChecks,
      latestCheck: latestSignificantCheck,
      balanceCheck,
      balanceMetric,
      balanceTimestamp,
      threshold,
      health,
      healthMeta: BALANCE_HEALTH_META[health],
    };
  });
}

export function countBalanceHealth(rows = []) {
  return rows.reduce((counts, row) => {
    counts[row.health] = (counts[row.health] || 0) + 1;
    return counts;
  }, { normal: 0, low: 0, stale: 0, failed: 0, unknown: 0 });
}
