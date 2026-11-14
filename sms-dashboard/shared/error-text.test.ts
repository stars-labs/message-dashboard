import { describe, expect, test } from 'bun:test';
import { errorText } from './error-text.js';

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
