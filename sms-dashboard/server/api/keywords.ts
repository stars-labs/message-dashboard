import { json } from '../lib/response.js';
import * as v from 'valibot';
import {
  Keyword,
  KeywordWithUsage,
  type KeywordResponse,
  type KeywordsResponse,
} from '../../shared/api/keywords.js';
import { queryAll, queryFirst, queryOne, type D1, type D1Batch } from '../lib/d1.js';
import { OBJECT_MESSAGE, readBody, type MissingKeyMessages } from '../lib/request-body.js';
import { HISTORY_MISSING_KEY_MESSAGES, HistoryRequestBody } from '../utils/history-request.js';
import type { AuthRequest } from '../middleware/auth0.js';
import { authorize } from '../middleware/authorize.js';
import { errorText } from '../utils/d1-error.js';
import { DEFAULT_KEYWORD_COLOR, normalizeKeywordColor } from '../utils/keyword-color.js';
import { processKeywordHistoryPage } from '../utils/keyword-history.js';

const MAX_BATCH_MESSAGES = 100;

type KeywordsDb = D1 & D1Batch;

interface KeywordRequest extends AuthRequest {
  env: AuthRequest['env'] & { DB: KeywordsDb };
  params?: Record<string, string>;
  text(): Promise<string>;
}

type KeywordHandler = (request: KeywordRequest) => Promise<Response>;

