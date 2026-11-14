/** The text, or the fallback when the text is absent or empty. */
export function textOr<Fallback extends string | null>(
  value: string | null | undefined,
  fallback: Fallback,
): string | Fallback {
  return value === undefined || value === null || value === '' ? fallback : value;
}
