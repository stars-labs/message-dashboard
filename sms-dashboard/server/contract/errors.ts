import { ValidationError, type ORPCError } from '@orpc/server';
import * as v from 'valibot';

const TITLES: Partial<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/** An RFC 9457 problem: `type` is about:blank, so `title` is the status phrase. */
function problem(status: number, code: string, detail: string) {
  return { type: 'about:blank', title: TITLES[status] ?? 'Error', status, detail, code };
}

export function problemResponse(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify(problem(status, code, detail)), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

const Extensions = v.record(v.string(), v.unknown());

// Path and message only: the issue itself carries the caller's input.
function issuesOf({ issues }: ValidationError) {
  return issues.map(({ path = [], message }) => ({
    path: path
      .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
      .join('.'),
    message,
  }));
}

export function problemOf(error: ORPCError<string, unknown>) {
  if (error.cause instanceof ValidationError) {
    const issues = issuesOf(error.cause);
    return {
      ...problem(error.status, error.code, issues[0]?.message ?? error.message),
      issues,
    };
  }
  const fixed = problem(error.status, error.code, error.message);
  const extensions = v.is(Extensions, error.data) ? error.data : {};
  return {
    ...fixed,
    ...Object.fromEntries(Object.entries(extensions).filter(([name]) => !(name in fixed))),
  };
}

const WireError = v.object({ wire: v.record(v.string(), v.unknown()) });

export type DaemonErrors = 'plain' | 'flagged';

function daemonReason(error: ORPCError<string, unknown>): string {
  if (error.cause instanceof ValidationError)
    return error.cause.issues[0]?.message ?? error.message;
  return error.message;
}

function unexpected(error: ORPCError<string, unknown>): boolean {
  return (
    error.code === 'INTERNAL_SERVER_ERROR' &&
    error.cause !== undefined &&
    !(error.cause instanceof ValidationError)
  );
}

// The daemon's wire error format, pinned by shared/control-fixtures/: `{ error }`,
// `{ success: false, error }`, or the whole body in `data.wire`.
export function daemonErrorOf(errors: DaemonErrors) {
  return (error: ORPCError<string, unknown>) => {
    if (v.is(WireError, error.data)) return error.data.wire;
    if (unexpected(error)) return { error: 'Internal Server Error' };
    if (errors === 'flagged') return { success: false, error: daemonReason(error) };
    return { error: daemonReason(error) };
  };
}
