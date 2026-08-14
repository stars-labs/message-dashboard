import { describe, expect, test } from 'bun:test';
import { callCompanyAI, parseCompanyAIContent } from './company-ai.js';

describe('company AI client', () => {
  test('parses JSON content with or without a markdown fence', () => {
    expect(parseCompanyAIContent({
      choices: [{ message: { content: '```json\n{"action":"stop"}\n```' } }],
    })).toEqual({ action: 'stop' });
  });

  test('uses bearer auth and retries without response_format when unsupported', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) return new Response('unsupported', { status: 400 });
      return Response.json({
        choices: [{ message: { content: '{"action":"stop","confidence":1}' } }],
      });
    };
    const result = await callCompanyAI({
      baseUrl: 'https://internal.example/api/cc/',
      token: 'local-secret',
      model: 'company-model',
      prompt: { system: 'system', user: 'user' },
      protocol: 'openai',
      fetchImpl,
    });
    expect(result.action).toBe('stop');
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://internal.example/api/cc/v1/chat/completions');
    expect(calls[0].init.headers.Authorization).toBe('Bearer local-secret');
    expect(JSON.parse(calls[0].init.body).response_format).toEqual({ type: 'json_object' });
    expect(JSON.parse(calls[1].init.body).response_format).toBeUndefined();
  });

  test('uses the Anthropic Messages protocol required by the company gateway', async () => {
    const calls = [];
    const result = await callCompanyAI({
      baseUrl: 'https://internal.example/api/cc',
      token: 'local-secret',
      model: 'claude-sonnet-4-5',
      prompt: { system: 'system', user: 'user' },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return Response.json({
          content: [{ type: 'text', text: '{"action":"stop","confidence":1}' }],
        });
      },
    });
    expect(result.action).toBe('stop');
    expect(calls[0].url).toBe('https://internal.example/api/cc/v1/messages');
    expect(calls[0].init.headers['x-api-key']).toBe('local-secret');
    expect(calls[0].init.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(calls[0].init.body).system).toBe('system');
  });
});
