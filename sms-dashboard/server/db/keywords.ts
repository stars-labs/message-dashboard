import * as v from 'valibot';
import { Keyword, KeywordWithUsage, MessageTag } from '../../shared/api/keywords.js';
import { queryAll, queryFirst, queryOne, type D1, type D1Batch } from '../lib/d1.js';

const KEYWORD_COLUMNS =
  'id, keyword, tag, color, priority, is_active, case_sensitive, whole_word, created_by, created_at, updated_at';

const KEYWORD_COLUMNS_OF_KT = KEYWORD_COLUMNS.split(', ')
  .map((column) => `kt.${column}`)
  .join(', ');

const IdRow = v.object({ id: v.number() });

const ReferencedRow = v.object({ referenced: v.number() });

const MatcherRow = v.object({
  id: v.number(),
  keyword: v.string(),
  case_sensitive: v.nullable(v.number()),
  whole_word: v.nullable(v.number()),
});

const BatchTagRow = v.object({
  message_id: v.string(),
  id: v.number(),
  keyword: v.string(),
  tag: v.string(),
  color: v.nullable(v.string()),
  priority: v.nullable(v.number()),
  position: v.number(),
  matched_text: v.string(),
  length: v.number(),
});

type BatchTagRow = v.InferOutput<typeof BatchTagRow>;

const KeywordHistoryRow = v.object({
  id: v.string(),
  type: v.nullable(v.string()),
  content: v.string(),
  filter_status: v.string(),
  verification_code: v.nullable(v.string()),
  created_at: v.string(),
});

export type KeywordHistoryRow = v.InferOutput<typeof KeywordHistoryRow>;

export interface MessageTagInsert {
  message_id: string;
  keyword_tag_id: number;
  matched_text: string;
  position: number;
}

interface NewKeyword {
  keyword: string;
  tag: string;
  color: string;
  priority: number;
  case_sensitive: boolean;
  whole_word: boolean;
  created_by: string | null;
}

interface KeywordChanges {
  tag: string;
  color: string;
  priority: number | null;
  is_active: number | boolean | null;
}

export function listKeywordsWithUsage(db: D1<'all'>): Promise<KeywordWithUsage[]> {
  return queryAll(
    db.prepare(
      `
                SELECT
                    ${KEYWORD_COLUMNS_OF_KT},
                    COUNT(DISTINCT mt.message_id) as usage_count
                FROM keyword_tags kt
                LEFT JOIN message_tags mt ON kt.id = mt.keyword_tag_id
                GROUP BY kt.id
                ORDER BY kt.priority DESC, kt.keyword ASC
            `,
    ),
    KeywordWithUsage,
  );
}

export function findKeywordWithUsage(
  db: D1<'first'>,
  id: string,
): Promise<KeywordWithUsage | null> {
  return queryFirst(
    db
      .prepare(
        `
                SELECT
                    ${KEYWORD_COLUMNS_OF_KT},
                    COUNT(DISTINCT mt.message_id) as usage_count
                FROM keyword_tags kt
                LEFT JOIN message_tags mt ON kt.id = mt.keyword_tag_id
                WHERE kt.id = ?
                GROUP BY kt.id
            `,
      )
      .bind(id),
    KeywordWithUsage,
  );
}

export function findActiveKeywordId(
  db: D1<'first'>,
  keyword: string,
): Promise<{ id: number } | null> {
  return queryFirst(
    db.prepare('SELECT id FROM keyword_tags WHERE keyword = ? AND is_active = TRUE').bind(keyword),
    IdRow,
  );
}

