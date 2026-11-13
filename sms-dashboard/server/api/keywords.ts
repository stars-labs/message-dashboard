import { handleAuth0 } from '../middleware/auth0.js';
import { requirePermission, enrichUserPermissions } from '../middleware/rbac.js';
import { DEFAULT_KEYWORD_COLOR, normalizeKeywordColor } from '../utils/keyword-color.js';
import { processKeywordHistoryPage } from '../utils/keyword-history.js';
import type { Handler, AppRequest, Env } from '../worker-context.js';
import type { ExecutionContext } from '../cf-bindings.js';
import type { Permission } from '../../config/auth0-roles.js';

/** The router shape setupKeywordRoutes needs. */
interface Router {
  get(path: string, ...handlers: Handler[]): void;
  post(path: string, ...handlers: Handler[]): void;
  put(path: string, ...handlers: Handler[]): void;
  delete(path: string, ...handlers: Handler[]): void;
}

/** A keyword_tags row. */
interface KeywordRow {
  id: number;
  keyword: string;
  tag: string;
  color: string | null;
  priority: number;
  case_sensitive: number;
  whole_word: number;
  is_active: number;
  usage_count?: number;
  [column: string]: unknown;
}

/** The body accepted by POST /api/keywords. */
interface KeywordCreateBody {
  keyword?: unknown;
  tag?: unknown;
  color?: unknown;
  priority?: unknown;
  case_sensitive?: unknown;
  whole_word?: unknown;
}

/** One joined message_tags row. */
interface MessageTagRow {
  message_id: string;
  id: number;
  keyword: string;
  tag: string;
  color: string | null;
  priority: number;
  position: number;
  matched_text: string | null;
  length: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Auth0 + RBAC gate, at the head of every route here. Returns a Response to
 * short-circuit, or null to proceed.
 */
async function gate(
  request: AppRequest,
  env: Env,
  ctx: ExecutionContext,
  permission: Permission,
): Promise<Response | null> {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request);
  const permResponse = await requirePermission(permission)(request);
  if (permResponse) return permResponse;
  return null;
}

/**
 * Keyword-tag API endpoints
 */
