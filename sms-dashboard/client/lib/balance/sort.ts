import { textOr } from '../../../shared/text.js';
import type { BalanceCheck, BalanceMetric } from '../../../shared/api/balance-checks.js';
import type { SummaryStatus } from '../../../shared/prepaid-health.js';
import { getBalanceTimestamp, getCashBalance, normalizeUtcTimestamp } from '../balance-query.js';
import { getSimServiceTypeLabel } from '../sim-service-type.js';
import type {
  BalanceRow,
  HistorySortKey,
  OverviewSortKey,
  SortDirection,
  SortValue,
} from './types.js';

function compareValues(left: SortValue, right: SortValue): number {
  const leftMissing = left == null || left === '' || Number.isNaN(left);
  const rightMissing = right == null || right === '' || Number.isNaN(right);
  if (leftMissing || rightMissing) {
    if (leftMissing && rightMissing) return 0;
    return leftMissing ? 1 : -1;
  }
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right), 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

function compareMoney(
  leftMetric: BalanceMetric | null | undefined,
  rightMetric: BalanceMetric | null | undefined,
): number {
  const currency = compareValues(leftMetric?.currency, rightMetric?.currency);
  return currency || compareValues(Number(leftMetric?.value), Number(rightMetric?.value));
}

function healthOrder(status: SummaryStatus): number {
  return {
    expired: 0,
    zero_or_negative_balance: 1,
    query_failed: 2,
    verification_pending: 3,
    stale: 4,
    low_balance: 5,
    expiring_soon: 6,
    never_observed: 7,
    expiry_unknown: 8,
    not_applicable: 9,
    healthy: 10,
  }[status];
}

function overviewValue(row: BalanceRow, key: OverviewSortKey): SortValue {
  if (key === 'sim') return row.phone.sim_index;
  if (key === 'carrier') return textOr(row.phone.carrier, '');
  if (key === 'service_type') return getSimServiceTypeLabel(row.phone.service_type);
  if (key === 'health') return healthOrder(row.health);
  if (key === 'expiry') return row.expiryDate;
  if (key === 'updated')
    return row.balanceTimestamp
      ? new Date(normalizeUtcTimestamp(row.balanceTimestamp)).getTime()
      : null;
  if (key === 'query') return row.latestCheck?.status ?? '';
  return null;
}

function simOrder(row: BalanceRow): number {
  return row.phone.sim_index === 0 ? 999 : row.phone.sim_index;
}

export function compareOverviewRows(
  left: BalanceRow,
  right: BalanceRow,
  sortKey: OverviewSortKey | null,
  direction: SortDirection,
): number {
  if (!sortKey) {
    return healthOrder(left.health) - healthOrder(right.health) || simOrder(left) - simOrder(right);
  }
  let comparison: number;
  if (sortKey === 'balance') comparison = compareMoney(left.balanceMetric, right.balanceMetric);
  else if (sortKey === 'threshold') {
    comparison =
      compareValues(left.threshold?.currency, right.threshold?.currency) ||
      compareValues(left.threshold?.value, right.threshold?.value);
  } else comparison = compareValues(overviewValue(left, sortKey), overviewValue(right, sortKey));
  if (comparison === 0) comparison = simOrder(left) - simOrder(right);
  return direction === 'asc' ? comparison : -comparison;
}

function timestampValue(check: BalanceCheck): number {
  const value = getBalanceTimestamp(check);
  const time = value ? new Date(normalizeUtcTimestamp(value)).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function historyValue(check: BalanceCheck, key: HistorySortKey): SortValue {
  if (key === 'time') return timestampValue(check);
  if (key === 'sim') return Number(check.sim_index);
  if (key === 'carrier') return textOr(check.profile_carrier, textOr(check.sim_carrier, ''));
  if (key === 'method') return check.method;
  if (key === 'status') return check.status;
  return null;
}

export function compareHistoryChecks(
  left: BalanceCheck,
  right: BalanceCheck,
  sortKey: HistorySortKey,
  direction: SortDirection,
): number {
  let comparison: number;
  if (sortKey === 'balance') {
    comparison = compareMoney(getCashBalance(left), getCashBalance(right));
  } else comparison = compareValues(historyValue(left, sortKey), historyValue(right, sortKey));
  if (comparison === 0) comparison = left.id.localeCompare(right.id);
  return direction === 'asc' ? comparison : -comparison;
}