export async function insertKeyword(db: D1<'run'>, keyword: NewKeyword): Promise<number> {
  const result = await db
    .prepare(
      `
                INSERT INTO keyword_tags (
                    keyword, tag, color, priority, case_sensitive, whole_word, created_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
    )
    .bind(
      keyword.keyword,
      keyword.tag,
      keyword.color,
      keyword.priority,
      keyword.case_sensitive,
      keyword.whole_word,
      keyword.created_by,
    )
    .run();
  return result.meta.last_row_id;
}

export function getKeyword(db: D1<'first'>, id: number): Promise<Keyword> {
  return queryOne(
    db.prepare(`SELECT ${KEYWORD_COLUMNS} FROM keyword_tags WHERE id = ?`).bind(id),
    Keyword,
  );
}

export function findKeyword(db: D1<'first'>, id: string): Promise<Keyword | null> {
  return queryFirst(
    db.prepare(`SELECT ${KEYWORD_COLUMNS} FROM keyword_tags WHERE id = ?`).bind(id),
    Keyword,
  );
}

export function updateKeyword(
  db: D1<'first'>,
  id: string,
  changes: KeywordChanges,
): Promise<Keyword | null> {
  return queryFirst(
    db
      .prepare(
        `
                UPDATE keyword_tags
                SET tag = ?, color = ?, priority = ?, is_active = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                RETURNING ${KEYWORD_COLUMNS}
            `,
      )
      .bind(changes.tag, changes.color, changes.priority, changes.is_active, id),
    Keyword,
  );
}

export function findKeywordId(db: D1<'first'>, id: string): Promise<{ id: number } | null> {
  return queryFirst(db.prepare('SELECT id FROM keyword_tags WHERE id = ?').bind(id), IdRow);
}

export async function isKeywordReferenced(db: D1<'first'>, id: string): Promise<boolean> {
  const referenced = await queryFirst(
    db
      .prepare('SELECT 1 AS referenced FROM message_tags WHERE keyword_tag_id = ? LIMIT 1')
      .bind(id),
    ReferencedRow,
  );
  return referenced !== null;
}

export async function deleteKeyword(db: D1<'run'>, id: string): Promise<void> {
  await db.prepare('DELETE FROM keyword_tags WHERE id = ?').bind(id).run();
}

export function listActiveTagsForMessages(
  db: D1<'all'>,
  messageIds: string[],
): Promise<BatchTagRow[]> {
  const placeholders = messageIds.map(() => '?').join(',');
  return queryAll(
    db
      .prepare(
        `
                SELECT
                    mt.message_id,
                    kt.id,
                    kt.keyword,
                    kt.tag,
                    kt.color,
                    kt.priority,
                    mt.position,
                    mt.matched_text,
                    LENGTH(mt.matched_text) as length
                FROM message_tags mt
                JOIN keyword_tags kt ON mt.keyword_tag_id = kt.id
                WHERE mt.message_id IN (${placeholders})
                  AND kt.is_active = TRUE
                ORDER BY mt.message_id, mt.position ASC
            `,
      )
      .bind(...messageIds),
    BatchTagRow,
  );
}

export function listMessageTags(
  db: D1<'all'>,
  messageId: string,
): Promise<v.InferOutput<typeof MessageTag>[]> {
  return queryAll(
    db
      .prepare(
        `
                SELECT
                    mt.message_id,
                    mt.keyword_tag_id,
                    mt.matched_text,
                    mt.position,
                    mt.created_at,
                    kt.keyword,
                    kt.tag,
                    kt.color
                FROM message_tags mt
                JOIN keyword_tags kt ON mt.keyword_tag_id = kt.id
                WHERE mt.message_id = ? AND kt.is_active = TRUE
                ORDER BY mt.position ASC
            `,
      )
      .bind(messageId),
    MessageTag,
  );
}

export function listHistoryMessages(
  db: D1<'all'>,
  conditions: string[],
  params: unknown[],
  limit: number,
): Promise<KeywordHistoryRow[]> {
  return queryAll(
    db
      .prepare(
        `SELECT id, type, content, filter_status, verification_code, created_at
     FROM messages
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY created_at, id
     LIMIT ?`,
      )
      .bind(...params, limit),
    KeywordHistoryRow,
  );
}

export function listActiveKeywordMatchers(db: D1<'all'>) {
  return queryAll(
    db.prepare(
      `
      SELECT id, keyword, case_sensitive, whole_word
      FROM keyword_tags
      WHERE is_active = TRUE
      ORDER BY priority DESC
    `,
    ),
    MatcherRow,
  );
}

export async function insertKeywordMatches(
  db: D1<'run'>,
  matches: (readonly [string, number, string, number])[],
): Promise<void> {
  const placeholders = matches.map(() => '(?, ?, ?, ?)').join(',');
  await db
    .prepare(
      `
        INSERT OR IGNORE INTO message_tags (message_id, keyword_tag_id, matched_text, position)
        VALUES ${placeholders}
      `,
    )
    .bind(...matches.flat())
    .run();
}

export async function insertMessageTags(
  db: D1<'all' | 'run'> & D1Batch<'all' | 'run'>,
  tags: MessageTagInsert[],
): Promise<number> {
  if (tags.length === 0) return 0;
  const results = await db.batch(
    tags.map((tag) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO message_tags
           (message_id, keyword_tag_id, matched_text, position)
         VALUES (?, ?, ?, ?)`,
        )
        .bind(tag.message_id, tag.keyword_tag_id, tag.matched_text, tag.position),
    ),
  );
  return results.reduce((total, result) => total + result.meta.changes, 0);
}