interface Router {
  get(path: string, handler: KeywordHandler): void;
  post(path: string, handler: KeywordHandler): void;
  put(path: string, handler: KeywordHandler): void;
  delete(path: string, handler: KeywordHandler): void;
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

const MessageTagRow = v.object({
  message_id: v.string(),
  keyword_tag_id: v.number(),
  matched_text: v.string(),
  position: v.number(),
  created_at: v.nullable(v.string()),
  keyword: v.string(),
  tag: v.string(),
  color: v.nullable(v.string()),
});

const REQUIRED_MESSAGE = 'Keyword and tag are required';
const KEYWORD_MESSAGE = 'keyword must be a string';
const TAG_MESSAGE = 'tag must be a string';
const PRIORITY_MESSAGE = 'priority must be an integer';
const CASE_SENSITIVE_MESSAGE = 'case_sensitive must be true or false';
const WHOLE_WORD_MESSAGE = 'whole_word must be true or false';
const ACTIVE_MESSAGE = 'is_active must be true or false';
const IMMUTABLE_MESSAGE =
  'Keyword and matching options are immutable; create a new keyword instead';
const MESSAGE_IDS_MESSAGE = 'messageIds must be an array of strings';

const Required = v.pipe(v.string(REQUIRED_MESSAGE), v.nonEmpty(REQUIRED_MESSAGE));

const Priority = v.pipe(v.number(PRIORITY_MESSAGE), v.integer(PRIORITY_MESSAGE));

/**
 * A colour is applied to a CSS custom property in every operator's browser, so
 * a supplied one must be a hex literal. null and '' mean "not supplied" and
 * resolve to `blank`.
 */
function colour<Blank>(blank: Blank) {
  return v.pipe(
    v.unknown(),
    v.rawTransform(({ dataset, addIssue, NEVER }) => {
      if (dataset.value === null || dataset.value === '') return blank;
      const check = normalizeKeywordColor(dataset.value);
      if (check.ok) return check.value;
      addIssue({ message: `Invalid color: ${check.reason}` });
      return NEVER;
    }),
  );
}

const CreateBody = v.object(
  {
    keyword: Required,
    tag: Required,
    color: v.optional(colour(DEFAULT_KEYWORD_COLOR), DEFAULT_KEYWORD_COLOR),
    priority: v.nullish(Priority, 0),
    case_sensitive: v.optional(v.boolean(CASE_SENSITIVE_MESSAGE), false),
    whole_word: v.optional(v.boolean(WHOLE_WORD_MESSAGE), false),
  },
  OBJECT_MESSAGE,
);

const UpdateBody = v.object(
  {
    keyword: v.optional(v.string(KEYWORD_MESSAGE)),
    tag: v.nullish(v.string(TAG_MESSAGE)),
    color: v.optional(colour(undefined)),
    priority: v.optional(v.nullable(Priority, 0)),
    case_sensitive: v.optional(v.boolean(CASE_SENSITIVE_MESSAGE)),
    whole_word: v.optional(v.boolean(WHOLE_WORD_MESSAGE)),
    is_active: v.optional(v.boolean(ACTIVE_MESSAGE)),
  },
  OBJECT_MESSAGE,
);

const BatchBody = v.object(
  { messageIds: v.array(v.string(MESSAGE_IDS_MESSAGE), MESSAGE_IDS_MESSAGE) },
  OBJECT_MESSAGE,
);

const CREATE_MISSING_KEY_MESSAGES = {
  keyword: REQUIRED_MESSAGE,
  tag: REQUIRED_MESSAGE,
} as const satisfies MissingKeyMessages<typeof CreateBody>;

const BATCH_MISSING_KEY_MESSAGES = {
  messageIds: MESSAGE_IDS_MESSAGE,
} as const satisfies MissingKeyMessages<typeof BatchBody>;

export function setupKeywordRoutes(router: Router): void {
  router.get('/api/keywords', async (request) => {
    const blocked = await authorize(request, 'keywords.read');
    if (blocked) return blocked;

    try {
      const keywords = await queryAll(
        request.env.DB.prepare(
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

      return json({ keywords } satisfies KeywordsResponse);
    } catch (error) {
      console.error('Error fetching keywords:', error);
      return json({ error: 'Failed to fetch keywords' }, 500);
    }
  });

  router.get('/api/keywords/:id', async (request) => {
    const blocked = await authorize(request, 'keywords.read');
    if (blocked) return blocked;

    const id = request.params?.['id'];

    try {
      const keyword = await queryFirst(
        request.env.DB.prepare(
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

      if (!keyword) {
        return json({ error: 'Keyword not found' }, 404);
      }

      return json({ keyword } satisfies KeywordResponse);
    } catch (error) {
      console.error('Error fetching keyword:', error);
      return json({ error: 'Failed to fetch keyword' }, 500);
    }
  });

  router.post('/api/keywords', async (request) => {
    const blocked = await authorize(request, 'keywords.write');
    if (blocked) return blocked;

    const user = request.user;

    try {
      const parsed = await readBody(request, CreateBody, CREATE_MISSING_KEY_MESSAGES);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const { keyword, tag, color, priority, case_sensitive, whole_word } = parsed.value;

      const existing = await queryFirst(
        request.env.DB.prepare(
          'SELECT id FROM keyword_tags WHERE keyword = ? AND is_active = TRUE',
        ).bind(keyword),
        IdRow,
      );

      if (existing) {
        return json({ error: 'Keyword already exists' }, 409);
      }

      const result = await request.env.DB.prepare(
        `
                INSERT INTO keyword_tags (
                    keyword, tag, color, priority, case_sensitive, whole_word, created_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
      )
        .bind(keyword, tag, color, priority, case_sensitive, whole_word, user?.id ?? null)
        .run();

      const newKeyword = await queryOne(
        request.env.DB.prepare(`SELECT ${KEYWORD_COLUMNS} FROM keyword_tags WHERE id = ?`).bind(
          result.meta.last_row_id,
        ),
        Keyword,
      );

      return json({ keyword: newKeyword } satisfies KeywordResponse, 201);
    } catch (error) {
      console.error('Error creating keyword:', error);
      return json(
        {
          error: 'Failed to create keyword',
          details: errorText(error),
        },
        500,
      );
    }
  });

  router.put('/api/keywords/:id', async (request) => {
    const blocked = await authorize(request, 'keywords.write');
    if (blocked) return blocked;

    const id = request.params?.['id'];

    try {
      const existing = await queryFirst(
        request.env.DB.prepare(`SELECT ${KEYWORD_COLUMNS} FROM keyword_tags WHERE id = ?`).bind(id),
        Keyword,
      );

      if (!existing) {
        return json({ error: 'Keyword not found' }, 404);
      }

      const parsed = await readBody(request, UpdateBody, {});
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const { keyword, tag, color, priority, case_sensitive, whole_word, is_active } = parsed.value;

      if (
        (keyword !== undefined && keyword !== existing.keyword) ||
        (case_sensitive !== undefined && case_sensitive !== Boolean(existing.case_sensitive)) ||
        (whole_word !== undefined && whole_word !== Boolean(existing.whole_word))
      ) {
        return json({ error: IMMUTABLE_MESSAGE }, 400);
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
        request.env.DB.prepare(
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
      if (!updated) return json({ error: 'Keyword not found' }, 404);

      return json({ keyword: updated } satisfies KeywordResponse);
    } catch (error) {
      console.error('Error updating keyword:', error);
      return json({ error: 'Failed to update keyword' }, 500);
    }
  });

  router.delete('/api/keywords/:id', async (request) => {
    const blocked = await authorize(request, 'keywords.delete');
    if (blocked) return blocked;

    const id = request.params?.['id'];

    try {
      const existing = await queryFirst(
        request.env.DB.prepare('SELECT id FROM keyword_tags WHERE id = ?').bind(id),
        IdRow,
      );

      if (!existing) {
        return json({ error: 'Keyword not found' }, 404);
      }

      const referenced = await queryFirst(
        request.env.DB.prepare(
          'SELECT 1 AS referenced FROM message_tags WHERE keyword_tag_id = ? LIMIT 1',
        ).bind(id),
        ReferencedRow,
      );
      if (referenced) {
        return json({ error: 'Keyword has historical messages; deactivate it instead' }, 409);
      }

      await request.env.DB.prepare('DELETE FROM keyword_tags WHERE id = ?').bind(id).run();

      return json({ success: true });
    } catch (error) {
      console.error('Error deleting keyword:', error);
      return json({ error: 'Failed to delete keyword' }, 500);
    }
  });

  // Batch get tags for multiple messages - to reduce XHR requests
  router.post('/api/messages/batch-tags', async (request) => {
    const blocked = await authorize(request, 'messages.read');
    if (blocked) return blocked;

    const parsed = await readBody(request, BatchBody, BATCH_MISSING_KEY_MESSAGES);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { messageIds } = parsed.value;

    if (messageIds.length === 0) {
      return json({ success: true, data: {} });
    }

    try {
      const limitedIds = messageIds.slice(0, MAX_BATCH_MESSAGES);
      const placeholders = limitedIds.map(() => '?').join(',');

      const rows = await queryAll(
        request.env.DB.prepare(
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

      const tagsByMessage = new Map<
        string,
        Pick<
          v.InferOutput<typeof BatchTagRow>,
          'id' | 'keyword' | 'tag' | 'color' | 'priority' | 'position' | 'length'
        >[]
      >();

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

      return json({ success: true, data: Object.fromEntries(tagsByMessage) });
    } catch (error) {
      console.error('Error batch fetching message tags:', error);
      return json({ error: 'Failed to fetch message tags' }, 500);
    }
  });

  // Historical tagging is explicit, bounded, and one page per operator action.
  router.post('/api/keywords/:id/history', async (request) => {
    const blocked = await authorize(request, 'keywords.write');
    if (blocked) return blocked;

    const id = request.params?.['id'];

    try {
      const keyword = await queryFirst(
        request.env.DB.prepare(`SELECT ${KEYWORD_COLUMNS} FROM keyword_tags WHERE id = ?`).bind(id),
        Keyword,
      );

      if (!keyword) {
        return json({ error: 'Keyword not found' }, 404);
      }
      if (!keyword.is_active) {
        return json({ error: 'Activate the keyword before applying it to history' }, 409);
      }

      const parsed = await readBody(request, HistoryRequestBody, HISTORY_MISSING_KEY_MESSAGES);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const { since, until, cursor } = parsed.value;

      const result = await processKeywordHistoryPage(
        request.env.DB,
        {
          id: keyword.id,
          keyword: keyword.keyword,
          case_sensitive: Boolean(keyword.case_sensitive),
          whole_word: Boolean(keyword.whole_word),
        },
        {
          since: since.toISOString(),
          until: until.toISOString(),
          cursor: cursor ?? null,
        },
      );

      return json(result);
    } catch (error) {
      console.error('Error processing keyword history:', error);
      return json({ error: 'Failed to process keyword history' }, 500);
    }
  });

  router.get('/api/messages/:id/tags', async (request) => {
    const blocked = await authorize(request, 'messages.read');
    if (blocked) return blocked;

    const id = request.params?.['id'];

    try {
      const tags = await queryAll(
        request.env.DB.prepare(
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
        MessageTagRow,
      );

      return json({ tags });
    } catch (error) {
      console.error('Error fetching message tags:', error);
      return json({ error: 'Failed to fetch message tags' }, 500);
    }
  });
}
