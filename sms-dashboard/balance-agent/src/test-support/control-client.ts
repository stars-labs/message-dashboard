import * as v from 'valibot';
import { parseJson } from '../../../shared/parse-json.js';
import { createControlClient, type ControlClient } from '../runner/control-client.js';

export interface Sent {
  method: string;
  path: string;
  body: unknown;
}

export function fakeControlClient(answer: (sent: Sent) => Response | Promise<Response>): {
  client: ControlClient;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const client = createControlClient({
    baseUrl: 'https://worker.test',
    apiKey: 'test-key',
    fetchImpl: (url, init) => {
      const target = new URL(url);
      const text = typeof init.body === 'string' ? init.body : undefined;
      const body = text === undefined ? undefined : parseJson(text, v.unknown());
      if (body && !body.ok) throw new Error(body.error);
      const request = {
        method: init.method ?? 'GET',
        path: `${target.pathname}${target.search}`,
        body: body?.value,
      };
      sent.push(request);
      return Promise.resolve(answer(request));
    },
  });
  return { client, sent };
}

export function jsonAnswer(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
