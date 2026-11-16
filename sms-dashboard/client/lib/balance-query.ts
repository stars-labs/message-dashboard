import type {
  BalanceCheck,
  BalanceCheckDetail,
  BalanceConversationMessage,
  BalanceMetric,
} from '../../shared/api/balance-checks.js';
import type { DisplayStatus } from '../../shared/balance-status.js';
import { textOr } from '../../shared/text.js';

/** The display metadata for one balance-check status. */
interface BalanceStatusMeta {
  label: string;
  className: string;
}

const STATUS_META = {
  queued: { label: '排队中', className: 'bg-stone-100 text-stone-600 border-stone-200' },
  awaiting_response: {
    label: '等待回复',
    className: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  response_received: { label: '已收到回复', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  skill_pending: { label: '等待 AI', className: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  skill_processing: { label: 'AI 判断中', className: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  web_pending: { label: '等待本机', className: 'bg-stone-100 text-stone-600 border-stone-200' },
  web_processing: { label: '打开联通网站', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  web_otp: { label: '等待登录码', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  web_authenticating: { label: '正在登录', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  web_querying: { label: '查询中', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  web_human_required: {
    label: '需要人工验证',
    className: 'bg-amber-50 text-amber-800 border-amber-300',
  },
  parsed: { label: '已解析', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  failed: { label: '失败', className: 'bg-red-50 text-red-700 border-red-200' },
  timed_out: { label: '已超时', className: 'bg-stone-100 text-stone-600 border-stone-200' },
  unparsed: { label: '待识别', className: 'bg-amber-50 text-amber-700 border-amber-200' },
} satisfies Record<DisplayStatus, BalanceStatusMeta>;

const METRIC_LABELS = new Map([
  ['cash_balance', '账户余额'],
  ['current_charges', '本期费用'],
  ['arrears', '欠费金额'],
  ['account_expiry', '账户有效期'],
  ['data_remaining', '剩余流量'],
  ['sms_remaining', '剩余短信'],
  ['voice_remaining', '剩余通话'],
]);

export function getBalanceStatusMeta(status: DisplayStatus): BalanceStatusMeta {
  return STATUS_META[status];
}

/** When the check last moved: its newest message, else the latest timestamp it carries. */
export function getBalanceTimestamp(
  check: BalanceCheck,
  detail: BalanceCheckDetail | null = null,
): string | null {
  return (
    getBalanceConversation(check, detail).at(-1)?.timestamp ??
    check.response_timestamp ??
    check.completed_at ??
    check.sent_at ??
    check.outbound_timestamp ??
    check.requested_at
  );
}

/** The messages of a check: from its loaded detail, else the outbound and reply it carries. */
export function getBalanceConversation(
  check: BalanceCheck,
  detail: BalanceCheckDetail | null = null,
): BalanceConversationMessage[] {
  if (detail !== null && detail.conversation.length > 0) return detail.conversation;

  const messages: BalanceConversationMessage[] = [];
  const sent = textOr(check.outbound_content, textOr(check.command, null));
  if (sent !== null) {
    messages.push({
      id: `${check.id}-outbound`,
      type: 'sent',
      content: sent,
      recipient: textOr(check.outbound_recipient, check.destination),
      phone_number: null,
      timestamp: check.outbound_timestamp ?? check.sent_at,
      status: check.outbound_status,
    });
  }
  const reply = textOr(check.response_content, textOr(check.raw_response, null));
  if (reply !== null) {
    messages.push({
      id: `${check.id}-response`,
      type: 'received',
      content: reply,
      recipient: null,
      phone_number: textOr(check.response_phone_number, check.response_sender),
      timestamp: check.response_timestamp ?? check.completed_at,
      status: null,
    });
  }
  return messages;
}

export function getLatestBalanceReply(
  check: BalanceCheck,
  detail: BalanceCheckDetail | null = null,
): BalanceConversationMessage | null {
  return (
    getBalanceConversation(check, detail).findLast((message) => message.type === 'received') ?? null
  );
}

export function getCashBalance(check: Pick<BalanceCheck, 'metrics'> | null): BalanceMetric | null {
  return check?.metrics.find((metric) => metric.metric_type === 'cash_balance') ?? null;
}

export function getBalanceMetricLabel(metricType: string): string {
  return METRIC_LABELS.get(metricType) ?? textOr(metricType, '未知指标');
}

export function formatBalanceMetric(metric: BalanceMetric | null): string {
  if (metric?.value == null || !Number.isFinite(metric.value)) return '暂未取得';
  const { value, currency, unit } = metric;

  if (currency !== null && currency !== '') {
    try {
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
      }).format(value);
    } catch {
      return `${value.toFixed(2)} ${currency}`;
    }
  }

  return `${String(value)}${unit !== null && unit !== '' ? ` ${unit}` : ''}`;
}

/** D1 stores UTC without a zone; mark it as UTC so the browser does not read local time. */
export function normalizeUtcTimestamp<T extends string | null | undefined>(value: T): T | string {
  if (typeof value !== 'string' || value === '') return value;
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
}
