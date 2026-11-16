import { ORPCError } from '@orpc/server';
import * as v from 'valibot';
import type { HistoryRequestBody, KeywordHistoryPage } from '../../shared/api/history.js';
import {
  Keyword,
  KeywordWithUsage,
  MessageTag,
  type BatchTagsBody,
  type BatchTagsResponse,
  type CreateKeywordBody,
  type KeywordResponse,
  type KeywordsResponse,
  type MessageTagsResponse,
  type UpdateKeywordBody,
} from '../../shared/api/keywords.js';
import type { SuccessResponse } from '../../shared/api/success.js';
import { errorText } from '../../shared/error-text.js';
import { DEFAULT_KEYWORD_COLOR, normalizeKeywordColor } from '../../shared/keyword-color.js';
import { queryAll, queryFirst, queryOne, type D1, type D1Batch } from '../lib/d1.js';
import { processKeywordHistoryPage } from '../utils/keyword-history.js';

const MAX_BATCH_MESSAGES = 100;

const IMMUTABLE_MESSAGE =
  'Keyword and matching options are immutable; create a new keyword instead';

interface KeywordsCall {
  env: { DB: D1 & D1Batch };
  user?: { id: string } | undefined;
}

/**
 * Answers `error`: a refusal a handler chose stands; anything
 * else is logged and answered as `message`.
 */
function fail(error: unknown, label: string, message: string): never {
  if (error instanceof ORPCError) throw error;
  console.error(`${label}:`, error);
  throw new ORPCError('INTERNAL_SERVER_ERROR', { message });
}

function notFound(): ORPCError<'NOT_FOUND', unknown> {
  return new ORPCError('NOT_FOUND', { message: 'Keyword not found' });
}

const KEYWORD_COLUMNS =
  'id, keyword, tag, color, priority, is_active, case_sensitive, whole_word, created_by, created_at, updated_at';

const KEYWORD_COLUMNS_OF_KT = KEYWORD_COLUMNS.split(', ')
  .map((column) => `kt.${column}`)
  .join(', ');

const IdRow = v.object({ id: v.number() });

const ReferencedRow = v.object({ referenced: v.number() });

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

