// SIM primary/secondary role. China SIMs may be sold as a primary card plus
// one or more supplementary cards; only the primary is balance-queried.
// See migrations/059_add_sim_primary_secondary.sql.

export const SIM_ROLES = [
  { value: 'standalone', label: '独立' },
  { value: 'primary', label: '主卡' },
  { value: 'secondary', label: '副卡' },
];

export function getSimRoleLabel(value) {
  return SIM_ROLES.find((option) => option.value === value)?.label || '独立';
}
