import { findKeywordMatches } from './keyword-match.js';
import type { D1Database } from '../cf-bindings.js';
import type { HistoryCursor } from './filter-history.js';

export const KEYWORD_HISTORY_PAGE_SIZE = 200;

/** A keyword_tags row as history application reads it. */
export interface HistoryKeyword {
  id: number;
  keyword: string;
  case_sensitive: number | boolean;
  whole_word: number | boolean;
}

/** One message row the page scans. */
interface KeywordHistoryRow {
  id: string;
  type?: string | null;
  content: string | null;
  filter_status: string | null;
  verification_code: string | null;
  created_at: string;
}

export interface KeywordHistoryPage {
  processed: number;
  eligible: number;
  matched_messages: number;
  inserted: number;
  has_more: boolean;
  next_cursor: HistoryCursor | null;
}

function cursorFor(row: KeywordHistoryRow): HistoryCursor {
  return { created_at: row.created_at, id: row.id };
}

/**
 * Apply one keyword to one bounded chronological page. The SQL deliberately does
 * not search message content: filtering before LIMIT could scan an unbounded
 * number of D1 rows. Eligibility and matching happen in memory after the read.
 */
export async function processKeywordHistoryPage(
  db: D1Database,
  keyword: HistoryKeyword,
  {
    since,
    until,
    cursor = null,
    pageSize = KEYWORD_HISTORY_PAGE_SIZE,
  }: {
    since: string;
    until: string;
    cursor?: HistoryCursor | null;
    pageSize?: unknown;
  },
): Promise<KeywordHistoryPage> {
  const conditions = [`purpose = 'user'`, `created_at >= datetime(?)`, `created_at <= datetime(?)`];
  const params: unknown[] = [since, until];

  if (cursor) {
    conditions.push('(created_at > ? OR (created_at = ? AND id > ?))');
    params.push(cursor.created_at, cursor.created_at, cursor.id);
  }

  const limit = Math.max(
    1,
    Math.min(Number(pageSize) || KEYWORD_HISTORY_PAGE_SIZE, KEYWORD_HISTORY_PAGE_SIZE),
  );
  const { results } = await db
    .prepare(
      `SELECT id, type, content, filter_status, verification_code, created_at
     FROM messages
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY created_at, id
     LIMIT ?`,
    )
    .bind(...params, limit + 1)
    .all<KeywordHistoryRow>();

  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  const statements = [];
  let eligible = 0;
  let matchedMessages = 0;

  for (const message of page) {
    if (
      (message.type !== undefined && message.type !== 'received') ||
      message.filter_status === 'filtered' ||
      message.verification_code
    )
      continue;

    eligible++;
    const matches = findKeywordMatches(
      message.content,
      keyword.keyword,
      Boolean(keyword.case_sensitive),
      Boolean(keyword.whole_word),
    );
    if (matches.length > 0) matchedMessages++;

    for (const match of matches) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO message_tags
           (message_id, keyword_tag_id, matched_text, position)
         VALUES (?, ?, ?, ?)`,
          )
          .bind(message.id, keyword.id, match.text, match.position),
      );
    }
  }

  const resultsForWrites =
    statements.length > 0 ? await db.batch<{ meta?: { changes?: number } }>(statements) : [];
  const inserted = resultsForWrites.reduce(
    (total, result) => total + Number(result?.meta?.changes || 0),
    0,
  );

  const last = page.at(-1);
  return {
    processed: page.length,
    eligible,
    matched_messages: matchedMessages,
    inserted,
    has_more: hasMore,
    next_cursor: hasMore && last ? cursorFor(last) : null,
  };
}
