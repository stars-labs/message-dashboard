// A local stand-in for the company AI gateway the Balance Agent's sms-ai
// capability calls (balance-agent/src/runner/company-ai.ts), in both wire formats.
// Journeys queue the decisions it returns; with none queued it gives the
// connection checks' answer, which no balance job accepts as a decision.
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.ts';

/** Satisfies ai-connection.ts ({ ok: true }) and the sms-ai capability ({ status: 'ok' }). */
const CONNECTION_CHECK_ANSWER = { ok: true, status: 'ok' };

const Prompt = v.object({
  messages: v.array(v.object({ role: v.string(), content: v.string() })),
});

export interface FakeAI {
  baseUrl: string;
  /** The only token it accepts: as `x-api-key`, or as a Bearer token for chat completions. */
  token: string;
  /** The user prompt of every authorized request, in order. */
  prompts: string[];
  answer(decision: unknown): void;
  stop(): Promise<void>;
}

export function startFakeAI(): FakeAI {
  const token = `e2e-ai-${crypto.randomUUID()}`;
  const queued: unknown[] = [];
  const prompts: string[] = [];

  function presented(request: Request, path: string): string | null {
    if (path === '/v1/messages') return request.headers.get('x-api-key');
    return /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1] ?? null;
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== 'POST' || !['/v1/messages', '/v1/chat/completions'].includes(path)) {
        return new Response('not found', { status: 404 });
      }
      if (presented(request, path) !== token) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const prompt = parseJson(await request.text(), Prompt);
      if (!prompt.ok) return Response.json({ error: prompt.error }, { status: 400 });
      prompts.push(prompt.value.messages.findLast((m) => m.role === 'user')?.content ?? '');

      const text = JSON.stringify(queued.length > 0 ? queued.shift() : CONNECTION_CHECK_ANSWER);
      return path === '/v1/messages'
        ? Response.json({ content: [{ type: 'text', text }] })
        : Response.json({ choices: [{ message: { role: 'assistant', content: text } }] });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${String(server.port)}`,
    token,
    prompts,
    answer(decision) {
      queued.push(decision);
    },
    stop: () => server.stop(true),
  };
}
