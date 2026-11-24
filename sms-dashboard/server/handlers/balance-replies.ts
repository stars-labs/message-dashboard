import { nanoid } from 'nanoid';
import { parseBalanceSkillConfig } from '../../shared/balance-skill.js';
import type { CheckStatus } from '../../shared/balance-status.js';
import type { D1, D1Batch, D1Statement } from '../lib/d1.js';
import {
  listPendingChecksForReply,
  markBalanceCheckSmsResult,
  queueBalanceFollowUpMessage,
  recordBalanceReply,
  type BalanceCheckRow,
  type BalanceMessage,
  type FollowUpCheck,
} from '../db/balance-replies.js';
import {
  expectedSenderMatches,
  matchingNextStep,
  parseBalanceMetrics,
} from '../utils/balance-reply-parse.js';

/** The three send outcomes the daemon reports for an outbound SMS. */
export type SmsOutcome = 'confirmed' | 'submitted_unconfirmed' | 'failed';

/** A follow-up step: queued with its outbound message, or lost to a writer that got there first. */
type FollowUp = { queued: true; message_id: string } | { queued: false; message_id: null };

export async function findPendingBalanceCheck(
  db: D1<'all'>,
  {
    phone_iccid,
    phone_number,
    message_timestamp = new Date().toISOString(),
  }: { phone_iccid: string; phone_number: string; message_timestamp?: string },
): Promise<BalanceCheckRow | null> {
  if (!phone_iccid || !phone_number) return null;

  const candidates = await listPendingChecksForReply(db, { phone_iccid, message_timestamp });

  return (
    candidates.find((candidate) =>
      expectedSenderMatches(phone_number, candidate.expected_senders),
    ) ?? null
  );
}

export async function linkBalanceReply(
  db: D1<'run'> & D1Batch<'run'>,
  check: BalanceCheckRow,
  message: BalanceMessage,
  { mergedContent = null }: { mergedContent?: string | null } = {},
): Promise<FollowUp | { linked: boolean }> {
  const content = mergedContent ?? message.content;
  const nextStep = matchingNextStep(check, content);
  const responseWindowOpen = check.response_window_open === 1;
  if (nextStep && responseWindowOpen) {
    return queueBalanceFollowUp(db, check, message, nextStep, check.status);
  }

  const metrics = parseBalanceMetrics(check.parser_version, content);
  const skill = parseBalanceSkillConfig(check.skill_config);
  const skillJobId =
    !metrics.length && skill && responseWindowOpen && check.step_index < skill.max_turns
      ? `skill-${nanoid()}`
      : null;

  const linked = await recordBalanceReply(db, { check, message, content, metrics, skillJobId });
  return { linked };
}

export async function queueBalanceFollowUp(
  db: D1<'run'> & D1Batch<'run'>,
  check: FollowUpCheck,
  message: BalanceMessage,
  step: { command: string },
  fromStatus: CheckStatus,
  extraStatements: readonly D1Statement<'run'>[] = [],
): Promise<FollowUp> {
  const messageId = `msg-balance-${nanoid()}`;
  const queued = await queueBalanceFollowUpMessage(db, {
    messageId,
    check,
    message,
    step,
    fromStatus,
    extraStatements,
  });

  return queued ? { queued: true, message_id: messageId } : { queued: false, message_id: null };
}

export async function updateBalanceCheckForSmsResult(
  db: D1<'run'>,
  messageId: string,
  outcome: SmsOutcome,
  errorMessage: string | null = null,
): Promise<void> {
  const submitted = outcome === 'confirmed' || outcome === 'submitted_unconfirmed';
  const failure = errorMessage === null || errorMessage === '' ? 'SMS send failed' : errorMessage;
  await markBalanceCheckSmsResult(db, messageId, { submitted, failure });
}
