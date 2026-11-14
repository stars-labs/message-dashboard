import { afterEach, beforeEach, describe, expect, mock, spyOn, test, type Mock } from 'bun:test';

const HTML = '<!doctype html><title>app</title>';
const PNG_BYTES = [137, 80, 78, 71, 0, 255];

// The generated module is gitignored and absent from a clean checkout, so the
// handler is tested against a stand-in for it.
await mock.module('./frontend-assets.js', () => ({
  FRONTEND_ASSETS: {
    'index.html': { content: HTML, type: 'text/html' },
    'assets/app-abc123.js': { content: 'console.log(1)', type: 'application/javascript' },
    'sw.js': { content: 'self.skipWaiting()', type: 'application/javascript' },
    'icons/logo.png': {
      content: btoa(String.fromCharCode(...PNG_BYTES)),
      type: 'image/png',
      encoding: 'base64',
    },
  },
}));

const { serveFrontend } = await import('./frontend-handler.js');

let log: Mock<typeof console.log>;

beforeEach(() => {
  log = spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  log.mockRestore();
});

function serve(path: string) {
  return serveFrontend({ url: `https://sexy.itoken.world${path}` });
}

describe('serveFrontend', () => {
  test('serves index.html for the root with the HTML security headers', async () => {
    const response = serve('/');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(HTML);
    expect(response.headers.get('Content-Type')).toBe('text/html');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  test('serves a hashed asset as immutable and without the HTML headers', async () => {
    const response = serve('/assets/app-abc123.js');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('console.log(1)');
    expect(response.headers.get('Content-Type')).toBe('application/javascript');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('X-Content-Type-Options')).toBeNull();
    expect(response.headers.get('X-Frame-Options')).toBeNull();
  });

  test('revalidates files outside /assets/', async () => {
    const response = serve('/sw.js');

    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(await response.text()).toBe('self.skipWaiting()');
  });

  test('decodes a base64 asset to its bytes', async () => {
    const response = serve('/icons/logo.png');

    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(PNG_BYTES);
  });

  test('ignores the query string and a trailing slash', async () => {
    expect(await serve('/sw.js?v=2').text()).toBe('self.skipWaiting()');
    expect(await serve('/sw.js/').text()).toBe('self.skipWaiting()');
  });

  test('falls back to index.html for a client-side route', async () => {
    for (const path of ['/messages', '/settings/users', '/messages/']) {
      const response = serve(path);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(HTML);
      expect(response.headers.get('Content-Type')).toBe('text/html');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    }
  });

  test('answers 404 for a missing file with an extension', async () => {
    const response = serve('/assets/missing.js');

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
  });
});
