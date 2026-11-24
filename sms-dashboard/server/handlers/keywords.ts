import { ORPCError } from '@orpc/server';
import type * as v from 'valibot';
import type { HistoryRequestBody, KeywordHistoryPage } from '../../shared/api/history.js';
import {
  type KeywordWithUsage,
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
import {
  deleteKeyword,
  findActiveKeywordId,
  findKeyword,
  findKeywordId,
  findKeywordWithUsage,
  getKeyword,
  insertKeyword,
  isKeywordReferenced,
  listActiveTagsForMessages,
  listKeywordsWithUsage,
  listMessageTags,
  updateKeyword,
} from '../db/keywords.js';
import type { D1, D1Batch } from '../lib/d1.js';
import { processKeywordHistoryPage } from '../utils/keyword-history.js';

const MAX_BATCH_MESSAGES = 100;

const IMMUTABLE_MESSAGE =
  'Keyword and matching options are immutable; create a new keyword instead';

interface KeywordsCall {
  env: { DB: D1 & D1Batch };
  user?: { id: string } | undefined;
}

function fail(error: unknown, label: string, message: string): never {
  if (error instanceof ORPCError) throw error;
  console.error(`${label}:`, error);
  throw new ORPCError('INTERNAL_SERVER_ERROR', { message });
}

function notFound(): ORPCError<'NOT_FOUND', unknown> {
  return new ORPCError('NOT_FOUND', { message: 'Keyword not found' });
}

export const keywordsHandler = {
  async list({ env }: KeywordsCall): Promise<KeywordsResponse> {
    try {
      const keywords = await listKeywordsWithUsage(env.DB);
      return { keywords };
    } catch (error) {
      fail(error, 'Error fetching keywords', 'Failed to fetch keywords');
    }
  },

  async get({ env }: KeywordsCall, id: string): Promise<{ keyword: KeywordWithUsage }> {
    try {
      const keyword = await findKeywordWithUsage(env.DB, id);
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
      const existing = await findActiveKeywordId(env.DB, keyword);
      if (existing) throw new ORPCError('CONFLICT', { message: 'Keyword already exists' });

      const keywordId = await insertKeyword(env.DB, {
        keyword,
        tag,
        color,
        priority,
        case_sensitive,
        whole_word,
        created_by: user?.id ?? null,
      });

      const newKeyword = await getKeyword(env.DB, keywordId);
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
      const existing = await findKeyword(env.DB, id);
      if (!existing) throw notFound();

      const { keyword, tag, color, priority, case_sensitive, whole_word, is_active } = body;
      if (
        (keyword !== undefined && keyword !== existing.keyword) ||
        (case_sensitive !== undefined && case_sensitive !== Boolean(existing.case_sensitive)) ||
        (whole_word !== undefined && whole_word !== Boolean(existing.whole_word))
      ) {
        throw new ORPCError('BAD_REQUEST', { message: IMMUTABLE_MESSAGE });
      }

      // A stored colour may predate validation and hold a payload: re-check it and
      // fall back to the default instead of rejecting, which would make the row
      // uneditable (docs/SECURITY-REVIEW.md finding 2).
      let resolvedColor = color;
      if (resolvedColor === undefined) {
        const storedCheck = normalizeKeywordColor(existing.color);
        resolvedColor = storedCheck.ok ? storedCheck.value : DEFAULT_KEYWORD_COLOR;
      }

      const nextTag = tag === undefined || tag === null || tag === '' ? existing.tag : tag;

      const updated = await updateKeyword(env.DB, id, {
        tag: nextTag,
        color: resolvedColor,
        priority: priority ?? existing.priority,
        is_active: is_active ?? existing.is_active,
      });
      if (!updated) throw notFound();
      return { keyword: updated };
    } catch (error) {
      fail(error, 'Error updating keyword', 'Failed to update keyword');
    }
  },

  async remove({ env }: KeywordsCall, id: string): Promise<SuccessResponse> {
    try {
      const existing = await findKeywordId(env.DB, id);
      if (!existing) throw notFound();

      if (await isKeywordReferenced(env.DB, id)) {
        throw new ORPCError('CONFLICT', {
          message: 'Keyword has historical messages; deactivate it instead',
        });
      }

      await deleteKeyword(env.DB, id);
      return { success: true };
    } catch (error) {
      fail(error, 'Error deleting keyword', 'Failed to delete keyword');
    }
  },

  async batchTags(
    { env }: KeywordsCall,
    { messageIds }: v.InferOutput<typeof BatchTagsBody>,
  ): Promise<BatchTagsResponse> {
    if (messageIds.length === 0) return { success: true, data: {} };

    try {
      const limitedIds = messageIds.slice(0, MAX_BATCH_MESSAGES);

      const rows = await listActiveTagsForMessages(env.DB, limitedIds);

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

  // One bounded page per operator action.
  async history(
    { env }: KeywordsCall,
    id: string,
    { since, until, cursor }: v.InferOutput<typeof HistoryRequestBody>,
  ): Promise<KeywordHistoryPage> {
    try {
      const keyword = await findKeyword(env.DB, id);
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
      const tags = await listMessageTags(env.DB, id);
      return { tags };
    } catch (error) {
      fail(error, 'Error fetching message tags', 'Failed to fetch message tags');
    }
  },
};
