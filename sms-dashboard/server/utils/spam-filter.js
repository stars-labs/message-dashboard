// Spam/marketing SMS classification.
//
import { hasVerificationCode } from './verification.js';

const SHORT_CODE_COUNTRY_PREFIXES = ['86', '852'];

// This module is the ONLY place that decides whether a message is spam.
// Callers (ingest in handlers/control.js, backfill in api/filters.js) may use SQL
// to narrow down which rows are worth looking at, but the verdict always comes
// from classifyMessage() here. A SQL pre-filter that over-selects gets corrected;
// one that decides on its own would be a second, drifting definition.

/** Classification states stored in messages.filter_status. */
export const FILTER_STATUS = {
  /** Not classified yet. Doubles as the backfill cursor. */
  PENDING: 'pending',
  /** Judged legitimate — shown in the default message list. */
  CLEAN: 'clean',
  /** Judged spam/marketing — hidden unless ?include_filtered=1. */
  FILTERED: 'filtered',
};

/**
 * Statuses the default message list shows.
 *
 * Note this is "not filtered", not "clean": an unswept row must stay VISIBLE.
 * Requiring 'clean' would make every message vanish the moment migration 035
 * lands (it defaults all existing rows to 'pending') and only trickle back as
 * the backfill progressed — indistinguishable from data loss. Showing a message
 * that later turns out to be spam is the harmless direction.
 */
export const VISIBLE_FILTER_STATUSES = [FILTER_STATUS.CLEAN, FILTER_STATUS.PENDING];

/** Rule kinds allowed in filter_rules.rule_type. */
export const RULE_TYPE = {
  /** Substring match against the message body. */
  BODY_KEYWORD: 'body_keyword',
  /** Exact match against the sender's number. */
  SENDER: 'sender',
};

/**
 * Reduce a sender number to bare digits so '+8610086', '10086' and '100-86'
 * compare consistently.
 * @param {unknown} raw
 * @returns {string} digits only, or '' when there is nothing usable
 */
export function normalizeSender(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\D/g, '');
}

/**
 * Every way of writing the same sender: the bare digits, plus the digits with a
 * known country code stripped, so '+8610086' and '10086' reduce alike.
 */
function senderCandidates(digits) {
  const candidates = [digits];
  for (const prefix of SHORT_CODE_COUNTRY_PREFIXES) {
    if (digits.startsWith(prefix)) candidates.push(digits.slice(prefix.length));
  }
  return candidates;
}

/**
 * Match a sender EXACTLY, after punctuation/country-code normalization, while also
 * supporting exact case-insensitive alphanumeric sender IDs such as "M1 Limited".
 *
 * This is the strict form, used to decide whether an inbound SMS is a trustworthy
 * balance reply (handlers/balance-queries.js, handlers/carrier-web-balance.js).
 * Balance correlation must not accept 10086100 for a '10086' profile: a
 * campaign-suffixed sender is a different origin, and reading a balance out of it
 * would attribute one carrier's marketing text to a real account. Spam rules want
 * the looser senderMatchesSpamRule() below instead.
 */
export function senderMatches(rawSender, rawPattern) {
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
 * Match a sender against a spam RULE pattern: the shortcode itself, or any
 * campaign-suffixed variant of it.
 *
 * Carriers send each marketing blast from a different extension of their
 * shortcode — one survey arrives from 100860011575, the next from 10086123456 —
 * so an exact rule silently misses all of them and only the bare shortcode is
 * ever filtered.
 *
 * The suffix has to EXTEND the shortcode. A pattern that merely appears somewhere
 * inside the number does not match, which keeps a real mobile number such as
 * 13910086 (ends with) or 13100862222 (contains) visible. No Chinese mobile
 * number starts with a carrier shortcode, so anchoring at the front is the
 * property that makes prefix matching safe here where endsWith() was not.
 *
 * Alphanumeric sender IDs stay exact: 'M1 Limited' must not filter
 * 'M1 Limited Promo', which is a distinct sender rather than one campaign of the
 * same one.
 */
export function senderMatchesSpamRule(rawSender, rawPattern) {
  if (typeof rawSender !== 'string' || typeof rawPattern !== 'string') return false;

  const sender = rawSender.trim();
  const pattern = rawPattern.trim();
  if (!sender || !pattern) return false;

  if (/^\d+$/.test(pattern)) {
    return senderCandidates(normalizeSender(sender)).some((c) => c.startsWith(pattern));
  }

  return senderMatches(sender, pattern);
}

function clean() {
  return { filter_status: FILTER_STATUS.CLEAN, filter_rule_id: null };
}

/**
 * Decide whether a single message is spam.
 *
 * Received messages carry the SENDER's number in `phone_number` — the `sender`
 * column is never populated by the daemon upload path, so it is not consulted.
 *
 * @param {{type?: string, content?: unknown, phone_number?: unknown}} message
 * @param {Array<{id: number, rule_type: string, pattern: string}>} rules
 *   Active rules, ascending by id. Evaluation stops at the first hit, so the
 *   order determines which rule gets recorded as the reason.
 * @returns {{filter_status: string, filter_rule_id: number|null}}
 */
export function classifyMessage(message, rules) {
  if (!message) return clean();

  // Our own outbound SMS is never hidden, whatever it says.
  if (message.type === 'sent') return clean();

  if (!Array.isArray(rules) || rules.length === 0) return clean();

  const content = typeof message.content === 'string' ? message.content : '';

  // OTP safety guard, and the whole point of the dashboard: a message that
  // explicitly announces a verification code outranks every rule.
  //
  // Without this, the '10010' sender rule would hide 14 genuine 网上营业厅 login
  // codes along with the 2,850 marketing messages from the same shortcode.
  // Only high-confidence codes count. The same detector also populates the
  // verification_code column, so filtering and the 验证码 view cannot disagree.
  if (hasVerificationCode(content)) return clean();
  for (const rule of rules) {
    if (!rule || !rule.pattern) continue;

    if (rule.rule_type === RULE_TYPE.BODY_KEYWORD) {
      if (content.includes(rule.pattern)) {
        return { filter_status: FILTER_STATUS.FILTERED, filter_rule_id: rule.id };
      }
      continue;
    }

    if (rule.rule_type === RULE_TYPE.SENDER) {
      // Shortcode prefix match, so one rule covers every campaign extension.
      // Still anchored at the front: endsWith() or a substring test would wrongly
      // filter a real mobile number such as 13910086 under a '10086' rule.
      if (senderMatchesSpamRule(message.phone_number, rule.pattern)) {
        return { filter_status: FILTER_STATUS.FILTERED, filter_rule_id: rule.id };
      }
      continue;
    }

    // Unknown rule_type: ignore it rather than throwing, so one bad row can't
    // stop the whole upload batch from being classified.
  }

  return clean();
}

/**
 * Load the active rules in evaluation order. The single read path for rules.
 * @param {D1Database} db
 * @returns {Promise<Array<{id: number, rule_type: string, pattern: string}>>}
 */
export async function loadActiveRules(db) {
  const { results } = await db
    .prepare(
      `SELECT id, rule_type, pattern
       FROM filter_rules
       WHERE is_active = 1
       ORDER BY id`
    )
    .all();
  return results || [];
}
