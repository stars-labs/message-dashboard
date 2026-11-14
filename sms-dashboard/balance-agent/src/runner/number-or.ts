export function numberOr(value: unknown, fallback: number): number {
  if (value) return Number(value);
  return fallback;
}
