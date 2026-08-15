const OUTBOUND_STATUS = {
  sending: {
    label: '等待发送',
    className: 'border-stone-200 bg-stone-50 text-stone-600',
  },
  processing: {
    label: '发送中',
    className: 'border-blue-200 bg-blue-50 text-blue-700',
  },
  sent: {
    label: '已发送',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
  failed: {
    label: '发送失败',
    className: 'border-red-200 bg-red-50 text-red-700',
  },
  unknown: {
    label: '结果未知',
    className: 'border-amber-200 bg-amber-50 text-amber-800',
  },
};

export function getOutboundStatusMeta(status, errorMessage = null) {
  const meta = OUTBOUND_STATUS[status] || {
    label: status ? `状态：${status}` : '状态未知',
    className: 'border-stone-200 bg-stone-50 text-stone-600',
  };
  return {
    ...meta,
    title: errorMessage || meta.label,
  };
}
