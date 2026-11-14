import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { parseJson } from '../../../../shared/parse-json.js';
import { createSmsAiCapability } from './sms-ai.js';

const skill = {
  id: 'cash-balance',
  version: '1',
  objective: 'Obtain cash balance',
  confidence_threshold: 0.85,
  max_turns: 4,
  allowed_currencies: ['CNY'],
  forbidden_intents: ['充值', '办理'],
};

interface RecordedRequest {
  path: string;
  options: { body?: string | undefined };
}

type CallAI = Parameters<typeof createSmsAiCapability>[0]['callAI'];

function createHarness({
  content,
  callAI = () => Promise.reject(new Error('AI must not run')),
}: {
  content: string;
  callAI?: CallAI;
}) {
  const requests: RecordedRequest[] = [];
  const states: unknown[][] = [];
  const errors: string[] = [];
  const responses = [
    new Response(
      JSON.stringify({
        id: 'job-1',
        check_id: 'check-1',
        step_index: 1,
        attempts: 1,
        response_content: content,
        menu_options: [
          { value: '0', label: '业务查询与退订' },
          { value: '1', label: '话费与AI豆' },
        ],
        skill,
      }),
    ),
    new Response(JSON.stringify({ success: true })),
  ];
  const capability = createSmsAiCapability({
    controlClient: {
      request: (path, options = {}) => {
        requests.push({ path, options });
        return Promise.resolve(responses.shift() ?? new Response(null, { status: 500 }));
      },
    },
    presence: {
      set: (...state) => {
        states.push(state);
        return Promise.resolve();
      },
    },
    runnerId: 'session-1',
    aiBaseUrl: 'https://ai.example',
    aiToken: 'not-observed',
    aiModel: 'model',
    callAI,
    isAIReachable: () => Promise.resolve(true),
    logger: {
      log: () => undefined,
      error(message) {
        errors.push(message);
      },
    },
  });
  return { capability, requests, states, errors };
}

const SubmittedDecision = v.object({
  decision: v.object({ action: v.string(), selected_option: v.nullable(v.string()) }),
});

function submittedBody(
  request: RecordedRequest | undefined,
): v.InferOutput<typeof SubmittedDecision> {
  const parsed = parseJson(request?.options.body ?? '', SubmittedDecision);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const PromptBody = v.object({ menu_options: v.array(v.unknown()) });

describe('SMS AI capability', () => {
  test('uses an explicit safe balance instruction without calling AI', async () => {
    const harness = createHarness({ content: '查询余额请发送 102 至 10001。' });
    const result = await harness.capability.runOne();

    expect(result).toEqual({ handled: true, retryDelay: 0 });
    const submitted = submittedBody(harness.requests[1]);
    expect(submitted.decision.action).toBe('reply');
    expect(submitted.decision.selected_option).toBe('102');
    expect(harness.states).toEqual([['busy', 'job-1'], ['ready']]);
  });

  test('uses AI for a carrier menu and validates the result before submission', async () => {
    let prompts = 0;
    const harness = createHarness({
      content: '请回复数字：\n0.业务查询与退订\n1.话费与AI豆',
      callAI: ({ prompt }) => {
        prompts += 1;
        const prompted = parseJson(prompt.user, PromptBody);
        expect(prompted.ok && prompted.value.menu_options.length).toBe(2);
        return Promise.resolve({
          action: 'reply',
          selected_option: '1',
          balance: null,
          currency: null,
          confidence: 0.96,
          reason: '话费查询',
          evidence: '1.话费与AI豆',
        });
      },
    });

    await harness.capability.runOne();
    expect(prompts).toBe(1);
    const decisionRequest = harness.requests.find(({ path }) => path.endsWith('/decision'));
    expect(harness.errors).toEqual([]);
    expect(submittedBody(decisionRequest).decision.selected_option).toBe('1');
  });
});
