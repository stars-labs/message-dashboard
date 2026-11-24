import type { Candidate, CandidateList, Waiter } from './types.js';

export async function firstVisible<C extends Candidate>(
  candidates: readonly CandidateList<C>[],
  textPattern: RegExp | null = null,
): Promise<C | null> {
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      if (!textPattern) return candidate;
      const candidateText = await candidate.innerText().catch(() => '');
      textPattern.lastIndex = 0;
      if (textPattern.test(candidateText)) return candidate;
    }
  }
  return null;
}

export async function waitForFirstVisible<C extends Candidate>(
  candidates: readonly CandidateList<C>[],
  page: Waiter,
  {
    timeoutMs = 30_000,
    pollMs = 250,
    textPattern = null,
  }: { timeoutMs?: number; pollMs?: number; textPattern?: RegExp | null } = {},
): Promise<C | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const candidate = await firstVisible(candidates, textPattern);
    if (candidate) return candidate;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await page.waitForTimeout(Math.min(pollMs, remaining));
  }
}
