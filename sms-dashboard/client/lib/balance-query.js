const STATUS_META = {
  queued: { label: '排队中', className: 'bg-stone-100 text-stone-600 border-stone-200' },
  awaiting_response: { label: '等待回复', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  response_received: { label: '已收到回复', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  parsed: { label: '已解析', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  failed: { label: '失败', className: 'bg-red-50 text-red-700 border-red-200' },
  timed_out: { label: '已超时', className: 'bg-stone-100 text-stone-600 border-stone-200' },
  unparsed: { label: '待识别', className: 'bg-amber-50 text-amber-700 border-amber-200' },
};

const METRIC_LABELS = {
  cash_balance: '账户余额',
  current_charges: '本期费用',
  arrears: '欠费金额',
  account_expiry: '账户有效期',
  data_remaining: '剩余流量',
  sms_remaining: '剩余短信',
  voice_remaining: '剩余通话',
};

export function getBalanceStatusMeta(status) {
  return STATUS_META[status] || {
    label: status || '未知',
    className: 'bg-stone-100 text-stone-600 border-stone-200',
  };
}

export function getBalanceTimestamp(check) {
  return check?.response_timestamp
    || check?.completed_at
    || check?.sent_at
    || check?.outbound_timestamp
    || check?.requested_at
    || null;
}

export function getCashBalance(check) {
  return check?.metrics?.find((metric) => metric.metric_type === 'cash_balance') || null;
}

export function getBalanceMetricLabel(metricType) {
  return METRIC_LABELS[metricType] || metricType || '未知指标';
}

export function formatBalanceMetric(metric) {
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

export function normalizeUtcTimestamp(value) {
  if (!value || typeof value !== 'string') return value;
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
}
