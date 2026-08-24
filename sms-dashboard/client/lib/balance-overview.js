import {
  getBalanceTimestamp,
  getCashBalance,
  normalizeUtcTimestamp,
} from './balance-query.js';
import { evaluatePrepaidHealth } from '../../shared/prepaid-health.js';

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
  healthy: {
    label: '正常',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dotClass: 'bg-emerald-500',
  },
  zero_or_negative_balance: {
    label: '余额耗尽',
    className: 'bg-red-50 text-red-800 border-red-300',
    dotClass: 'bg-red-600',
  },
  low_balance: {
    label: '需要充值',
    className: 'bg-red-50 text-red-700 border-red-200',
    dotClass: 'bg-red-500',
  },
  stale: {
    label: '数据过期',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
    dotClass: 'bg-amber-500',
  },
  query_failed: {
    label: '查询失败',
    className: 'bg-red-50 text-red-700 border-red-200',
    dotClass: 'bg-red-500',
  },
  never_observed: {
    label: '尚未取得',
    className: 'bg-stone-100 text-stone-600 border-stone-200',
    dotClass: 'bg-stone-300',
  },
  expired: {
    label: '已到期',
    className: 'bg-red-50 text-red-800 border-red-300',
    dotClass: 'bg-red-600',
  },
  expiring_soon: {
    label: '即将到期',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
    dotClass: 'bg-amber-500',
  },
  verification_pending: {
    label: '充值待验证',
    className: 'bg-sky-50 text-sky-700 border-sky-200',
    dotClass: 'bg-sky-500',
  },
  expiry_unknown: {
    label: '有效期未取得',
    className: 'bg-stone-100 text-stone-600 border-stone-200',
    dotClass: 'bg-stone-300',
  },
  not_applicable: {
    label: '后付费账单管理',
    className: 'bg-violet-50 text-violet-700 border-violet-200',
    dotClass: 'bg-violet-500',
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

  const rows = (phones || []).map((phone) => {
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
    const threshold = phone.service_type === 'postpaid'
      ? null
      : getBalanceThreshold(phone, balanceMetric);
    const balanceTimestamp = balanceCheck ? getBalanceTimestamp(balanceCheck) : null;
    const expiryCheck = phoneChecks.find((check) => check.metrics?.some(
      (metric) => metric.metric_type === 'account_expiry' && metric.expires_at
    )) || null;
    const expiryMetric = expiryCheck?.metrics?.find(
      (metric) => metric.metric_type === 'account_expiry' && metric.expires_at
    ) || null;
    const expiryTimestamp = expiryCheck ? getBalanceTimestamp(expiryCheck) : null;
    const expiryDate = expiryMetric ? String(expiryMetric.expires_at).slice(0, 10) : null;

    // Secondary SIMs follow their primary's balance — health is not independently meaningful.
    let healthResult;
    if (phone.sim_role === 'secondary') {
      healthResult = { summaryStatus: 'never_observed', reasons: ['never_observed'] };
    } else {
      healthResult = evaluatePrepaidHealth({
        serviceType: phone.service_type || 'unknown',
        country: phone.country,
        now,
        threshold,
        cashBalance: balanceMetric ? {
          value: balanceMetric.value,
          currency: balanceMetric.currency,
          observedAt: normalizeUtcTimestamp(balanceTimestamp),
        } : null,
        accountExpiry: expiryDate ? {
          date: expiryDate,
          observedAt: normalizeUtcTimestamp(expiryTimestamp),
        } : null,
        latestQueryStatus: latestSignificantCheck?.status || null,
      });
    }
    const health = healthResult.summaryStatus;

    return {
      phone,
      checks: phoneChecks,
      latestCheck: latestSignificantCheck,
      balanceCheck,
      balanceMetric,
      balanceTimestamp,
      expiryCheck,
      expiryMetric,
      expiryDate,
      expiryTimestamp,
      threshold,
      health,
      healthReasons: healthResult.reasons,
      healthMeta: BALANCE_HEALTH_META[health],
    };
  });

  const rowsByIccid = new Map(rows.map((row) => [row.phone.iccid, row]));
  return rows.map((row) => {
    if (row.phone.sim_role !== 'secondary' || !row.phone.primary_iccid) return row;
    const primary = rowsByIccid.get(row.phone.primary_iccid);
    if (!primary || primary.phone.sim_role !== 'primary') return row;

    return {
      ...row,
      checks: primary.checks,
      latestCheck: primary.latestCheck,
      balanceCheck: primary.balanceCheck,
      balanceMetric: primary.balanceMetric,
      balanceTimestamp: primary.balanceTimestamp,
      expiryCheck: primary.expiryCheck,
      expiryMetric: primary.expiryMetric,
      expiryDate: primary.expiryDate,
      expiryTimestamp: primary.expiryTimestamp,
      threshold: primary.threshold,
      health: primary.health,
      healthReasons: primary.healthReasons,
      healthMeta: primary.healthMeta,
    };
  });
}

export function countBalanceHealth(rows = []) {
  return rows.reduce((counts, row) => {
    counts[row.health] = (counts[row.health] || 0) + 1;
    return counts;
  }, Object.fromEntries(Object.keys(BALANCE_HEALTH_META).map((status) => [status, 0])));
}
