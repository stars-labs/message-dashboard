// window 'error' and 'unhandledrejection' also fire for browser extensions, which must not
// replace the dashboard with an error screen. Extension scripts are identifiable by their
// URL protocol in the error's filename or stack.

const EXTENSION_PROTOCOL = /\b(?:chrome|moz|safari|ms-browser|chrome-untrusted)-extension:\/\//i;

const IGNORABLE_MESSAGES = [
  /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i,
  // Opaque cross-origin script error: no detail, never actionable.
  /^Script error\.?$/i,
];

interface ErrorSource {
  filename?: string | undefined;
  stack?: string | undefined;
  message?: string | undefined;
}

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

// Wrapping a rejected Error in `new Error(reason)` would stringify it and lose its stack.
export function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;

  if (typeof reason === 'string') return new Error(reason);

  if (reason && typeof reason === 'object') {
    const message =
      'message' in reason && typeof reason.message === 'string' && reason.message
        ? reason.message
        : safeStringify(reason);
    const error = new Error(message);
    if ('stack' in reason && typeof reason.stack === 'string') error.stack = reason.stack;
    return error;
  }

  return new Error('Unhandled promise rejection');
}

// lib.d.ts omits that JSON.stringify returns undefined for an object whose toJSON does.
const stringify: (value: unknown) => string | undefined = JSON.stringify;

function safeStringify(value: unknown): string {
  try {
    return stringify(value) ?? 'Unhandled promise rejection';
  } catch {
    return 'Unhandled promise rejection';
  }
}
