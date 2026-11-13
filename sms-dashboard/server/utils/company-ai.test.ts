import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import {
  callCompanyAI,
  CompanyAIProtocol,
  type CompanyAIFetch,
  type CompanyAIRequest,
} from './company-ai.js';

const prompt = { system: 'system', user: 'user' };

function recordingFetch(respond: (call: number) => Response) {
  const calls: { url: string; init: CompanyAIRequest }[] = [];
  const fetchImpl: CompanyAIFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(respond(calls.length));
  };
  return { calls, fetchImpl };
}

function answering(body: unknown): CompanyAIFetch {
  return recordingFetch(() => Response.json(body)).fetchImpl;
}

function call(fetchImpl: CompanyAIFetch) {
  return callCompanyAI({ baseUrl: 'https://x', token: 't', model: 'm', prompt, fetchImpl });
}

async function failureOf(pending: Promise<unknown>): Promise<string> {
  const error = await pending.then(
    () => null,
    (caught: unknown) => caught,
  );
  return error instanceof Error ? error.message : 'did not fail';
}

function bodyOf(init: CompanyAIRequest): Record<string, unknown> {
  const parsed = parseJson(init.body, v.record(v.string(), v.unknown()));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe('CompanyAIProtocol', () => {
  test('accepts the two gateway protocols and nothing else', () => {
    expect(v.is(CompanyAIProtocol, 'anthropic')).toBe(true);
    expect(v.is(CompanyAIProtocol, 'openai')).toBe(true);
    expect(v.is(CompanyAIProtocol, 'grpc')).toBe(false);
    expect(v.is(CompanyAIProtocol, undefined)).toBe(false);
  });
});

describe('company AI reply parsing', () => {
  test('parses JSON content with or without a markdown fence', async () => {
    expect(
      await call(
        answering({ choices: [{ message: { content: '```json\n{"action":"stop"}\n```' } }] }),
      ),
    ).toEqual({ action: 'stop' });
    expect(
      await call(answering({ choices: [{ message: { content: '{"action":"go"}' } }] })),
    ).toEqual({ action: 'go' });
  });

  test('joins chat content returned as text parts', async () => {
    expect(
      await call(
        answering({
          choices: [
            {
              message: {
                content: [
                  { type: 'text', text: '{"a":' },
                  { type: 'image_url' },
                  { type: 'text', text: '1}' },
                ],
              },
            },
          ],
        }),
      ),
    ).toEqual({ a: 1 });
  });

  test('reads the first text block of a Messages reply', async () => {
    expect(
      await call(
        answering({
          content: [
            { type: 'thinking' },
            { type: 'text', text: '{"b":2}' },
            { type: 'text', text: '{"ignored":true}' },
          ],
        }),
      ),
    ).toEqual({ b: 2 });
  });

  test('rejects a reply without message content', async () => {
    for (const body of [
      null,
      'text',
      {},
      { choices: [] },
      { content: [] },
      { content: [{ type: 'thinking' }] },
    ]) {
      expect(await failureOf(call(answering(body)))).toBe(
        'Company AI response does not contain message content',
      );
    }
  });

  test('rejects a reply that matches neither wire format', async () => {
    for (const body of [
      { choices: 'nope' },
      { choices: [{ message: { content: 7 } }] },
      { content: [{ type: 'text', text: 7 }] },
    ]) {
      expect(await failureOf(call(answering(body)))).toBe(
        'Company AI response does not contain message content',
      );
    }
  });

  test('rejects content that is not JSON', async () => {
    expect(
      await failureOf(call(answering({ choices: [{ message: { content: 'not json' } }] }))),
    ).toBe('Company AI response is not valid JSON');
  });

  test('rejects a response body that is not JSON', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('<html>', { status: 200 }));
    expect(await failureOf(call(fetchImpl))).toBe('Company AI response is not valid JSON');
  });
});

describe('company AI requests', () => {
  test('uses bearer auth and retries without response_format when unsupported', async () => {
    const { calls, fetchImpl } = recordingFetch((n) =>
      n === 1
        ? new Response('unsupported', { status: 400 })
        : Response.json({
            choices: [{ message: { content: '{"action":"stop","confidence":1}' } }],
          }),
    );
    const result = await callCompanyAI({
      baseUrl: 'https://internal.example/api/cc/',
      token: 'local-secret',
      model: 'company-model',
      prompt,
      protocol: 'openai',
      fetchImpl,
    });
    expect(result).toEqual({ action: 'stop', confidence: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://internal.example/api/cc/v1/chat/completions');
    expect(calls[0]?.init.headers['Authorization']).toBe('Bearer local-secret');
    expect(calls[0] && bodyOf(calls[0].init)['response_format']).toEqual({ type: 'json_object' });
    expect(calls[1] && bodyOf(calls[1].init)['response_format']).toBeUndefined();
  });

  test('also retries without response_format on a 422', async () => {
    const { calls, fetchImpl } = recordingFetch((n) =>
      n === 1
        ? new Response('unprocessable', { status: 422 })
        : Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }),
    );
    const result = await callCompanyAI({
      baseUrl: 'https://internal.example',
      token: 't',
      model: 'm',
      prompt,
      protocol: 'openai',
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  test('uses the Anthropic Messages protocol required by the company gateway', async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      Response.json({ content: [{ type: 'text', text: '{"action":"stop","confidence":1}' }] }),
    );
    const result = await callCompanyAI({
      baseUrl: 'https://internal.example/api/cc',
      token: 'local-secret',
      model: 'claude-sonnet-4-5',
      prompt,
      fetchImpl,
    });
    expect(result).toEqual({ action: 'stop', confidence: 1 });
    expect(calls[0]?.url).toBe('https://internal.example/api/cc/v1/messages');
    expect(calls[0]?.init.headers['x-api-key']).toBe('local-secret');
    expect(calls[0]?.init.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0] && bodyOf(calls[0].init)['system']).toBe('system');
  });

  test('reports a failed request with a bounded detail', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('x'.repeat(900), { status: 500 }));
    expect(await failureOf(call(fetchImpl))).toBe(
      `Company AI request failed (500): ${'x'.repeat(500)}`,
    );
  });
});
