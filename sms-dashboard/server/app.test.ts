import { describe, expect, test } from 'bun:test';
import { callWorker } from '../test/worker-harness.js';

describe('the whole Worker, from a request to its response', () => {
  test('answers the liveness probe without touching the network', async () => {
    const { response, outbound } = await callWorker('GET', '/api/live');

    expect(response.status).toBe(200);
    expect(outbound).toEqual([]);
  });

  test('answers a non-GET request to an unknown API path with a JSON 404', async () => {
    const { response } = await callWorker('POST', '/api/no-such-route');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not Found' });
  });

  // Current behaviour, not intent: the `GET *` frontend fallback is registered
  // before the 404 branch runs, so a mistyped API path gets HTML. The contract
  // router answers /api itself (GRA-63); this test changes with it.
  test('serves the app shell for a GET to an unknown API path', async () => {
    const { response } = await callWorker('GET', '/api/no-such-route');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
  });
});
