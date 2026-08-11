// Single source of truth for device status display.
//
// The server emits exactly 6 canonical states from the device_view SQL CASE
// (migrations 033/034). Previously three components each had their own status
// vocabulary — PhoneList invented "online"/"registered"/"connected"/"stale"/
// "unknown" that the server never sends. This module maps the 6 real server
// values onto the 5 display buckets the redesign uses.
//
// Tailwind class strings must be complete literals here: the compiler finds
// classes by scanning source text, so a template like `bg-${c}-500` would
// produce nothing in the output bundle.

/** @type {Record<string, {label: string, dotClass: string, badgeClass: string, rowClass: string, sortOrder: number}>} */
const STATUS = {
  active: {
    label: '在线',
    dotClass: 'bg-emerald-500',
    badgeClass: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
    rowClass: '',
    sortOrder: 0,
  },
  offline: {
    label: '离线',
    dotClass: 'bg-stone-300',
    badgeClass: 'bg-stone-100 text-stone-500 border border-stone-200',
    rowClass: '',
    sortOrder: 1,
  },
  sim_error: {
    label: '读卡失败',
    dotClass: 'bg-red-500',
    badgeClass: 'bg-red-50 text-red-600 border border-red-200',
    rowClass: 'bg-red-50',
    sortOrder: 2,
  },
  iccid_mismatch: {
    label: 'ICCID 不符',
    dotClass: 'bg-amber-500',
    badgeClass: 'bg-amber-50 text-amber-700 border border-amber-200',
    rowClass: 'bg-amber-50',
    sortOrder: 3,
  },
  // unassigned and no_modem both mean the same thing to the user: the slot
  // has no mapped number yet and needs action.
  unassigned: {
    label: '待映射',
    dotClass: 'bg-amber-400',
    badgeClass: 'bg-amber-50 text-amber-600 border border-amber-200',
    rowClass: 'bg-amber-50',
    sortOrder: 4,
  },
  no_modem: {
    label: '待映射',
    dotClass: 'bg-amber-400',
    badgeClass: 'bg-amber-50 text-amber-600 border border-amber-200',
    rowClass: 'bg-amber-50',
    sortOrder: 4,
  },
};

const FALLBACK = {
  label: '离线',
  dotClass: 'bg-stone-300',
  badgeClass: 'bg-stone-100 text-stone-500 border border-stone-200',
  rowClass: '',
  sortOrder: 1,
};

/**
 * Return display metadata for a server-emitted status string.
 * Always returns a valid object — unknown values fall back to 离线.
 *
 * @param {string | null | undefined} status
 */
export function getStatusMeta(status) {
  return STATUS[status] ?? FALLBACK;
}

/**
 * Whether a status requires user action (tinted row in the list).
 * @param {string | null | undefined} status
 */
export function isAnomalous(status) {
  return getStatusMeta(status).sortOrder >= 2;
}

/**
 * Whether a mapped card is unavailable because of a runtime/device fault.
 * Mapping states stay separate so the management screen can offer a distinct
 * "待映射" filter instead of counting the same card in two buckets.
 * @param {string | null | undefined} status
 */
export function hasOperationalIssue(status) {
  return ['offline', 'sim_error', 'iccid_mismatch'].includes(status);
}
