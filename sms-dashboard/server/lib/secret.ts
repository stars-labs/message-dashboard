async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/**
 * Compares a presented secret with the configured one in constant time. Both
 * sides are hashed first so their lengths match, then every byte is compared
 * without an early exit. An empty or missing secret never matches.
 */
export async function secretMatches(
  presented: string | null,
  expected: string | undefined,
): Promise<boolean> {
  if (!presented || !expected) return false;
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}
