/** The display metadata for one balance-check status (server or derived). */
export interface BalanceStatusMeta {
  label: string;
  className: string;
}

/** A conversation message, built from a check or read from its detail payload. */
export interface BalanceConversationMessage {
  id: string;
  type: 'sent' | 'received';
  content?: string | null;
  recipient?: string | null;
  phone_number?: string | null;
  timestamp?: string | null;
  status?: string | null;
}

/** A balance metric row as the API returns it. */
export interface BalanceMetricRow {
  metric_type: string;
  value: number | string | null;
  unit?: string | null;
  currency?: string | null;
  expires_at?: string | null;
}

/** The balance check fields these helpers read. */
export interface BalanceCheckLike {
  id: string;
  status?: string | null;
  conversation?: BalanceConversationMessage[];
  outbound_message_id?: string | null;
  outbound_content?: string | null;
  command?: string | null;
  outbound_recipient?: string | null;
  destination?: string | null;
  outbound_timestamp?: string | null;
  sent_at?: string | null;
  outbound_status?: string | null;
  response_content?: string | null;
  raw_response?: string | null;
  response_message_id?: string | null;
  response_phone_number?: string | null;
  response_sender?: string | null;
  response_timestamp?: string | null;
  completed_at?: string | null;
  requested_at?: string | null;
  metrics?: BalanceMetricRow[];
  [column: string]: unknown;
}

const STATUS_META: Record<string, BalanceStatusMeta> = {
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
};

const METRIC_LABELS: Record<string, string> = {
  cash_balance: '账户余额',
  current_charges: '本期费用',
  arrears: '欠费金额',
  account_expiry: '账户有效期',
  data_remaining: '剩余流量',
  sms_remaining: '剩余短信',
  voice_remaining: '剩余通话',
};

export function getBalanceStatusMeta(status: string | null | undefined): BalanceStatusMeta {
  return (
    (status ? STATUS_META[status] : undefined) || {
      label: status || '未知',
      className: 'bg-stone-100 text-stone-600 border-stone-200',
    }
  );
}

export function getBalanceTimestamp(check: BalanceCheckLike | null | undefined): string | null {
  const conversation = getBalanceConversation(check);
  return (
    conversation.at(-1)?.timestamp ||
    check?.response_timestamp ||
    check?.completed_at ||
    check?.sent_at ||
    check?.outbound_timestamp ||
    check?.requested_at ||
    null
  );
}

export function getBalanceConversation(
  check: BalanceCheckLike | null | undefined,
): BalanceConversationMessage[] {
  if (Array.isArray(check?.conversation) && check.conversation.length) {
    return check.conversation;
  }

  const messages: BalanceConversationMessage[] = [];
  if (check?.outbound_content || check?.command) {
    messages.push({
      id: check.outbound_message_id || `${check.id}-outbound`,
      type: 'sent',
      content: check.outbound_content || check.command,
      recipient: check.outbound_recipient || check.destination,
      timestamp: check.outbound_timestamp || check.sent_at,
      status: check.outbound_status,
    });
  }
  if (check?.response_content || check?.raw_response) {
    messages.push({
      id: check.response_message_id || `${check.id}-response`,
      type: 'received',
      content: check.response_content || check.raw_response,
      phone_number: check.response_phone_number || check.response_sender,
      timestamp: check.response_timestamp || check.completed_at,
    });
  }
  return messages;
}

export function getLatestBalanceReply(
  check: BalanceCheckLike | null | undefined,
): BalanceConversationMessage | null {
  return (
    [...getBalanceConversation(check)].reverse().find((message) => message.type === 'received') ||
    null
  );
}

export function getCashBalance(
  check: BalanceCheckLike | null | undefined,
): BalanceMetricRow | null {
  return check?.metrics?.find((metric) => metric.metric_type === 'cash_balance') || null;
}

export function getBalanceMetricLabel(metricType: string | null | undefined): string {
  return (metricType ? METRIC_LABELS[metricType] : undefined) || metricType || '未知指标';
}

export function formatBalanceMetric(metric: BalanceMetricRow | null | undefined): string {
  if (!metric || metric.value == null) return '暂未取得';
  const value = Number(metric.value);
  if (!Number.isFinite(value)) return '暂未取得';

  if (metric.currency) {
    try {
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: metric.currency,
        minimumFractionDigits: 2,
      }).format(value);
    } catch {
      return `${value.toFixed(2)} ${metric.currency}`;
    }
  }

  return `${value}${metric.unit ? ` ${metric.unit}` : ''}`;
}

export function normalizeUtcTimestamp<T extends string | null | undefined>(value: T): T | string {
  if (!value || typeof value !== 'string') return value;
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
}
