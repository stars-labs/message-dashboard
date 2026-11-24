import { RULE_TYPE } from '../../shared/api/filters.js';
import { listActiveSpamRules, type SpamRule } from '../db/filters.js';
import type { D1 } from '../lib/d1.js';
import { hasVerificationCode } from './verification.js';

const SHORT_CODE_COUNTRY_PREFIXES = ['86', '852'];

/** Classification states stored in messages.filter_status. */
export const FILTER_STATUS = {
  /** Not classified yet. Doubles as the backfill cursor. */
  PENDING: 'pending',
  CLEAN: 'clean',
  FILTERED: 'filtered',
} as const;

type FilterStatus = (typeof FILTER_STATUS)[keyof typeof FILTER_STATUS];

/** "Not filtered", not "clean": unswept rows must stay visible until the backfill reaches them. */
export const VISIBLE_FILTER_STATUSES: FilterStatus[] = [FILTER_STATUS.CLEAN, FILTER_STATUS.PENDING];

export type { SpamRule };

interface Classification {
  filter_status: FilterStatus;
  filter_rule_id: number | null;
}

export interface ClassifiableMessage {
  type?: unknown;
  content?: unknown;
  phone_number?: unknown;
}

export function normalizeSender(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\D/g, '');
}

function senderCandidates(digits: string): string[] {
  const candidates = [digits];
  for (const prefix of SHORT_CODE_COUNTRY_PREFIXES) {
    if (digits.startsWith(prefix)) candidates.push(digits.slice(prefix.length));
  }
  return candidates;
}

/**
 * Strict sender match, used to trust a balance reply: 10086100 must not match a
 * '10086' profile, or a campaign text would be read as a balance. Spam rules use
 * senderMatchesSpamRule() instead.
 */
export function senderMatches(rawSender: unknown, rawPattern: unknown): boolean {
  if (typeof rawSender !== 'string' || typeof rawPattern !== 'string') return false;

  const sender = rawSender.trim();
  const pattern = rawPattern.trim();
  if (!sender || !pattern) return false;

  if (/^\d+$/.test(pattern)) {
    return senderCandidates(normalizeSender(sender)).some((c) => c === pattern);
  }

  return sender.localeCompare(pattern, undefined, { sensitivity: 'accent' }) === 0;
}

/**
 * Matches the shortcode or any campaign extension of it (carriers send each blast
 * from a different suffix, e.g. 100860011575). Anchored at the front so real
 * mobile numbers such as 13910086 stay visible; alphanumeric IDs stay exact.
 */
export function senderMatchesSpamRule(rawSender: unknown, rawPattern: unknown): boolean {
  if (typeof rawSender !== 'string' || typeof rawPattern !== 'string') return false;

  const sender = rawSender.trim();
  const pattern = rawPattern.trim();
  if (!sender || !pattern) return false;

  if (/^\d+$/.test(pattern)) {
    return senderCandidates(normalizeSender(sender)).some((c) => c.startsWith(pattern));
  }

  return senderMatches(sender, pattern);
}

function clean(): Classification {
  return { filter_status: FILTER_STATUS.CLEAN, filter_rule_id: null };
}

function filtered(ruleId: number): Classification {
  return { filter_status: FILTER_STATUS.FILTERED, filter_rule_id: ruleId };
}

/**
 * The only place that decides whether a message is spam; SQL pre-filters may only
 * narrow candidates. Received messages carry the sender in `phone_number`.
 * Rules are passed ascending by id and the first hit is recorded as the reason.
 */
export function classifyMessage(
  message: ClassifiableMessage | null | undefined,
  rules: SpamRule[] | null | undefined,
): Classification {
  if (!message) return clean();

  if (message.type === 'sent') return clean();

  if (!Array.isArray(rules) || rules.length === 0) return clean();

  const content = typeof message.content === 'string' ? message.content : '';

  // A verification code outranks every rule, or a sender rule such as '10010'
  // would hide genuine login codes. Same detector as the verification_code column.
  if (hasVerificationCode(content)) return clean();
  for (const rule of rules) {
    if (!rule.pattern) continue;

    switch (rule.rule_type) {
      case RULE_TYPE.BODY_KEYWORD:
        if (content.includes(rule.pattern)) return filtered(rule.id);
        break;
      case RULE_TYPE.SENDER:
        if (senderMatchesSpamRule(message.phone_number, rule.pattern)) return filtered(rule.id);
        break;
    }
  }

  return clean();
}

export function loadActiveRules(db: D1<'all'>): Promise<SpamRule[]> {
  return listActiveSpamRules(db);
}