export function setupKeywordRoutes(router: Router): void {
  // Get all keyword tags
  router.get('/api/keywords', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'keywords.read');
    if (blocked) return blocked;

    try {
      const { results } = await env.DB.prepare(
        `
                SELECT 
                    kt.*,
                    COUNT(DISTINCT mt.message_id) as usage_count
                FROM keyword_tags kt
                LEFT JOIN message_tags mt ON kt.id = mt.keyword_tag_id
                GROUP BY kt.id
                ORDER BY kt.priority DESC, kt.keyword ASC
            `,
      ).all<KeywordRow>();

      return json({ keywords: results });
    } catch (error) {
      console.error('Error fetching keywords:', error);
      return json({ error: 'Failed to fetch keywords' }, 500);
    }
  });

  // Get single keyword tag
  router.get('/api/keywords/:id', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'keywords.read');
    if (blocked) return blocked;

    const id = request.params?.id;

    try {
      const keyword = await env.DB.prepare(
        `
                SELECT 
                    kt.*,
                    COUNT(DISTINCT mt.message_id) as usage_count
                FROM keyword_tags kt
                LEFT JOIN message_tags mt ON kt.id = mt.keyword_tag_id
                WHERE kt.id = ?
                GROUP BY kt.id
            `,
      )
        .bind(id)
        .first();

      if (!keyword) {
        return json({ error: 'Keyword not found' }, 404);
      }

      return json({ keyword });
    } catch (error) {
      console.error('Error fetching keyword:', error);
      return json({ error: 'Failed to fetch keyword' }, 500);
    }
  });

  // Create new keyword tag
  router.post('/api/keywords', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'keywords.write');
    if (blocked) return blocked;

    const user = request.user;

    try {
      const data = (await request.json()) as KeywordCreateBody;
      const { keyword, tag, color, priority, case_sensitive, whole_word } = data;

      // Validate required fields
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

      // Check for duplicate keyword
      const existing = await env.DB.prepare(
        'SELECT id FROM keyword_tags WHERE keyword = ? AND is_active = TRUE',
      )
        .bind(keyword)
        .first();

      if (existing) {
        return json({ error: 'Keyword already exists' }, 409);
      }

      // Insert new keyword tag
      const result = await env.DB.prepare(
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

      const newKeyword = await env.DB.prepare('SELECT * FROM keyword_tags WHERE id = ?')
        .bind(result.meta.last_row_id)
        .first<KeywordRow>();

      return json({ keyword: newKeyword }, 201);
    } catch (error) {
      console.error('Error creating keyword:', error);
      return json(
        {
          error: 'Failed to create keyword',
          details: (error as Error).message,
        },
        500,
      );
    }
  });

  // Update keyword tag
  router.put('/api/keywords/:id', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'keywords.write');
    if (blocked) return blocked;

    const id = request.params?.id;

    try {
      const data = (await request.json()) as KeywordCreateBody & { is_active?: unknown };
      const { keyword, tag, color, priority, case_sensitive, whole_word, is_active } = data;

      // Check if keyword exists
      const existing = await env.DB.prepare('SELECT * FROM keyword_tags WHERE id = ?')
        .bind(id)
        .first<KeywordRow>();

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

      // Update keyword tag
      const updated = await env.DB.prepare(
        `
                UPDATE keyword_tags
                SET tag = ?, color = ?, priority = ?, is_active = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                RETURNING *
            `,
      )
        .bind(
          tag || existing.tag,
          resolvedColor,
          priority !== undefined ? Number(priority) : existing.priority,
          is_active !== undefined ? Boolean(is_active) : existing.is_active,
          id,
        )
        .first<KeywordRow>();

      return json({ keyword: updated });
    } catch (error) {
      console.error('Error updating keyword:', error);
      return json({ error: 'Failed to update keyword' }, 500);
    }
  });

  // Delete keyword tag
  router.delete('/api/keywords/:id', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'keywords.delete');
    if (blocked) return blocked;

    const id = request.params?.id;

    try {
      const existing = await env.DB.prepare('SELECT * FROM keyword_tags WHERE id = ?')
        .bind(id)
        .first<KeywordRow>();

      if (!existing) {
        return json({ error: 'Keyword not found' }, 404);
      }

      const referenced = await env.DB.prepare(
        'SELECT 1 FROM message_tags WHERE keyword_tag_id = ? LIMIT 1',
      )
        .bind(id)
        .first();
      if (referenced) {
        return json({ error: 'Keyword has historical messages; deactivate it instead' }, 409);
      }

      await env.DB.prepare('DELETE FROM keyword_tags WHERE id = ?').bind(id).run();

      return json({ success: true });
    } catch (error) {
      console.error('Error deleting keyword:', error);
      return json({ error: 'Failed to delete keyword' }, 500);
    }
  });

  // NEW: Batch get tags for multiple messages - to reduce XHR requests
  router.post('/api/messages/batch-tags', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'messages.read');
    if (blocked) return blocked;

    const { messageIds } = (await request.json()) as { messageIds?: unknown };

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return json({ success: true, data: {} });
    }

    try {
      // Limit to 100 messages to prevent abuse
      const limitedIds = (messageIds as unknown[]).slice(0, 100);
      const placeholders = limitedIds.map(() => '?').join(',');

      const result = await env.DB.prepare(
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
        .bind(...limitedIds)
        .all<MessageTagRow>();

      // Group tags by message ID
      const tagsByMessage: Record<string, unknown[]> = {};
      const tags = result.results;

      for (const tag of tags) {
        if (!tagsByMessage[tag.message_id]) {
          tagsByMessage[tag.message_id] = [];
        }
        tagsByMessage[tag.message_id].push({
          id: tag.id,
          keyword: tag.keyword,
          tag: tag.tag,
          color: tag.color,
          priority: tag.priority,
          position: tag.position,
          length: tag.length,
        });
      }

      return json({ success: true, data: tagsByMessage });
    } catch (error) {
      console.error('Error batch fetching message tags:', error);
      return json({ error: 'Failed to fetch message tags' }, 500);
    }
  });

  // Historical tagging is explicit, bounded, and one page per operator action.
  router.post('/api/keywords/:id/history', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'keywords.write');
    if (blocked) return blocked;

    const id = request.params?.id;

    try {
      const keyword = await env.DB.prepare('SELECT * FROM keyword_tags WHERE id = ?')
        .bind(id)
        .first<KeywordRow>();

      if (!keyword) {
        return json({ error: 'Keyword not found' }, 404);
      }
      if (!keyword.is_active) {
        return json({ error: 'Activate the keyword before applying it to history' }, 409);
      }

      const body = (await request.json()) as { since?: unknown; until?: unknown; cursor?: unknown };
      const since = new Date(body.since as string);
      const until = new Date(body.until as string);
      if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since > until) {
        return json({ error: 'A valid history time range is required' }, 400);
      }
      const rawCursor: unknown = body.cursor ?? null;
      let cursor: { created_at: string; id: string } | null = null;
      if (rawCursor !== null) {
        const c = rawCursor as { created_at?: unknown; id?: unknown };
        if (
          typeof c.created_at !== 'string' ||
          typeof c.id !== 'string' ||
          Number.isNaN(new Date(`${c.created_at}Z`).getTime())
        ) {
          return json({ error: 'Invalid history cursor' }, 400);
        }
        cursor = { created_at: c.created_at, id: c.id };
      }

      const result = await processKeywordHistoryPage(
        env.DB,
        {
          id: keyword.id,
          keyword: keyword.keyword,
          case_sensitive: keyword.case_sensitive,
          whole_word: keyword.whole_word,
        },
        {
          since: since.toISOString(),
          until: until.toISOString(),
          cursor,
        } as unknown as Parameters<typeof processKeywordHistoryPage>[2],
      );

      return json(result);
    } catch (error) {
      console.error('Error processing keyword history:', error);
      return json({ error: 'Failed to process keyword history' }, 500);
    }
  });

  // Get message tags for a specific message
  router.get('/api/messages/:id/tags', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'messages.read');
    if (blocked) return blocked;

    const id = request.params?.id;

    try {
      const { results } = await env.DB.prepare(
        `
                SELECT 
                    mt.*,
                    kt.keyword,
                    kt.tag,
                    kt.color
                FROM message_tags mt
                JOIN keyword_tags kt ON mt.keyword_tag_id = kt.id
                WHERE mt.message_id = ? AND kt.is_active = TRUE
                ORDER BY mt.position ASC
            `,
      )
        .bind(id)
        .all();

      return json({ tags: results });
    } catch (error) {
      console.error('Error fetching message tags:', error);
      return json({ error: 'Failed to fetch message tags' }, 500);
    }
  });
}
