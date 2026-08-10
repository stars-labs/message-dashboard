// Card-number formatting — the single place that decides how a sim_index
// renders as a 卡号 label. Referenced by 6+ screens; one definition means
// a format change (e.g. 3-digit padding when the fleet grows) touches one file.

/**
 * Format a sim_index as a zero-padded card number string.
 * sim_index 5  → "05"
 * sim_index 42 → "42"
 * null/undefined → "—"
 *
 * @param {number | null | undefined} simIndex
 * @returns {string}
 */
export function formatCardNumber(simIndex) {
  if (simIndex == null) return '—';
  return String(simIndex).padStart(2, '0');
}

/**
 * The full label shown in prose contexts, e.g. "05 号卡".
 * @param {number | null | undefined} simIndex
 * @returns {string}
 */
export function cardLabel(simIndex) {
  if (simIndex == null) return '未知卡';
  return `${formatCardNumber(simIndex)} 号卡`;
}
