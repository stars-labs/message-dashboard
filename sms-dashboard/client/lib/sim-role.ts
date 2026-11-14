// SIM primary/secondary role. China SIMs may be sold as a primary card plus
// one or more supplementary cards; only the primary is balance-queried.
// See migrations/059_add_sim_primary_secondary.sql.

type SimRole = 'standalone' | 'primary' | 'secondary';

interface SimRoleOption {
  value: SimRole;
  label: string;
}

export const SIM_ROLES: SimRoleOption[] = [
  { value: 'standalone', label: '独立' },
  { value: 'primary', label: '主卡' },
  { value: 'secondary', label: '副卡' },
];

export function getSimRoleLabel(value: string | null | undefined): string {
  return SIM_ROLES.find((option) => option.value === value)?.label || '独立';
}
