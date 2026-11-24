import { getModemPosition } from '../modem-position.js';
import { getStatusMeta } from '../device-status.js';
import { getSimServiceTypeLabel } from '../sim-service-type.js';
import type { IccidMapping } from '../../../shared/api/iccid-mappings.js';
import { textOr } from '../../../shared/text.js';
import type { SortKey } from './model.js';

export const tableColumns: readonly { key: SortKey | null; label: string }[] = [
  { key: 'sim_index', label: '卡号' },
  { key: 'phone_number', label: '手机号' },
  { key: 'iccid', label: 'ICCID' },
  { key: 'carrier', label: '运营商' },
  { key: 'service_type', label: '计费类型' },
  { key: 'sim_role', label: '主副卡' },
  { key: 'position', label: '模块位置' },
  { key: 'signal_quality', label: '信号' },
  { key: 'is_active', label: '状态' },
  { key: 'balance_threshold', label: '余额阈值' },
  { key: 'notes', label: '备注' },
  { key: null, label: '操作' },
];

export function sortValue(mapping: IccidMapping, key: SortKey): string | number {
  if (key === 'sim_index' || key === 'signal_quality' || key === 'balance_threshold')
    return Number(mapping[key]);
  if (key === 'position') return getModemPosition(mapping)?.path ?? '';
  if (key === 'is_active') return getStatusMeta(mapping.is_active).sortOrder;
  if (key === 'notes') return textOr(mapping.notes, '');
  if (key === 'service_type') return getSimServiceTypeLabel(mapping.service_type);
  return textOr(mapping[key], '');
}

function isMissing(value: string | number): boolean {
  return value === '' || (typeof value === 'number' && Number.isNaN(value));
}

export function compareValues(left: string | number, right: string | number): number {
  const leftMissing = isMissing(left);
  const rightMissing = isMissing(right);
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
