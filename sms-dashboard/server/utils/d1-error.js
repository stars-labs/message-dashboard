const ROW_READ_LIMIT = "exceeded D1's free tier daily row read limit";
const ROW_WRITE_LIMIT = "exceeded D1's free tier daily row write limit";

function errorText(error) {
  const messages = [error?.message, error?.cause?.message]
    .filter((value) => typeof value === 'string' && value)
    .join(' ');
  return messages || String(error);
}

export function nextD1Reset(now = new Date()) {
  const reset = new Date(now);
  reset.setUTCDate(reset.getUTCDate() + 1);
  reset.setUTCHours(0, 0, 0, 0);
  return reset;
}

export function classifyD1Error(error, now = new Date()) {
  const message = errorText(error);
  if (message.includes(ROW_READ_LIMIT) || message.includes(ROW_WRITE_LIMIT)) {
    const retryAt = nextD1Reset(now);
    return {
      code: 'D1_QUOTA_EXCEEDED',
      quota: message.includes(ROW_READ_LIMIT) ? 'rows_read' : 'rows_written',
      retryAt,
    };
  }

  return { code: 'D1_UNAVAILABLE' };
}

export function logD1Error(operation, error, classification) {
  console.error(JSON.stringify({
    event: 'd1_unavailable',
    operation,
    error_code: classification.code,
    quota: classification.quota ?? null,
    error: errorText(error).slice(0, 1000),
  }));
}
