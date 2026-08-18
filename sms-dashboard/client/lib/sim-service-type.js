export const SIM_SERVICE_TYPES = [
  { value: 'unknown', label: '待确认' },
  { value: 'prepaid', label: '预付费' },
  { value: 'postpaid', label: '后付费' },
  { value: 'n/a', label: '不适用' },
];

export const SIM_SERVICE_TYPE_SOURCES = [
  { value: 'carrier_account', label: '运营商 App / 门户' },
  { value: 'carrier_support', label: '运营商客服' },
  { value: 'contract_or_bill', label: '合同 / 账单' },
  { value: 'carrier_message', label: '明确的运营商服务短信' },
];

export function getSimServiceTypeLabel(value) {
  return SIM_SERVICE_TYPES.find((option) => option.value === value)?.label || '待确认';
}

export function getSimServiceTypeSourceLabel(value) {
  return SIM_SERVICE_TYPE_SOURCES.find((option) => option.value === value)?.label || '—';
}
