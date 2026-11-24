// Only the primary card is balance-queried; secondaries follow it.

type SimRole = 'standalone' | 'primary' | 'secondary';

interface SimRoleOption {
  value: SimRole;
  label: string;
}

export const SIM_ROLES: readonly SimRoleOption[] = [
  { value: 'standalone', label: '独立' },
  { value: 'primary', label: '主卡' },
  { value: 'secondary', label: '副卡' },
];

export function getSimRoleLabel(value: string | null | undefined): string {
  return SIM_ROLES.find((option) => option.value === value)?.label ?? '独立';
}
