// Run with: bun test client/lib/error-origin.test.js
import { describe, expect, test } from 'bun:test';
import { isForeignError, toError } from './error-origin.js';

describe('isForeignError — browser extensions', () => {
  // The reported bug: MetaMask's injected script rejected, and the dashboard replaced
  // itself with "Something went wrong".
  test('treats a chrome-extension stack as foreign', () => {
    expect(
      isForeignError({
        message: 'Failed to connect to MetaMask',
        stack:
          'Error: Failed to connect to MetaMask\n    at chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js:1:1',
      })
    ).toBe(true);
  });

  test('treats an extension filename as foreign', () => {
    expect(
      isForeignError({ filename: 'chrome-extension://abcdef/contentscript.js', message: 'boom' })
    ).toBe(true);
  });

  test('recognises other browsers\' extension protocols', () => {
    for (const proto of ['moz-extension', 'safari-extension', 'ms-browser-extension']) {
      expect(isForeignError({ filename: `${proto}://x/y.js`, message: 'boom' })).toBe(true);
    }
  });
});

describe('isForeignError — benign browser noise', () => {
  test('ignores ResizeObserver loop warnings', () => {
    expect(isForeignError({ message: 'ResizeObserver loop limit exceeded' })).toBe(true);
    expect(
      isForeignError({ message: 'ResizeObserver loop completed with undelivered notifications.' })
    ).toBe(true);
  });

  test('ignores opaque cross-origin script errors', () => {
    expect(isForeignError({ message: 'Script error.', filename: '' })).toBe(true);
  });
});

// The boundary must still catch genuine application faults, or this fix would trade one
// bug for a worse one.
describe('isForeignError — real application errors', () => {
  test('does not treat an app bundle error as foreign', () => {
    expect(
      isForeignError({
        message: "Cannot read properties of undefined (reading 'iccid')",
        filename: 'https://sexy.itoken.world/assets/index-abc123.js',
        stack: 'TypeError: ...\n    at https://sexy.itoken.world/assets/index-abc123.js:42:7',
      })
    ).toBe(false);
  });

  test('does not treat an API failure as foreign', () => {
    expect(isForeignError({ message: 'Auth0 Management API request failed: ... (429)' })).toBe(false);
  });

  test('does not treat a stackless app error as foreign', () => {
    expect(isForeignError({ message: 'Authentication required' })).toBe(false);
  });

  test('returns false for null/empty input rather than swallowing it', () => {
    expect(isForeignError(null)).toBe(false);
    expect(isForeignError({})).toBe(false);
  });

  test('does not match the word extension in ordinary prose', () => {
    expect(isForeignError({ message: 'File extension: not supported' })).toBe(false);
  });
});

describe('toError', () => {
  test('passes an Error through, preserving its stack', () => {
    const original = new Error('real failure');
    expect(toError(original)).toBe(original);
    expect(toError(original).stack).toBe(original.stack);
  });

  test('wraps a string', () => {
    expect(toError('something broke').message).toBe('something broke');
  });

  // The old code did `new Error(event.reason)`, which stringified the object into
  // "i: Failed to connect to MetaMask" and lost the stack entirely.
  test('extracts message and stack from an error-like object', () => {
    const result = toError({ message: 'Failed to connect to MetaMask', stack: 'at foo.js:1:1' });
    expect(result.message).toBe('Failed to connect to MetaMask');
    expect(result.stack).toBe('at foo.js:1:1');
  });

  test('serialises a plain object rather than producing [object Object]', () => {
    expect(toError({ code: 42 }).message).toBe('{"code":42}');
  });

  test('handles a circular object without throwing', () => {
    const circular = { a: 1 };
    circular.self = circular;
    expect(toError(circular).message).toBe('Unhandled promise rejection');
  });

  test('handles undefined and null', () => {
    expect(toError(undefined).message).toBe('Unhandled promise rejection');
    expect(toError(null).message).toBe('Unhandled promise rejection');
  });
});