export const keywordsHandler = {
  async list({ env }: KeywordsCall): Promise<KeywordsResponse> {
    try {
      const keywords = await queryAll(
        env.DB.prepare(
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
      return { keywords };
    } catch (error) {
      fail(error, 'Error fetching keywords', 'Failed to fetch keywords');
    }
  },

  async get({ env }: KeywordsCall, id: string): Promise<{ keyword: KeywordWithUsage }> {
    try {
      const keyword = await queryFirst(
        env.DB.prepare(
          `
                SELECT
                    ${KEYWORD_COLUMNS_OF_KT},
                    COUNT(DISTINCT mt.message_id) as usage_count
                FROM keyword_tags kt
                LEFT JOIN message_tags mt ON kt.id = mt.keyword_tag_id
                WHERE kt.id = ?
                GROUP BY kt.id
            `,
        ).bind(id),
        KeywordWithUsage,
      );
      if (!keyword) throw notFound();
      return { keyword };
    } catch (error) {
      fail(error, 'Error fetching keyword', 'Failed to fetch keyword');
    }
  },

  async create(
    { env, user }: KeywordsCall,
    body: v.InferOutput<typeof CreateKeywordBody>,
  ): Promise<KeywordResponse> {
    const { keyword, tag, color, priority, case_sensitive, whole_word } = body;
    try {
      const existing = await queryFirst(
        env.DB.prepare('SELECT id FROM keyword_tags WHERE keyword = ? AND is_active = TRUE').bind(
          keyword,
        ),
        IdRow,
      );
      if (existing) throw new ORPCError('CONFLICT', { message: 'Keyword already exists' });

      const result = await env.DB.prepare(
        `
                INSERT INTO keyword_tags (
                    keyword, tag, color, priority, case_sensitive, whole_word, created_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
      )
        .bind(keyword, tag, color, priority, case_sensitive, whole_word, user?.id ?? null)
        .run();

      const newKeyword = await queryOne(
        env.DB.prepare(`SELECT ${KEYWORD_COLUMNS} FROM keyword_tags WHERE id = ?`).bind(
          result.meta.last_row_id,
        ),
        Keyword,
      );
      return { keyword: newKeyword };
    } catch (error) {
      fail(error, 'Error creating keyword', `Failed to create keyword: ${errorText(error)}`);
    }
  },

  async update(
    { env }: KeywordsCall,
    id: string,
    body: v.InferOutput<typeof UpdateKeywordBody>,
  ): Promise<KeywordResponse> {
    try {
      const existing = await queryFirst(
        env.DB.prepare(`SELECT ${KEYWORD_COLUMNS} FROM keyword_tags WHERE id = ?`).bind(id),
        Keyword,
      );
      if (!existing) throw notFound();

      const { keyword, tag, color, priority, case_sensitive, whole_word, is_active } = body;
      if (
        (keyword !== undefined && keyword !== existing.keyword) ||
        (case_sensitive !== undefined && case_sensitive !== Boolean(existing.case_sensitive)) ||
        (whole_word !== undefined && whole_word !== Boolean(existing.whole_word))
      ) {
        throw new ORPCError('BAD_REQUEST', { message: IMMUTABLE_MESSAGE });
      }

      // An omitted colour keeps the stored one — but a row written before the
      // colour validation existed may hold a payload, so that value is run
      // through the same check and falls back to the default instead of 400ing.
      // Rejecting it would make such a row impossible to edit via the API.
      // See docs/SECURITY-REVIEW.md finding 2.
      let resolvedColor = color;
      if (resolvedColor === undefined) {
        const storedCheck = normalizeKeywordColor(existing.color);
        resolvedColor = storedCheck.ok ? storedCheck.value : DEFAULT_KEYWORD_COLOR;
      }

      const nextTag = tag === undefined || tag === null || tag === '' ? existing.tag : tag;

      const updated = await queryFirst(
        env.DB.prepare(
          `
                UPDATE keyword_tags
                SET tag = ?, color = ?, priority = ?, is_active = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                RETURNING ${KEYWORD_COLUMNS}
            `,
        ).bind(
          nextTag,
          resolvedColor,
          priority ?? existing.priority,
          is_active ?? existing.is_active,
          id,
        ),
        Keyword,
      );
      if (!updated) throw notFound();
      return { keyword: updated };
    } catch (error) {
      fail(error, 'Error updating keyword', 'Failed to update keyword');
    }
  },

  async remove({ env }: KeywordsCall, id: string): Promise<SuccessResponse> {
    try {
      const existing = await queryFirst(
        env.DB.prepare('SELECT id FROM keyword_tags WHERE id = ?').bind(id),
        IdRow,
      );
      if (!existing) throw notFound();

      const referenced = await queryFirst(
        env.DB.prepare(
          'SELECT 1 AS referenced FROM message_tags WHERE keyword_tag_id = ? LIMIT 1',
        ).bind(id),
        ReferencedRow,
      );
      if (referenced) {
        throw new ORPCError('CONFLICT', {
          message: 'Keyword has historical messages; deactivate it instead',
        });
      }

      await env.DB.prepare('DELETE FROM keyword_tags WHERE id = ?').bind(id).run();
      return { success: true };
    } catch (error) {
      fail(error, 'Error deleting keyword', 'Failed to delete keyword');
    }
  },

  // Batch get tags for multiple messages - to reduce XHR requests
  async batchTags(
    { env }: KeywordsCall,
    { messageIds }: v.InferOutput<typeof BatchTagsBody>,
  ): Promise<BatchTagsResponse> {
    if (messageIds.length === 0) return { success: true, data: {} };

    try {
      const limitedIds = messageIds.slice(0, MAX_BATCH_MESSAGES);
      const placeholders = limitedIds.map(() => '?').join(',');

      const rows = await queryAll(
        env.DB.prepare(
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
        ).bind(...limitedIds),
        BatchTagRow,
      );

      const tagsByMessage = new Map<string, BatchTagsResponse['data'][string]>();
      for (const row of rows) {
        const tags = tagsByMessage.get(row.message_id) ?? [];
        tags.push({
          id: row.id,
          keyword: row.keyword,
          tag: row.tag,
          color: row.color,
          priority: row.priority,
          position: row.position,
          length: row.length,
        });
        tagsByMessage.set(row.message_id, tags);
      }

      return { success: true, data: Object.fromEntries(tagsByMessage) };
    } catch (error) {
      fail(error, 'Error batch fetching message tags', 'Failed to fetch message tags');
    }
  },

  // Historical tagging is explicit, bounded, and one page per operator action.
  async history(
    { env }: KeywordsCall,
    id: string,
    { since, until, cursor }: v.InferOutput<typeof HistoryRequestBody>,
  ): Promise<KeywordHistoryPage> {
    try {
      const keyword = await queryFirst(
        env.DB.prepare(`SELECT ${KEYWORD_COLUMNS} FROM keyword_tags WHERE id = ?`).bind(id),
        Keyword,
      );
      if (!keyword) throw notFound();
      if (!keyword.is_active) {
        throw new ORPCError('CONFLICT', {
          message: 'Activate the keyword before applying it to history',
        });
      }

      return await processKeywordHistoryPage(
        env.DB,
        {
          id: keyword.id,
          keyword: keyword.keyword,
          case_sensitive: Boolean(keyword.case_sensitive),
          whole_word: Boolean(keyword.whole_word),
        },
        { since: since.toISOString(), until: until.toISOString(), cursor: cursor ?? null },
      );
    } catch (error) {
      fail(error, 'Error processing keyword history', 'Failed to process keyword history');
    }
  },

  async messageTags({ env }: KeywordsCall, id: string): Promise<MessageTagsResponse> {
    try {
      const tags = await queryAll(
        env.DB.prepare(
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
        ).bind(id),
        MessageTag,
      );
      return { tags };
    } catch (error) {
      fail(error, 'Error fetching message tags', 'Failed to fetch message tags');
    }
  },
};
