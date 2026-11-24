import type { BalanceCheck } from '../../../shared/api/balance-checks.js';
import {
  RUNNER_CAPABILITIES,
  type BalanceRunnerCapabilitySummary,
} from '../../../shared/api/balance-runners.js';
import type { CarrierBill } from '../../../shared/api/carrier-bills.js';
import { textOr } from '../../../shared/text.js';
import { normalizeUtcTimestamp } from '../balance-query.js';
import { formatClock } from '../time.js';
import type { BalanceRow } from './types.js';

export function checkCarrier(check: BalanceCheck) {
  return {
    carrier: textOr(check.profile_carrier, check.sim_carrier),
    country: textOr(check.sim_country, check.country_code),
  };
}

export const capabilityLabels = {
  sms_ai: 'AI 短信',
  carrier_browser: '浏览器查询',
} satisfies Record<(typeof RUNNER_CAPABILITIES)[number], string>;

export function capabilityPresentation(
  capability: BalanceRunnerCapabilitySummary | undefined,
  loading: boolean,
) {
  if (loading) return { label: '检测中', dot: 'bg-stone-300', text: 'text-stone-400' };
  if (!capability || capability.state === 'offline') {
    return { label: '离线', dot: 'bg-stone-300', text: 'text-stone-500' };
  }
  if (capability.state === 'degraded') {
    return { label: '部分异常', dot: 'bg-amber-500', text: 'text-amber-700' };
  }
  if (capability.state === 'configuration_required') {
    return { label: '需要配置', dot: 'bg-amber-500', text: 'text-amber-700' };
  }
  if (capability.state === 'busy') {
    return {
      label: capability.detail_code === 'human_verification_required' ? '需要人工验证' : '查询中',
      dot:
        capability.detail_code === 'human_verification_required'
          ? 'bg-orange-500'
          : 'bg-emerald-500',
      text:
        capability.detail_code === 'human_verification_required'
          ? 'text-orange-700'
          : 'text-emerald-700',
    };
  }
  if (capability.available)
    return { label: '正常', dot: 'bg-emerald-500', text: 'text-emerald-700' };
  return { label: '离线', dot: 'bg-stone-300', text: 'text-stone-500' };
}

export function formatBillAmount(bill: Pick<CarrierBill, 'currency' | 'amount_minor'>): string {
  return `${bill.currency} ${(bill.amount_minor / 100).toFixed(2)}`;
}

export function billUrgencyMeta(bill: Pick<CarrierBill, 'urgency' | 'days_remaining'>) {
  const meta = {
    needs_review: { label: '需要复核', className: 'bg-red-50 text-red-700 border-red-200' },
    overdue: {
      label: `逾期 ${Math.abs(bill.days_remaining)} 天`,
      className: 'bg-red-50 text-red-700 border-red-200',
    },
    due_soon: {
      label: bill.days_remaining === 0 ? '今天到期' : `${bill.days_remaining} 天后到期`,
      className: 'bg-amber-50 text-amber-700 border-amber-200',
    },
    open: {
      label: `${bill.days_remaining} 天后到期`,
      className: 'bg-stone-50 text-stone-600 border-stone-200',
    },
    paid: { label: '已付款', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    waived: { label: '已豁免', className: 'bg-stone-50 text-stone-500 border-stone-200' },
  } satisfies Record<CarrierBill['urgency'], { label: string; className: string }>;
  return meta[bill.urgency];
}

export function billActionLabel(status: CarrierBill['action_status']): string {
  return {
    unpaid: '待付款',
    payment_planned: '已计划付款',
    paid: '已付款',
    waived: '已豁免',
    needs_review: '需要复核',
  }[status];
}

const BILL_EVENT_LABELS = new Map([
  ['detected', '检测到账单'],
  ['duplicate_detected', '检测到重复通知'],
  ['parse_conflict', '金额冲突'],
  ['payment_planned', '计划付款'],
  ['paid', '标记已付款'],
  ['waived', '标记豁免'],
  ['reopened', '重新打开'],
]);

export function billEventLabel(type: string): string {
  return BILL_EVENT_LABELS.get(type) ?? type;
}

// One absolute format across both tabs.
export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  return formatClock(normalizeUtcTimestamp(value)) || '—';
}

export function formatThreshold(threshold: BalanceRow['threshold']): string {
  if (!threshold) return '—';
  const value = String(threshold.value);
  return threshold.currency === null ? value : `${value} ${threshold.currency}`;
}
