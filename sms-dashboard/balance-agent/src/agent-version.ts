const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function parts(version: string): [number, number, number] | null {
  const match = VERSION.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** False whenever either side is not a release version, such as a development build. */
export function isNewerAgentVersion(candidate: string, current: string): boolean {
  const next = parts(candidate);
  const now = parts(current);
  if (next === null || now === null) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (next[index] ?? 0) - (now[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}
