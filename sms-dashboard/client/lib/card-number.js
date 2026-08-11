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
