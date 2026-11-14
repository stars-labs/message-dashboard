import { getBalanceTimestamp, getCashBalance, normalizeUtcTimestamp } from './balance-query.js';
import { evaluatePrepaidHealth } from '../../shared/prepaid-health.js';
import type { SummaryStatus } from '../../shared/prepaid-health.js';
import type { BalanceCheck, BalanceMetric } from '../../shared/api/balance-checks.js';
import type { Phone } from '../../shared/api/phones.js';
import { textOr } from '../../shared/text.js';

/** The phone fields a balance threshold depends on. */
type ThresholdPhone = Pick<Phone, 'country' | 'balance_threshold'>;

/** The phone fields the balance overview reads. */
type BalancePhone = ThresholdPhone &
  Pick<Phone, 'iccid' | 'service_type' | 'sim_role' | 'primary_iccid'>;

interface BalanceHealthMeta {
  label: string;
  className: string;
  dotClass: string;
}

interface BalanceThreshold {
  value: number;
  currency: string | null;
}

/** One rendered balance row. */
interface BalanceRow<P extends BalancePhone> {
  phone: P;
  checks: BalanceCheck[];
  latestCheck: BalanceCheck | null;
  balanceCheck: BalanceCheck | null;
  balanceMetric: BalanceMetric | null;
  balanceTimestamp: string | null;
  expiryCheck: BalanceCheck | null;
  expiryMetric: BalanceMetric | null;
  expiryDate: string | null;
  expiryTimestamp: string | null;
  threshold: BalanceThreshold | null;
  health: SummaryStatus;
  healthReasons: string[];
  healthMeta: BalanceHealthMeta;
}

const THRESHOLDS = new Map([
  ['CNY', 100],
  ['SGD', 10],
  ['HKD', 100],
]);

const COUNTRY_CURRENCIES = new Map([
  ['CN', 'CNY'],
  ['SG', 'SGD'],
  ['HK', 'HKD'],
]);

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
} satisfies Record<SummaryStatus, BalanceHealthMeta>;

const SUMMARY_STATUSES = Object.keys(BALANCE_HEALTH_META).filter(isSummaryStatus);

export function isSummaryStatus(status: string): status is SummaryStatus {
  return Object.hasOwn(BALANCE_HEALTH_META, status);
}

function timestampValue(check: BalanceCheck): number {
  const value = normalizeUtcTimestamp(getBalanceTimestamp(check));
  const time = value === null ? 0 : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

// Cancellations and superseded jobs are operational noise — not real query failures.
// They should not make a SIM appear as "查询失败" when no balance was ever obtained.
function isCancelledCheck(check: BalanceCheck): boolean {
  const err = check.error ?? '';
  return (
    err.startsWith('Cancelled') ||
    err.startsWith('Manually cancelled') ||
    err.startsWith('Superseded')
  );
}

function hasExpiry(metric: BalanceMetric): boolean {
  return metric.metric_type === 'account_expiry' && metric.expires_at !== null;
}

export function getBalanceThreshold(
  phone: ThresholdPhone,
  metric: BalanceMetric | null = null,
): BalanceThreshold | null {
  const currency =
    textOr(metric?.currency, null) ??
    (phone.country === null ? undefined : COUNTRY_CURRENCIES.get(phone.country)) ??
    null;
  // Per-SIM override wins; none falls back to the currency default.
  if (phone.balance_threshold !== null && Number.isFinite(phone.balance_threshold)) {
    return { value: phone.balance_threshold, currency };
  }
  const value = currency === null ? undefined : THRESHOLDS.get(currency);
  return value === undefined ? null : { value, currency };
}

export function buildBalanceRows<P extends BalancePhone>(
  phones: readonly P[],
  checks: readonly BalanceCheck[],
  now: Date = new Date(),
): BalanceRow<P>[] {
  const checksByIccid = new Map<string, BalanceCheck[]>();
  for (const check of checks) {
    const group = checksByIccid.get(check.sim_iccid) ?? [];
    group.push(check);
    checksByIccid.set(check.sim_iccid, group);
  }

  const rows: BalanceRow<P>[] = phones.map((phone) => {
    const phoneChecks = (checksByIccid.get(phone.iccid) ?? [])
      .slice()
      .sort((a, b) => timestampValue(b) - timestampValue(a));
    // Use the newest non-cancelled check for health classification so that
    // operational cancellations (rate-limit holds, triggered-in-error batches)
    // don't permanently mark a SIM as 查询失败 when no balance was ever obtained.
    const latestSignificantCheck = phoneChecks.find((check) => !isCancelledCheck(check)) ?? null;
    const balanceCheck = phoneChecks.find((check) => getCashBalance(check) !== null) ?? null;
    const balanceMetric = getCashBalance(balanceCheck);
    const threshold =
      phone.service_type === 'postpaid' ? null : getBalanceThreshold(phone, balanceMetric);
    const balanceTimestamp = balanceCheck ? getBalanceTimestamp(balanceCheck) : null;
    const expiryCheck = phoneChecks.find((check) => check.metrics.some(hasExpiry)) ?? null;
    const expiryMetric = expiryCheck?.metrics.find(hasExpiry) ?? null;
    const expiryTimestamp = expiryCheck ? getBalanceTimestamp(expiryCheck) : null;
    const expiryDate = expiryMetric?.expires_at?.slice(0, 10) ?? null;

    // Secondary SIMs follow their primary's balance — health is not independently meaningful.
    const healthResult: { summaryStatus: SummaryStatus; reasons: string[] } =
      phone.sim_role === 'secondary'
        ? { summaryStatus: 'never_observed', reasons: ['never_observed'] }
        : evaluatePrepaidHealth({
            serviceType: textOr(phone.service_type, 'unknown'),
            country: phone.country,
            now,
            threshold,
            cashBalance: balanceMetric
              ? {
                  value: balanceMetric.value ?? 0,
                  currency: balanceMetric.currency,
                  observedAt:
                    balanceTimestamp === null ? null : normalizeUtcTimestamp(balanceTimestamp),
                }
              : null,
            accountExpiry: expiryDate === null ? null : { date: expiryDate },
            latestQueryStatus: latestSignificantCheck?.status ?? null,
            expiryExpected:
              latestSignificantCheck?.profile_outputs.includes('account_expiry') === true,
          });
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
    if (row.phone.sim_role !== 'secondary' || row.phone.primary_iccid === null) return row;
    const primary = rowsByIccid.get(row.phone.primary_iccid);
    if (primary?.phone.sim_role !== 'primary') return row;

    return { ...primary, phone: row.phone };
  });
}

export function countBalanceHealth(
  rows: readonly BalanceRow<BalancePhone>[],
): Map<SummaryStatus, number> {
  const counts = new Map(SUMMARY_STATUSES.map((status) => [status, 0]));
  for (const row of rows) counts.set(row.health, (counts.get(row.health) ?? 0) + 1);
  return counts;
}
