import { handleAuth0 } from '../middleware/auth0.js';
import { requirePermission, enrichUserPermissions } from '../middleware/rbac.js';
import { DEFAULT_KEYWORD_COLOR, normalizeKeywordColor } from '../utils/keyword-color.js';
import { processKeywordHistoryPage } from '../utils/keyword-history.js';

/**
 * Keyword-tag API endpoints
 */
export function setupKeywordRoutes(router) {
    // Get all keyword tags
    router.get('/api/keywords', async (request, env, ctx) => {
        const authResponse = await handleAuth0(request, env, ctx);
        if (authResponse) return authResponse;
        await enrichUserPermissions(request, env, ctx);
        const permResponse = await requirePermission('keywords.read')(request, env, ctx);
        if (permResponse) return permResponse;
        
        try {
            const { results } = await env.DB.prepare(`
                SELECT 
                    kt.*,
                    COUNT(DISTINCT mt.message_id) as usage_count
                FROM keyword_tags kt
                LEFT JOIN message_tags mt ON kt.id = mt.keyword_tag_id
                GROUP BY kt.id
                ORDER BY kt.priority DESC, kt.keyword ASC
            `).all();

            return new Response(JSON.stringify({ keywords: results }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Error fetching keywords:', error);
            return new Response(JSON.stringify({ error: 'Failed to fetch keywords' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    });

    // Get single keyword tag
    router.get('/api/keywords/:id', async (request, env, ctx) => {
        const authResponse = await handleAuth0(request, env, ctx);
        if (authResponse) return authResponse;
        await enrichUserPermissions(request, env, ctx);
        const permResponse = await requirePermission('keywords.read')(request, env, ctx);
        if (permResponse) return permResponse;
        
        const { id } = request.params;
        
        try {
            const keyword = await env.DB.prepare(`
                SELECT 
                    kt.*,
                    COUNT(DISTINCT mt.message_id) as usage_count
                FROM keyword_tags kt
                LEFT JOIN message_tags mt ON kt.id = mt.keyword_tag_id
                WHERE kt.id = ?
                GROUP BY kt.id
            `).bind(id).first();

            if (!keyword) {
                return new Response(JSON.stringify({ error: 'Keyword not found' }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            return new Response(JSON.stringify({ keyword }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Error fetching keyword:', error);
            return new Response(JSON.stringify({ error: 'Failed to fetch keyword' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    });

    // Create new keyword tag
    router.post('/api/keywords', async (request, env, ctx) => {
        const authResponse = await handleAuth0(request, env, ctx);
        if (authResponse) return authResponse;
        await enrichUserPermissions(request, env, ctx);
        const permResponse = await requirePermission('keywords.write')(request, env, ctx);
        if (permResponse) return permResponse;
        
        const user = request.user;
        
        try {
            const data = await request.json();
            const { keyword, tag, color, priority, case_sensitive, whole_word } = data;

            // Validate required fields
            if (!keyword || !tag) {
                return new Response(JSON.stringify({ error: 'Keyword and tag are required' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // The colour is applied to a CSS custom property in every operator's
            // browser, so it is only ever a hex literal.
            // See docs/SECURITY-REVIEW.md finding 2.
            const colorCheck = normalizeKeywordColor(color);

            if (!colorCheck.ok) {
                return new Response(JSON.stringify({ error: `Invalid color: ${colorCheck.reason}` }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Check for duplicate keyword
            const existing = await env.DB.prepare(
                'SELECT id FROM keyword_tags WHERE keyword = ? AND is_active = TRUE'
            ).bind(keyword).first();

            if (existing) {
                return new Response(JSON.stringify({ error: 'Keyword already exists' }), {
                    status: 409,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // Insert new keyword tag
            const result = await env.DB.prepare(`
                INSERT INTO keyword_tags (
                    keyword, tag, color, priority, case_sensitive, whole_word, created_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `).bind(
                keyword,
                tag,
                colorCheck.value,
                priority || 0,
                case_sensitive || false,
                whole_word || false,
                user.id
            ).run();

            const newKeyword = await env.DB.prepare(
                'SELECT * FROM keyword_tags WHERE id = ?'
            ).bind(result.meta.last_row_id).first();

            return new Response(JSON.stringify({ keyword: newKeyword }), {
                status: 201,
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Error creating keyword:', error);
            console.error('Error stack:', error.stack);
            console.error('User object:', JSON.stringify(user));
            return new Response(JSON.stringify({ 
                error: 'Failed to create keyword',
                details: error.message 
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    });

    // Update keyword tag
    router.put('/api/keywords/:id', async (request, env, ctx) => {
        const authResponse = await handleAuth0(request, env, ctx);
        if (authResponse) return authResponse;
        await enrichUserPermissions(request, env, ctx);
        const permResponse = await requirePermission('keywords.write')(request, env, ctx);
        if (permResponse) return permResponse;
        
        const { id } = request.params;
        
        try {
            const data = await request.json();
            const { keyword, tag, color, priority, case_sensitive, whole_word, is_active } = data;

            // Check if keyword exists
            const existing = await env.DB.prepare(
                'SELECT * FROM keyword_tags WHERE id = ?'
            ).bind(id).first();

            if (!existing) {
                return new Response(JSON.stringify({ error: 'Keyword not found' }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            if (
                (keyword !== undefined && keyword !== existing.keyword)
                || (case_sensitive !== undefined && Boolean(case_sensitive) !== Boolean(existing.case_sensitive))
                || (whole_word !== undefined && Boolean(whole_word) !== Boolean(existing.whole_word))
            ) {
                return new Response(JSON.stringify({
                    error: 'Keyword and matching options are immutable; create a new keyword instead'
                }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            // A supplied colour must be a hex literal (400 otherwise, so the client
            // gets told). An omitted colour keeps the stored one — but a row written
            // before this validation existed may hold a payload, so that value is run
            // through the same check and falls back to the default instead of 400ing.
            // Rejecting it would make such a row impossible to edit via the API.
            // See docs/SECURITY-REVIEW.md finding 2.
            const colorSupplied = !(color === undefined || color === null || color === '');
            let resolvedColor;

            if (colorSupplied) {
                const colorCheck = normalizeKeywordColor(color);

                if (!colorCheck.ok) {
                    return new Response(JSON.stringify({ error: `Invalid color: ${colorCheck.reason}` }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                resolvedColor = colorCheck.value;
            } else {
                const storedCheck = normalizeKeywordColor(existing.color);
                resolvedColor = storedCheck.ok ? storedCheck.value : DEFAULT_KEYWORD_COLOR;
            }

            // Update keyword tag
            const updated = await env.DB.prepare(`
                UPDATE keyword_tags
                SET tag = ?, color = ?, priority = ?, is_active = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                RETURNING *
            `).bind(
                tag || existing.tag,
                resolvedColor,
                priority !== undefined ? priority : existing.priority,
                is_active !== undefined ? is_active : existing.is_active,
                id
            ).first();

            return new Response(JSON.stringify({ keyword: updated }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Error updating keyword:', error);
            return new Response(JSON.stringify({ error: 'Failed to update keyword' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    });

    // Delete keyword tag
    router.delete('/api/keywords/:id', async (request, env, ctx) => {
        const authResponse = await handleAuth0(request, env, ctx);
        if (authResponse) return authResponse;
        await enrichUserPermissions(request, env, ctx);
        const permResponse = await requirePermission('keywords.delete')(request, env, ctx);
        if (permResponse) return permResponse;
        
        const { id } = request.params;
        
        try {
            const existing = await env.DB.prepare(
                'SELECT * FROM keyword_tags WHERE id = ?'
            ).bind(id).first();

            if (!existing) {
                return new Response(JSON.stringify({ error: 'Keyword not found' }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const referenced = await env.DB.prepare(
                'SELECT 1 FROM message_tags WHERE keyword_tag_id = ? LIMIT 1'
            ).bind(id).first();
            if (referenced) {
                return new Response(JSON.stringify({
                    error: 'Keyword has historical messages; deactivate it instead'
                }), {
                    status: 409,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            await env.DB.prepare('DELETE FROM keyword_tags WHERE id = ?').bind(id).run();

            return new Response(JSON.stringify({ success: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Error deleting keyword:', error);
            return new Response(JSON.stringify({ error: 'Failed to delete keyword' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    });

    // NEW: Batch get tags for multiple messages - to reduce XHR requests
    router.post('/api/messages/batch-tags', async (request, env, ctx) => {
        const authResponse = await handleAuth0(request, env, ctx);
        if (authResponse) return authResponse;
        await enrichUserPermissions(request, env, ctx);
        const permResponse = await requirePermission('messages.read')(request, env, ctx);
        if (permResponse) return permResponse;
        
        const { messageIds } = await request.json();
        
        if (!Array.isArray(messageIds) || messageIds.length === 0) {
            return new Response(JSON.stringify({ 
                success: true, 
                data: {} 
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }
        
        try {
            // Limit to 100 messages to prevent abuse
            const limitedIds = messageIds.slice(0, 100);
            const placeholders = limitedIds.map(() => '?').join(',');
            
            const result = await env.DB.prepare(`
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
            `).bind(...limitedIds).all();
            
            // Group tags by message ID
            const tagsByMessage = {};
            const tags = result.results || [];
            
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
                    length: tag.length
                });
            }
            
            return new Response(JSON.stringify({
                success: true,
                data: tagsByMessage
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Error batch fetching message tags:', error);
            return new Response(JSON.stringify({ 
                error: 'Failed to fetch message tags' 
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    });

    // Historical tagging is explicit, bounded, and one page per operator action.
    router.post('/api/keywords/:id/history', async (request, env, ctx) => {
        const authResponse = await handleAuth0(request, env, ctx);
        if (authResponse) return authResponse;
        await enrichUserPermissions(request, env, ctx);
        const permResponse = await requirePermission('keywords.write')(request, env, ctx);
        if (permResponse) return permResponse;
        
        const { id } = request.params;
        
        try {
            const keyword = await env.DB.prepare(
                'SELECT * FROM keyword_tags WHERE id = ?'
            ).bind(id).first();
            
            if (!keyword) {
                return new Response(JSON.stringify({ error: 'Keyword not found' }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (!keyword.is_active) {
                return new Response(JSON.stringify({ error: 'Activate the keyword before applying it to history' }), {
                    status: 409,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const body = await request.json();
            const since = new Date(body.since);
            const until = new Date(body.until);
            if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since > until) {
                return new Response(JSON.stringify({ error: 'A valid history time range is required' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            const cursor = body.cursor || null;
            if (cursor && (
                typeof cursor.created_at !== 'string'
                || typeof cursor.id !== 'string'
                || Number.isNaN(new Date(`${cursor.created_at}Z`).getTime())
            )) {
                return new Response(JSON.stringify({ error: 'Invalid history cursor' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const result = await processKeywordHistoryPage(env.DB, keyword, {
                since: since.toISOString(),
                until: until.toISOString(),
                cursor
            });

            return new Response(JSON.stringify(result), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Error processing keyword history:', error);
            return new Response(JSON.stringify({ error: 'Failed to process keyword history' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    });
    
    // Get message tags for a specific message
    router.get('/api/messages/:id/tags', async (request, env, ctx) => {
        const authResponse = await handleAuth0(request, env, ctx);
        if (authResponse) return authResponse;
        await enrichUserPermissions(request, env, ctx);
        const permResponse = await requirePermission('messages.read')(request, env, ctx);
        if (permResponse) return permResponse;
        
        const { id } = request.params;
        
        try {
            const { results } = await env.DB.prepare(`
                SELECT 
                    mt.*,
                    kt.keyword,
                    kt.tag,
                    kt.color
                FROM message_tags mt
                JOIN keyword_tags kt ON mt.keyword_tag_id = kt.id
                WHERE mt.message_id = ? AND kt.is_active = TRUE
                ORDER BY mt.position ASC
            `).bind(id).all();

            return new Response(JSON.stringify({ tags: results }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Error fetching message tags:', error);
            return new Response(JSON.stringify({ error: 'Failed to fetch message tags' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    });
}
