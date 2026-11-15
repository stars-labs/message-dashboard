import { describe, expect, test } from 'bun:test';
import { callWorker } from '../test/worker-harness.js';

describe('the whole Worker, from a request to its response', () => {
  test('answers the liveness probe without touching the network', async () => {
    const { response, outbound } = await callWorker('GET', '/api/live');

    expect(response.status).toBe(200);
    expect(outbound).toEqual([]);
  });

  test('answers any request to an unknown API path with a problem 404', async () => {
    const answered = [];
    for (const [method, path] of [
      ['GET', '/api/no-such-route'],
      ['POST', '/api/no-such-route'],
      ['DELETE', '/api/users'],
      ['GET', '/api'],
    ] as const) {
      const { response } = await callWorker(method, path);
      answered.push({
        status: response.status,
        contentType: response.headers.get('Content-Type'),
        body: await response.json(),
      });
    }
    expect(answered).toEqual(
      ['GET /api/no-such-route', 'POST /api/no-such-route', 'DELETE /api/users', 'GET /api'].map(
        (route) => ({
          status: 404,
          contentType: 'application/problem+json',
          body: {
            type: 'about:blank',
            title: 'Not Found',
            status: 404,
            detail: `No route for ${route}`,
            code: 'NOT_FOUND',
          },
        }),
      ),
    );
  });

  test('still serves the app shell for a page outside the API', async () => {
    const { response } = await callWorker('GET', '/apis-are-pages-too');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
  });
});
