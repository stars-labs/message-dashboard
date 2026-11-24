function messageOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'message' in value
    ? value.message
    : undefined;
}

function causeOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'cause' in value ? value.cause : undefined;
}

export function errorText(error: unknown): string {
  const messages = [messageOf(error), messageOf(causeOf(error))]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
  return messages || String(error);
}
