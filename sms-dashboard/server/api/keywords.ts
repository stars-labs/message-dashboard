import * as v from 'valibot';
import { readJson, type Schema } from '../../shared/parse-json.js';
import { queryAll, queryFirst, type D1, type D1Batch } from '../lib/d1.js';
import { handleAuth0, type AuthRequest } from '../middleware/auth0.js';
import { requirePermission, enrichUserPermissions } from '../middleware/rbac.js';
import { errorText } from '../utils/d1-error.js';
import { DEFAULT_KEYWORD_COLOR, normalizeKeywordColor } from '../utils/keyword-color.js';
import { processKeywordHistoryPage } from '../utils/keyword-history.js';
import type { Permission } from '../../config/auth0-roles.js';

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

const KeywordRow = v.object({
  id: v.number(),
  keyword: v.string(),
  tag: v.string(),
  color: v.nullable(v.string()),
  priority: v.nullable(v.number()),
  is_active: v.nullable(v.number()),
  case_sensitive: v.nullable(v.number()),
  whole_word: v.nullable(v.number()),
  created_by: v.nullable(v.string()),
  created_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string()),
});

type KeywordRow = v.InferOutput<typeof KeywordRow>;

const KeywordUsageRow = v.object({ ...KeywordRow.entries, usage_count: v.number() });

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

const CreateBody = v.object({
  keyword: v.optional(v.unknown()),
  tag: v.optional(v.unknown()),
  color: v.optional(v.unknown()),
  priority: v.optional(v.unknown()),
  case_sensitive: v.optional(v.unknown()),
  whole_word: v.optional(v.unknown()),
});

const UpdateBody = v.object({
  keyword: v.optional(v.unknown()),
  tag: v.optional(v.unknown()),
  color: v.optional(v.unknown()),
  priority: v.optional(v.unknown()),
  case_sensitive: v.optional(v.unknown()),
  whole_word: v.optional(v.unknown()),
  is_active: v.optional(v.unknown()),
});

const BatchBody = v.object({
  messageIds: v.fallback(v.optional(v.array(v.unknown()), []), []),
});

const HistoryBody = v.object({
  since: v.optional(v.union([v.string(), v.number()])),
  until: v.optional(v.union([v.string(), v.number()])),
  cursor: v.optional(v.unknown()),
});

const HistoryCursorBody = v.object({ created_at: v.string(), id: v.string() });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Auth0 + RBAC gate, at the head of every route here. Returns a Response to short-circuit, or null to proceed. */
async function gate(request: KeywordRequest, permission: Permission): Promise<Response | null> {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission(permission)(request);
  if (permResponse) return permResponse;
  return null;
}

