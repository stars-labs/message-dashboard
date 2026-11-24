// The single formatter for the 卡号 label: 5 -> "S05", null -> "—".
export function formatCardNumber(simIndex: number | null | undefined): string {
  if (simIndex == null) return '—';
  return `S${String(simIndex).padStart(2, '0')}`;
}
