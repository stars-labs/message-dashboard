async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

// Constant time: both sides are hashed so their lengths match, then compared without an early exit.
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
