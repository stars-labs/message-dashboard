const ROW_READ_LIMIT = "exceeded D1's free tier daily row read limit";
const ROW_WRITE_LIMIT = "exceeded D1's free tier daily row write limit";

/** The bits of a thrown value this module reads. `cause` is ES2022 chaining. */
interface ErrorLike {
  message?: unknown;
  cause?: { message?: unknown };
}

export function errorText(error: unknown): string {
  const e = error as ErrorLike | null | undefined;
  const messages = [e?.message, e?.cause?.message]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
  return messages || String(error);
}

export function boundedErrorText(error: unknown, maxLength = 1000): string {
  return errorText(error).slice(0, maxLength);
}

export function nextD1Reset(now: Date = new Date()): Date {
  const reset = new Date(now);
  reset.setUTCDate(reset.getUTCDate() + 1);
  reset.setUTCHours(0, 0, 0, 0);
  return reset;
}

/**
 * A quota error carries when it clears; any other failure has no retry time.
 * The union makes that a compile-time distinction rather than an optional
 * field the caller has to remember to check.
 */
export type D1ErrorClassification =
  | { code: 'D1_QUOTA_EXCEEDED'; quota: 'rows_read' | 'rows_written'; retryAt: Date }
  | { code: 'D1_UNAVAILABLE'; quota?: undefined; retryAt?: undefined };

export function classifyD1Error(error: unknown, now: Date = new Date()): D1ErrorClassification {
  const message = errorText(error);
  if (message.includes(ROW_READ_LIMIT) || message.includes(ROW_WRITE_LIMIT)) {
    return {
      code: 'D1_QUOTA_EXCEEDED',
      quota: message.includes(ROW_READ_LIMIT) ? 'rows_read' : 'rows_written',
      retryAt: nextD1Reset(now),
    };
  }

  return { code: 'D1_UNAVAILABLE' };
}

export function logD1Error(
  operation: string,
  error: unknown,
  classification: D1ErrorClassification,
): void {
  console.error(
    JSON.stringify({
      event: 'd1_unavailable',
      operation,
      error_code: classification.code,
      quota: classification.quota ?? null,
      error: boundedErrorText(error),
    }),
  );
}
