import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import {
  callCompanyAI,
  parseCompanyAIContent,
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

async function failureOf(call: Promise<unknown>): Promise<string> {
  const error = await call.then(
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

describe('company AI client', () => {
  test('parses JSON content with or without a markdown fence', () => {
    expect(
      parseCompanyAIContent({
        choices: [{ message: { content: '```json\n{"action":"stop"}\n```' } }],
      }),
    ).toEqual({ action: 'stop' });
    expect(
      parseCompanyAIContent({ choices: [{ message: { content: '{"action":"go"}' } }] }),
    ).toEqual({ action: 'go' });
  });

  test('joins content parts returned as an array', () => {
    expect(
      parseCompanyAIContent({
        choices: [
          { message: { content: [{ text: '{"a":' }, null, { text: 1 }, { text: '}' }, {}] } },
        ],
      }),
    ).toEqual({ a: 1 });
  });

  test('rejects a body without message content', () => {
    for (const payload of [null, undefined, 'text', {}, { choices: [] }, { content: [] }]) {
      expect(() => parseCompanyAIContent(payload)).toThrow('does not contain message content');
    }
  });

  test('rejects a body that does not match the response schema', () => {
    expect(() => parseCompanyAIContent({ choices: 'nope', content: 7 })).toThrow(
      'does not contain message content',
    );
  });

  test('rejects content that is not JSON', () => {
    expect(() =>
      parseCompanyAIContent({ choices: [{ message: { content: 'not json' } }] }),
    ).toThrow('not valid JSON');
  });

  test('uses bearer auth and retries without response_format when unsupported', async () => {
    const { calls, fetchImpl } = recordingFetch((call) =>
      call === 1
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
    const { calls, fetchImpl } = recordingFetch((call) =>
      call === 1
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

  test('rejects an unsupported protocol without calling the gateway', async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response('{}'));
    expect(
      await failureOf(
        callCompanyAI({
          baseUrl: 'https://x',
          token: 't',
          model: 'm',
          prompt,
          protocol: 'grpc',
          fetchImpl,
        }),
      ),
    ).toBe('Unsupported company AI protocol: grpc');
    expect(calls).toHaveLength(0);
  });

  test('reports a failed request with a bounded detail', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('x'.repeat(900), { status: 500 }));
    const error = await callCompanyAI({
      baseUrl: 'https://x',
      token: 't',
      model: 'm',
      prompt,
      fetchImpl,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error && error.message).toBe(
      `Company AI request failed (500): ${'x'.repeat(500)}`,
    );
  });

  test('rejects a response body that is not JSON', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('<html>', { status: 200 }));
    expect(
      await failureOf(
        callCompanyAI({ baseUrl: 'https://x', token: 't', model: 'm', prompt, fetchImpl }),
      ),
    ).toBe('Company AI response is not valid JSON');
  });

  test('rejects a response body that does not match the response schema', async () => {
    const { fetchImpl } = recordingFetch(() => Response.json({ choices: 'nope' }));
    expect(
      await failureOf(
        callCompanyAI({ baseUrl: 'https://x', token: 't', model: 'm', prompt, fetchImpl }),
      ),
    ).toBe('Company AI response does not contain message content');
  });
});
