import type { PollHeaders } from '../../../shared/recurring.js';

const SHORTEST_MS = 1_000;
const LONGEST_MS = 600_000;

/** How long to wait before the next recurring call, as the Worker paced it (ADR 0002). */
export function pollDelayMs(headers: PollHeaders): number {
  const asked = Number(headers['x-poll-interval']) * 1000;
  return Math.min(LONGEST_MS, Math.max(SHORTEST_MS, asked));
}
