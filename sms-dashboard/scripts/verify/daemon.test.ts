import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { daemonClient } from './daemon.ts';

interface Seen {
  method: string;
  path: string;
  apiKey: string | null;
  sessionId: string | null;
  body: string;
}

const seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        apiKey: request.headers.get('x-api-key'),
        sessionId: request.headers.get('x-daemon-session-id'),
        body: await request.text(),
      });
      return Response.json({ success: true }, { status: 201 });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

describe('daemon control client', () => {
  test('posts a JSON body with the API key, and polls with GET and the session id', async () => {
    const daemon = daemonClient(`http://127.0.0.1:${String(server.port)}`, 'key-1');
    expect(await daemon('/api/control/messages', { body: { messages: [] } })).toEqual({
      status: 201,
      body: { success: true },
    });
    await daemon('/api/control/pending-sms', { sessionId: 'session-1' });
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/api/control/messages',
        apiKey: 'key-1',
        sessionId: null,
        body: '{"messages":[]}',
      },
      {
        method: 'GET',
        path: '/api/control/pending-sms',
        apiKey: 'key-1',
        sessionId: 'session-1',
        body: '',
      },
    ]);
  });
});
