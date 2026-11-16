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
    const calls: unknown[] = [];
    const ticks = [100, 142];
    const result = await testAIConnection(complete, {
      callAI: (input) => {
        calls.push(input);
        return Promise.resolve({ ok: true });
      },
      now: () => ticks.shift() ?? 0,
    });

    expect(result).toEqual({ ok: true, latencyMs: 42, message: '连接成功' });
    expect(calls[0]).toMatchObject({
      baseUrl: complete.aiBaseUrl,
      token: complete.aiToken,
      model: complete.aiModel,
      protocol: complete.aiProtocol,
    });
  });

  test('rejects a protocol the gateway does not speak before calling it', async () => {
    let called = false;
    const result = await testAIConnection(
      { ...complete, aiProtocol: 'gemini' },
      {
        callAI: () => {
          called = true;
          return Promise.resolve({ ok: true });
        },
      },
    );
    expect(result).toEqual({ ok: false, message: 'AI 协议必须是 anthropic 或 openai' });
    expect(called).toBe(false);
  });

  test('reports a reply that is not the expected check object', async () => {
    const result = await testAIConnection(complete, {
      callAI: () => Promise.resolve({ ok: false }),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    expect(result).toEqual({ ok: false, message: 'AI 已响应，但测试结果不符合预期' });
  });

  test('turns common failures into actionable messages', () => {
    expect(describeAIConnectionError(new Error('request failed (401)'))).toContain('token');
    expect(describeAIConnectionError(new Error('fetch failed'))).toContain('VPN');
    expect(describeAIConnectionError(new Error('response is not valid JSON'))).toContain('格式');
  });

  test('surfaces API error body in 401 message', () => {
    const err = new Error(
      'Company AI request failed (401): {"error":"invalid_api_key","message":"API key does not exist"}',
    );
    const msg = describeAIConnectionError(err);
    expect(msg).toContain('认证失败');
    expect(msg).toContain('invalid_api_key');
  });

  test('surfaces API error body in 403 message (e.g. model not provisioned)', () => {
    const err = new Error('Company AI request failed (403): {"detail":"Model not found"}');
    const msg = describeAIConnectionError(err);
    expect(msg).toContain('权限不足');
    expect(msg).toContain('Model not found');
  });
});
