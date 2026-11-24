import type { SummaryStatus } from '../../../shared/prepaid-health.js';
import type { BalanceRow, FilterTab, StatusFilter } from './types.js';

export function matchesStatusFilter(
  row: BalanceRow,
  statusFilter: StatusFilter,
  requiresPayment: (row: BalanceRow) => boolean,
): boolean {
  if (statusFilter === 'all') return true;
  if (statusFilter === 'payment') return requiresPayment(row);
  if (statusFilter === 'expiry') return ['expired', 'expiring_soon'].includes(row.health);
  if (statusFilter === 'missing') return ['never_observed', 'expiry_unknown'].includes(row.health);
  return row.health === statusFilter;
}

export function buildFilterTabs(
  carrierRows: readonly BalanceRow[],
  counts: ReadonlyMap<SummaryStatus, number>,
  requiresPayment: (row: BalanceRow) => boolean,
): FilterTab[] {
  const healthCount = (status: SummaryStatus): number => counts.get(status) ?? 0;
  return [
    ['all', '全部', carrierRows.length],
    ['healthy', '正常', healthCount('healthy')],
    ['payment', '需付款', carrierRows.filter(requiresPayment).length],
    ['expiry', '到期处理', healthCount('expired') + healthCount('expiring_soon')],
    ['verification_pending', '待验证', healthCount('verification_pending')],
    ['stale', '数据过期', healthCount('stale')],
    ['query_failed', '查询失败', healthCount('query_failed')],
    ['missing', '未取得', healthCount('never_observed') + healthCount('expiry_unknown')],
    ['not_applicable', '后付费', healthCount('not_applicable')],
  ];
}

export function currentFilterLabel(
  count: number,
  carrierLabel: string | null,
  statusLabel: string | null,
  search: string,
): string {
  const parts: string[] = [];
  if (carrierLabel !== null) parts.push(carrierLabel);
  if (statusLabel !== null) parts.push(statusLabel);
  if (search) parts.push(`搜索「${search}」`);
  return `${parts.length ? `当前筛选：${parts.join(' · ')}` : '当前全部卡片'}（${count} 张）`;
}
