export function isoNow(): string {
  return new Date().toISOString();
}

export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}
