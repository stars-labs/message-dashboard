// Decide whether a global error belongs to this app.
//
// ErrorBoundary listens on window 'error' and 'unhandledrejection', which fire for
// EVERYTHING on the page — including browser extensions. A MetaMask injection failure was
// enough to replace the whole dashboard with "Something went wrong", because the boundary
// treated a foreign rejection as an app crash and called preventDefault() on it.
//
// Extension scripts are identifiable by their URL protocol, which appears in the error's
// filename or its stack.

const EXTENSION_PROTOCOL = /\b(?:chrome|moz|safari|ms-browser|chrome-untrusted)-extension:\/\//i;

// Benign browser noise that is not an application fault.
const IGNORABLE_MESSAGES = [
  // Fired by browsers when a ResizeObserver callback is still settling; harmless.
  /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i,
  // Opaque cross-origin script error — no useful detail, and never actionable.
  /^Script error\.?$/i,
];

export interface ErrorSource {
  filename?: string;
  stack?: string;
  message?: string;
}

/** True when the error did not come from application code. */
export function isForeignError(source: ErrorSource | null | undefined): boolean {
  if (!source) return false;

  const message = typeof source.message === 'string' ? source.message : '';

  if (IGNORABLE_MESSAGES.some((re) => re.test(message))) return true;

  // Check filename and stack together: an extension frame anywhere means the throw did
  // not originate here.
  const location = `${source.filename ?? ''}\n${source.stack ?? ''}`;
  if (EXTENSION_PROTOCOL.test(location)) return true;

  return false;
}

/**
 * Normalise whatever an 'unhandledrejection' carries into an Error.
 *
 * `new Error(event.reason)` was the previous approach, which stringified a rejected Error
 * object and destroyed its stack — that is where the mangled "i: Failed to connect to
 * MetaMask" text came from, `i` being the minified class name.
 */
export function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;

  if (typeof reason === 'string') return new Error(reason);

  if (reason && typeof reason === 'object') {
    const candidate = reason as { message?: unknown };
    const message =
      typeof candidate.message === 'string' && candidate.message
        ? candidate.message
        : safeStringify(reason);
    const error = new Error(message);
    if (typeof (reason as { stack?: unknown }).stack === 'string')
      error.stack = (reason as { stack: string }).stack;
    return error;
  }

  return new Error('Unhandled promise rejection');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'Unhandled promise rejection';
  } catch {
    return 'Unhandled promise rejection';
  }
}
