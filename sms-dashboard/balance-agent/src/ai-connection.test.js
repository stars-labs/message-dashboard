import { describe, expect, test } from 'bun:test';
import { describeAIConnectionError, testAIConnection } from './ai-connection.js';

const complete = {
  aiBaseUrl: 'https://ai.example.com/api',
  aiModel: 'company-model',
  aiProtocol: 'openai',
  aiToken: 'secret',
};

describe('AI connection test', () => {
  test('requires every connection field', async () => {
    const result = await testAIConnection({ aiBaseUrl: complete.aiBaseUrl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('aiModel');
    expect(result.message).toContain('aiToken');
  });

  test('uses the production AI adapter contract', async () => {
    const calls = [];
    const ticks = [100, 142];
    const result = await testAIConnection(complete, {
      callAI: async (input) => {
        calls.push(input);
        return { ok: true };
      },
      now: () => ticks.shift(),
    });

    expect(result).toEqual({ ok: true, latencyMs: 42, message: '连接成功' });
    expect(calls[0]).toMatchObject({
      baseUrl: complete.aiBaseUrl,
      token: complete.aiToken,
      model: complete.aiModel,
      protocol: complete.aiProtocol,
    });
  });

  test('turns common failures into actionable messages', () => {
    expect(describeAIConnectionError(new Error('request failed (401)'))).toContain('token');
    expect(describeAIConnectionError(new Error('fetch failed'))).toContain('VPN');
    expect(describeAIConnectionError(new Error('response is not valid JSON'))).toContain('格式');
  });
});
