import * as v from 'valibot';
import { parseJson, type Schema } from '../../shared/parse-json.js';
import type { BalanceMetric } from '../../shared/api/balance-checks.js';
import { senderMatches } from './spam-filter.js';

const ConversationStep = v.object({ command: v.string(), response_contains: v.string() });
const AttemptedStep = v.object({ command: v.string() });

/**
 * The cash balance patterns of each SMS parser, in order of preference.
 * China Telecom reports both 当前号码总余额 (total account balance) and
 * 当前可用余额 (available balance); 总余额 includes prepaid amounts and is the
 * canonical figure the Telecom app shows. 当前号码通用余额 is the older format
 * that omits 总余额.
 */
const CASH_BALANCE_PATTERNS = new Map<string, readonly RegExp[]>([
  [
    'cn-telecom-balance-v1',
    [
      /当前号码总余额(?:为|是)?[：:\s]*([0-9]+(?:\.[0-9]{1,2})?)\s*元/,
      /(?:当前可用余额|当前号码通用余额)(?:为|是)?[：:\s]*([0-9]+(?:\.[0-9]{1,2})?)\s*元/,
    ],
  ],
  [
    'cn-mobile-balance-v1',
    [/(?:账户|话费|可用)?余额(?:为|是)?[：:\s]*([0-9]+(?:\.[0-9]{1,2})?)\s*元/],
  ],
]);

/** The conversation step at `index`, if it exists and has the shape `schema` requires. */
function stepAt<T>(conversationSteps: string, index: number, schema: Schema<T>): T | null {
  const steps = parseJson(conversationSteps, v.array(v.unknown()));
  if (!steps.ok) return null;
  const step = v.safeParse(schema, steps.value[index]);
  return step.success ? step.output : null;
}

export function matchingNextStep(
  check: { conversation_steps: string; step_index: number },
  content: string,
): { command: string } | null {
  const step = stepAt(check.conversation_steps, check.step_index, ConversationStep);
  return step && content.includes(step.response_contains) ? step : null;
}

export function attemptedStep(check: {
  conversation_steps: string;
  step_index: number;
}): { command: string } | null {
  const stepIndex = check.step_index - 1;
  return stepIndex < 0 ? null : stepAt(check.conversation_steps, stepIndex, AttemptedStep);
}

export function parseBalanceMetrics(parserVersion: string, content: string): BalanceMetric[] {
  for (const pattern of CASH_BALANCE_PATTERNS.get(parserVersion) ?? []) {
    const amount = pattern.exec(content)?.[1];
    if (amount !== undefined) {
      return [
        {
          metric_type: 'cash_balance',
          value: Number(amount),
          unit: null,
          currency: 'CNY',
          expires_at: null,
        },
      ];
    }
  }
  return [];
}

export function expectedSenderMatches(rawSender: string, expectedSendersJson: string): boolean {
  const expected = parseJson(expectedSendersJson, v.array(v.unknown()));
  return expected.ok && expected.value.some((sender) => senderMatches(rawSender, sender));
}

/** The fields of a message the daemon uploads that multipart grouping reads. */
interface UploadedPart {
  id?: unknown;
  content?: unknown;
  phone_iccid?: unknown;
  phone_number?: unknown;
  timestamp?: unknown;
}

function keyPart(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

// In text mode the daemon cannot read the concatenation header, so each part of a
// carrier reply is uploaded as its own message; the parts share sender and arrival
// timestamp. Without grouping, the first part processed finalizes the check on a
// fragment and a balance in a later part is never parsed. Parts carry no sequence
// number, so batch order is the only ordering available.
export function mergeMultipartReplies(
  messages: readonly UploadedPart[],
): Map<string, { key: string; content: string }> {
  const groups = new Map<string, { id: string; content: string }[]>();
  for (const message of messages) {
    const id = keyPart(message.id);
    const content = keyPart(message.content);
    if (!id || !content) continue;
    const key = [
      keyPart(message.phone_iccid),
      keyPart(message.phone_number),
      keyPart(message.timestamp),
    ].join('\0');
    const entry = { id, content };
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }

  const merged = new Map<string, { key: string; content: string }>();
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const content = group.map((message) => message.content).join('');
    for (const message of group) merged.set(message.id, { key, content });
  }
  return merged;
}
