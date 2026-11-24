// Maps the status values the server emits from the device_view SQL CASE onto display buckets.
//
// Tailwind class strings must be complete literals: the compiler scans source text, so a
// template like `bg-${c}-500` would produce nothing in the bundle.

import { textOr } from '../../shared/text.js';

interface DeviceStatusMeta {
  label: string;
  dotClass: string;
  badgeClass: string;
  rowClass: string;
  sortOrder: number;
}

const UNMAPPED: DeviceStatusMeta = {
  label: '待映射',
  dotClass: 'bg-amber-400',
  badgeClass: 'bg-amber-50 text-amber-600 border border-amber-200',
  rowClass: 'bg-amber-50',
  sortOrder: 4,
};

const STATUS = new Map<string, DeviceStatusMeta>([
  [
    'active',
    {
      label: '在线',
      dotClass: 'bg-emerald-500',
      badgeClass: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
      rowClass: '',
      sortOrder: 0,
    },
  ],
  [
    'offline',
    {
      label: '离线',
      dotClass: 'bg-stone-300',
      badgeClass: 'bg-stone-100 text-stone-500 border border-stone-200',
      rowClass: '',
      sortOrder: 1,
    },
  ],
  [
    'sim_error',
    {
      label: '读卡失败',
      dotClass: 'bg-red-500',
      badgeClass: 'bg-red-50 text-red-600 border border-red-200',
      rowClass: 'bg-red-50',
      sortOrder: 2,
    },
  ],
  [
    'iccid_mismatch',
    {
      label: 'ICCID 不符',
      dotClass: 'bg-amber-500',
      badgeClass: 'bg-amber-50 text-amber-700 border border-amber-200',
      rowClass: 'bg-amber-50',
      sortOrder: 3,
    },
  ],
  // Both mean the slot has no mapped number yet.
  ['unassigned', UNMAPPED],
  ['no_modem', UNMAPPED],
]);

const FALLBACK: DeviceStatusMeta = {
  label: '离线',
  dotClass: 'bg-stone-300',
  badgeClass: 'bg-stone-100 text-stone-500 border border-stone-200',
  rowClass: '',
  sortOrder: 1,
};

export function getStatusMeta(status: string | null | undefined): DeviceStatusMeta {
  return (status ? STATUS.get(status) : undefined) ?? FALLBACK;
}

export function isAnomalous(status: string | null | undefined): boolean {
  return getStatusMeta(status).sortOrder >= 2;
}

// Mapping states stay separate so "待映射" is its own filter and no card counts in two buckets.
export function hasOperationalIssue(status: string | null | undefined): boolean {
  return ['offline', 'sim_error', 'iccid_mismatch'].includes(String(status));
}

// A stale `active` value must not render as online after the daemon disconnects.
export function getEffectiveDeviceStatus(
  status: string | null | undefined,
  daemonConnected: boolean,
): string {
  return daemonConnected ? textOr(status, 'offline') : 'offline';
}
