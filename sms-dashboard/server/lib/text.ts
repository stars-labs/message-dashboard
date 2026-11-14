/** The text, or the fallback when the text is absent or empty. */
export function textOr(value: string | null | undefined, fallback: string): string {
  return value === undefined || value === null || value === '' ? fallback : value;
}
