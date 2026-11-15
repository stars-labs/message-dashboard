import { ValidationError, type ORPCError } from '@orpc/server';
import * as v from 'valibot';
import { NOT_JSON_MESSAGE } from '../lib/request-body.js';

const TITLES: Partial<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
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

/**
 * The daemon's error format, which shared/control-fixtures/ pins. oRPC decodes
 * the body before any procedure runs, so a body that is not JSON arrives here
 * as a BAD_REQUEST caused by JSON.parse.
 */
export function daemonErrorOf(error: ORPCError<string, unknown>) {
  return {
    success: false,
    error: error.cause instanceof SyntaxError ? NOT_JSON_MESSAGE : error.message,
  };
}
