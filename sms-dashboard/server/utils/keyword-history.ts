import {
  insertMessageTags,
  listHistoryMessages,
  type KeywordHistoryRow,
  type MessageTagInsert,
} from '../db/keywords.js';
import type { D1, D1Batch } from '../lib/d1.js';
import { findKeywordMatches } from './keyword-match.js';
import type { HistoryCursor, KeywordHistoryPage } from '../../shared/api/history.js';

const KEYWORD_HISTORY_PAGE_SIZE = 200;

/** A keyword_tags row as history application reads it. */
export interface HistoryKeyword {
  id: number;
  keyword: string;
  case_sensitive: number | boolean;
  whole_word: number | boolean;
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
  db: D1<'all' | 'run'> & D1Batch<'all' | 'run'>,
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
  const results = await listHistoryMessages(db, conditions, params, limit + 1);

  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  const tags: MessageTagInsert[] = [];
  let eligible = 0;
  let matchedMessages = 0;

  for (const message of page) {
    if (
      message.type !== 'received' ||
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
      tags.push({
        message_id: message.id,
        keyword_tag_id: keyword.id,
        matched_text: match.text,
        position: match.position,
      });
    }
  }

  const inserted = await insertMessageTags(db, tags);

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
