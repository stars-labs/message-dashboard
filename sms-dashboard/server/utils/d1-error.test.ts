import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  boundedErrorText,
  classifyD1Error,
  errorText,
  logD1Error,
  nextD1Reset,
} from './d1-error.js';

const READ_LIMIT = "exceeded D1's free tier daily row read limit";
const WRITE_LIMIT = "exceeded D1's free tier daily row write limit";

describe('errorText', () => {
  test('reads the message of an Error', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
  });

  test('appends the message of the cause', () => {
    expect(errorText(new Error('D1_ERROR', { cause: new Error('inner') }))).toBe('D1_ERROR inner');
  });

  test('reads message and cause from plain objects', () => {
    expect(errorText({ message: 'outer', cause: { message: 'inner' } })).toBe('outer inner');
  });

  test('ignores empty and non-string messages', () => {
    expect(errorText({ message: '', cause: { message: 'inner' } })).toBe('inner');
    expect(errorText({ message: 42 })).toBe('[object Object]');
  });

  test('falls back to String() for values without a message', () => {
    expect(errorText('plain')).toBe('plain');
    expect(errorText(null)).toBe('null');
    expect(errorText(undefined)).toBe('undefined');
    expect(errorText(7)).toBe('7');
  });
});

describe('boundedErrorText', () => {
  test('truncates to the limit', () => {
    expect(boundedErrorText(new Error('abcdef'), 3)).toBe('abc');
  });

  test('defaults to 1000 characters', () => {
    expect(boundedErrorText(new Error('x'.repeat(1500)))).toHaveLength(1000);
  });
});

describe('nextD1Reset', () => {
  test('is the next UTC midnight', () => {
    expect(nextD1Reset(new Date('2026-03-05T23:59:59.999Z')).toISOString()).toBe(
      '2026-03-06T00:00:00.000Z',
    );
    expect(nextD1Reset(new Date('2026-03-05T00:00:00.000Z')).toISOString()).toBe(
      '2026-03-06T00:00:00.000Z',
    );
  });

  test('rolls over month ends and does not mutate its input', () => {
    const now = new Date('2026-12-31T10:00:00.000Z');
    expect(nextD1Reset(now).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(now.toISOString()).toBe('2026-12-31T10:00:00.000Z');
  });
});

describe('classifyD1Error', () => {
  const now = new Date('2026-03-05T12:00:00.000Z');

  test('classifies a row read quota error with the reset time', () => {
    const result = classifyD1Error(new Error(`D1_ERROR: ${READ_LIMIT}`), now);
    expect(result).toEqual({
      code: 'D1_QUOTA_EXCEEDED',
      quota: 'rows_read',
      retryAt: new Date('2026-03-06T00:00:00.000Z'),
    });
  });

  test('classifies a row write quota error', () => {
    const result = classifyD1Error(new Error(WRITE_LIMIT), now);
    expect(result.code).toBe('D1_QUOTA_EXCEEDED');
    expect(result.quota).toBe('rows_written');
  });

  test('finds the quota message in the cause', () => {
    const result = classifyD1Error(new Error('D1_ERROR', { cause: new Error(READ_LIMIT) }), now);
    expect(result.quota).toBe('rows_read');
  });

  test('any other failure is unavailable without a retry time', () => {
    expect(classifyD1Error(new Error('network down'), now)).toEqual({ code: 'D1_UNAVAILABLE' });
    expect(classifyD1Error('nope', now)).toEqual({ code: 'D1_UNAVAILABLE' });
  });
});

describe('logD1Error', () => {
  const original = console.error;
  let calls: unknown[][] = [];

  beforeEach(() => {
    calls = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
  });

  afterEach(() => {
    console.error = original;
  });

  test('logs one JSON line for a quota error', () => {
    const error = new Error(READ_LIMIT);
    logD1Error('list messages', error, classifyD1Error(error));
    expect(calls).toEqual([
      [
        JSON.stringify({
          event: 'd1_unavailable',
          operation: 'list messages',
          error_code: 'D1_QUOTA_EXCEEDED',
          quota: 'rows_read',
          error: READ_LIMIT,
        }),
      ],
    ]);
  });

  test('logs a null quota for other failures', () => {
    const error = new Error('boom');
    logD1Error('op', error, classifyD1Error(error));
    expect(calls).toEqual([
      [
        JSON.stringify({
          event: 'd1_unavailable',
          operation: 'op',
          error_code: 'D1_UNAVAILABLE',
          quota: null,
          error: 'boom',
        }),
      ],
    ]);
  });
});
