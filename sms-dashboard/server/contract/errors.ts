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

/** A problem as a response, for answers the contract handler does not write itself. */
export function problemResponse(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify(problem(status, code, detail)), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

const Extensions = v.record(v.string(), v.unknown());

/**
 * What a rejected input got wrong: each issue's path and message. Not the issue
 * itself: its path segments carry the input they point into, and the caller's
 * body is not echoed back.
 */
function issuesOf({ issues }: ValidationError) {
  return issues.map(({ path = [], message }) => ({
    path: path
      .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
      .join('.'),
    message,
  }));
}

/**
 * The problem for `error`. A rejected input names its first issue as the detail
 * and lists the rest; otherwise members of an object `data` are extension members.
 */
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

/** The body a daemon route answers whole, in place of its usual error format. */
const WireError = v.object({ wire: v.record(v.string(), v.unknown()) });

export type DaemonErrors = 'plain' | 'flagged';

/**
 * Why a daemon route refused a request: a rejected input names its first
 * issue. A body that is not JSON never gets here; the entry reads it as none,
 * and the route's schema answers it.
 */
function daemonReason(error: ORPCError<string, unknown>): string {
  if (error.cause instanceof ValidationError)
    return error.cause.issues[0]?.message ?? error.message;
  return error.message;
}

/** A failure the procedure did not choose: oRPC wraps what it threw. */
function unexpected(error: ORPCError<string, unknown>): boolean {
  return (
    error.code === 'INTERNAL_SERVER_ERROR' &&
    error.cause !== undefined &&
    !(error.cause instanceof ValidationError)
  );
}

/**
 * The daemon's error format, which shared/control-fixtures/ and the route tests
 * pin: `{ error }` or `{ success: false, error }` as the route declares, or the
 * whole body a refusal gives as `data.wire`. An unexpected failure answers as
 * the Worker's own catch always did, whatever the route's format.
 */
export function daemonErrorOf(errors: DaemonErrors) {
  return (error: ORPCError<string, unknown>) => {
    if (v.is(WireError, error.data)) return error.data.wire;
    if (unexpected(error)) return { error: 'Internal Server Error' };
    if (errors === 'flagged') return { success: false, error: daemonReason(error) };
    return { error: daemonReason(error) };
  };
}
