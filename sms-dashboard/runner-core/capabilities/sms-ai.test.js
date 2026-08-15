import { describe, expect, test } from 'bun:test';
import { createSmsAiCapability } from './sms-ai.js';

const skill = {
  objective: 'Obtain cash balance',
  confidence_threshold: 0.85,
  max_turns: 4,
  allowed_currencies: ['CNY'],
  forbidden_intents: ['充值', '办理'],
};

function createHarness({ content, callAI = async () => { throw new Error('AI must not run'); } }) {
  const requests = [];
  const states = [];
  const errors = [];
  const responses = [
    new Response(JSON.stringify({
      id: 'job-1',
      check_id: 'check-1',
      response_content: content,
      menu_options: [
        { value: '0', label: '业务查询与退订' },
        { value: '1', label: '话费与AI豆' },
      ],
      skill,
    })),
    new Response(JSON.stringify({ success: true })),
  ];
  const capability = createSmsAiCapability({
    controlClient: {
      request: async (path, options = {}) => {
        requests.push({ path, options });
        return responses.shift();
      },
    },
    presence: { set: async (...state) => states.push(state) },
    runnerId: 'session-1',
    aiBaseUrl: 'https://ai.example',
    aiToken: 'not-observed',
    aiModel: 'model',
    callAI,
    isAIReachable: async () => true,
    logger: { log() {}, error(message) { errors.push(message); } },
  });
  return { capability, requests, states, errors };
}

describe('SMS AI capability', () => {
  test('uses an explicit safe balance instruction without calling AI', async () => {
    const harness = createHarness({ content: '查询余额请发送 102 至 10001。' });
    const result = await harness.capability.runOne();

    expect(result).toEqual({ handled: true, retryDelay: 0 });
    const submitted = JSON.parse(harness.requests[1].options.body);
    expect(submitted.decision.action).toBe('reply');
    expect(submitted.decision.selected_option).toBe('102');
    expect(harness.states).toEqual([['ready'], ['busy', 'job-1'], ['ready']]);
  });

  test('uses AI for a carrier menu and validates the result before submission', async () => {
    let prompts = 0;
    const harness = createHarness({
      content: '请回复数字：\n0.业务查询与退订\n1.话费与AI豆',
      callAI: async ({ prompt }) => {
        prompts += 1;
        expect(JSON.parse(prompt.user).menu_options.length).toBe(2);
        return {
          action: 'reply', selected_option: '1', balance: null, currency: null,
          confidence: 0.96, reason: '话费查询', evidence: '1.话费与AI豆',
        };
      },
    });

    await harness.capability.runOne();
    expect(prompts).toBe(1);
    const decisionRequest = harness.requests.find(({ path }) => path.endsWith('/decision'));
    expect(harness.errors).toEqual([]);
    expect(JSON.parse(decisionRequest.options.body).decision.selected_option).toBe('1');
  });
});