async function readBody<T>(request: KeywordRequest, schema: Schema<T>): Promise<T> {
  const parsed = await readJson(request, schema);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function toDate(value: string | number | undefined): Date {
  return new Date(value ?? Number.NaN);
}

export function setupKeywordRoutes(router: Router): void {
  router.get('/api/keywords', async (request) => {
    const blocked = await gate(request, 'keywords.read');
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
        KeywordUsageRow,
      );

      return json({ keywords });
    } catch (error) {
      console.error('Error fetching keywords:', error);
      return json({ error: 'Failed to fetch keywords' }, 500);
    }
  });

  router.get('/api/keywords/:id', async (request) => {
    const blocked = await gate(request, 'keywords.read');
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
        KeywordUsageRow,
      );

      if (!keyword) {
        return json({ error: 'Keyword not found' }, 404);
      }

      return json({ keyword });
    } catch (error) {
      console.error('Error fetching keyword:', error);
      return json({ error: 'Failed to fetch keyword' }, 500);
    }
  });

  router.post('/api/keywords', async (request) => {
    const blocked = await gate(request, 'keywords.write');
    if (blocked) return blocked;

    const user = request.user;

    try {
      const { keyword, tag, color, priority, case_sensitive, whole_word } = await readBody(
        request,
        CreateBody,
      );

      if (typeof keyword !== 'string' || !keyword || typeof tag !== 'string' || !tag) {
        return json({ error: 'Keyword and tag are required' }, 400);
      }

      // The colour is applied to a CSS custom property in every operator's
      // browser, so it is only ever a hex literal.
      // See docs/SECURITY-REVIEW.md finding 2.
      const colorCheck = normalizeKeywordColor(color);

      if (!colorCheck.ok) {
        return json({ error: `Invalid color: ${colorCheck.reason}` }, 400);
      }

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
        .bind(
          keyword,
          tag,
          colorCheck.value,
          Number(priority) || 0,
          Boolean(case_sensitive),
          Boolean(whole_word),
          user?.id ?? null,
        )
        .run();

      const newKeyword = await queryFirst(
        request.env.DB.prepare(`SELECT ${KEYWORD_COLUMNS} FROM keyword_tags WHERE id = ?`).bind(
          result.meta.last_row_id,
        ),
        KeywordRow,
      );

      return json({ keyword: newKeyword }, 201);
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
    const blocked = await gate(request, 'keywords.write');
    if (blocked) return blocked;

    const id = request.params?.['id'];

    try {
      const { keyword, tag, color, priority, case_sensitive, whole_word, is_active } =
        await readBody(request, UpdateBody);

      const existing = await queryFirst(
        request.env.DB.prepare(`SELECT ${KEYWORD_COLUMNS} FROM keyword_tags WHERE id = ?`).bind(id),
        KeywordRow,
      );

      if (!existing) {
        return json({ error: 'Keyword not found' }, 404);
      }

      if (
        (keyword !== undefined && keyword !== existing.keyword) ||
        (case_sensitive !== undefined &&
          Boolean(case_sensitive) !== Boolean(existing.case_sensitive)) ||
        (whole_word !== undefined && Boolean(whole_word) !== Boolean(existing.whole_word))
      ) {
        return json(
          {
            error: 'Keyword and matching options are immutable; create a new keyword instead',
          },
          400,
        );
      }

      // A supplied colour must be a hex literal (400 otherwise, so the client
      // gets told). An omitted colour keeps the stored one — but a row written
      // before this validation existed may hold a payload, so that value is run
      // through the same check and falls back to the default instead of 400ing.
      // Rejecting it would make such a row impossible to edit via the API.
      // See docs/SECURITY-REVIEW.md finding 2.
      const colorSupplied = !(color === undefined || color === null || color === '');
      let resolvedColor: string;

      if (colorSupplied) {
        const colorCheck = normalizeKeywordColor(color);

        if (!colorCheck.ok) {
          return json({ error: `Invalid color: ${colorCheck.reason}` }, 400);
        }

        resolvedColor = colorCheck.value;
      } else {
        const storedCheck = normalizeKeywordColor(existing.color);
        resolvedColor = storedCheck.ok ? storedCheck.value : DEFAULT_KEYWORD_COLOR;
      }

      let nextTag: unknown = existing.tag;
      if (tag) nextTag = tag;

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
          priority !== undefined ? Number(priority) : existing.priority,
          is_active !== undefined ? Boolean(is_active) : existing.is_active,
          id,
        ),
        KeywordRow,
      );

      return json({ keyword: updated });
    } catch (error) {
      console.error('Error updating keyword:', error);
      return json({ error: 'Failed to update keyword' }, 500);
    }
  });

  router.delete('/api/keywords/:id', async (request) => {
    const blocked = await gate(request, 'keywords.delete');
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
    const blocked = await gate(request, 'messages.read');
    if (blocked) return blocked;

    const { messageIds } = await readBody(request, BatchBody);

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
    const blocked = await gate(request, 'keywords.write');
    if (blocked) return blocked;

    const id = request.params?.['id'];

    try {
      const keyword = await queryFirst(
        request.env.DB.prepare(`SELECT ${KEYWORD_COLUMNS} FROM keyword_tags WHERE id = ?`).bind(id),
        KeywordRow,
      );

      if (!keyword) {
        return json({ error: 'Keyword not found' }, 404);
      }
      if (!keyword.is_active) {
        return json({ error: 'Activate the keyword before applying it to history' }, 409);
      }

      const body = await readBody(request, HistoryBody);
      const since = toDate(body.since);
      const until = toDate(body.until);
      if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since > until) {
        return json({ error: 'A valid history time range is required' }, 400);
      }
      const rawCursor = body.cursor ?? null;
      let cursor: v.InferOutput<typeof HistoryCursorBody> | null = null;
      if (rawCursor !== null) {
        const parsed = v.safeParse(HistoryCursorBody, rawCursor);
        if (!parsed.success || Number.isNaN(new Date(`${parsed.output.created_at}Z`).getTime())) {
          return json({ error: 'Invalid history cursor' }, 400);
        }
        cursor = parsed.output;
      }

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
          cursor,
        },
      );

      return json(result);
    } catch (error) {
      console.error('Error processing keyword history:', error);
      return json({ error: 'Failed to process keyword history' }, 500);
    }
  });

  router.get('/api/messages/:id/tags', async (request) => {
    const blocked = await gate(request, 'messages.read');
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
