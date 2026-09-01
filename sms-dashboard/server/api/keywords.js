import { handleAuth0 } from '../middleware/auth0.js';
import { requirePermission, enrichUserPermissions } from '../middleware/rbac.js';
import { DEFAULT_KEYWORD_COLOR, normalizeKeywordColor } from '../utils/keyword-color.js';

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

            // Process existing messages to find matches
            await processExistingMessages(env.DB, result.meta.last_row_id, keyword, case_sensitive, whole_word);

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
            await env.DB.prepare(`
                UPDATE keyword_tags
                SET keyword = ?, tag = ?, color = ?, priority = ?,
                    case_sensitive = ?, whole_word = ?, is_active = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).bind(
                keyword || existing.keyword,
                tag || existing.tag,
                resolvedColor,
                priority !== undefined ? priority : existing.priority,
                case_sensitive !== undefined ? case_sensitive : existing.case_sensitive,
                whole_word !== undefined ? whole_word : existing.whole_word,
                is_active !== undefined ? is_active : existing.is_active,
                id
            ).run();

            // If keyword changed or matching rules changed, reprocess messages
            if (keyword !== existing.keyword || 
                case_sensitive !== existing.case_sensitive || 
                whole_word !== existing.whole_word) {
                // Remove old matches
                await env.DB.prepare(
                    'DELETE FROM message_tags WHERE keyword_tag_id = ?'
                ).bind(id).run();
                
                // Reprocess messages if active
                if (is_active !== false) {
                    await processExistingMessages(env.DB, id, keyword || existing.keyword, 
                        case_sensitive !== undefined ? case_sensitive : existing.case_sensitive,
                        whole_word !== undefined ? whole_word : existing.whole_word);
                }
            }

            const updated = await env.DB.prepare(
                'SELECT * FROM keyword_tags WHERE id = ?'
            ).bind(id).first();

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

            // Delete keyword (message_tags will be cascade deleted)
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

    // Reprocess all messages for a specific keyword
    router.post('/api/keywords/:id/reprocess', async (request, env, ctx) => {
        const authResponse = await handleAuth0(request, env, ctx);
        if (authResponse) return authResponse;
        await enrichUserPermissions(request, env, ctx);
        const permResponse = await requirePermission('keywords.write')(request, env, ctx);
        if (permResponse) return permResponse;
        
        const { id } = request.params;
        
        try {
            // Get the keyword
            const keyword = await env.DB.prepare(
                'SELECT * FROM keyword_tags WHERE id = ?'
            ).bind(id).first();
            
            if (!keyword) {
                return new Response(JSON.stringify({ error: 'Keyword not found' }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            
            // Clear existing tags for this keyword
            await env.DB.prepare(
                'DELETE FROM message_tags WHERE keyword_tag_id = ?'
            ).bind(id).run();
            
            // Reprocess all messages
            await processExistingMessages(env.DB, keyword.id, keyword.keyword, keyword.case_sensitive, keyword.whole_word);
            
            // Get count of processed tags
            const { results } = await env.DB.prepare(
                'SELECT COUNT(*) as count FROM message_tags WHERE keyword_tag_id = ?'
            ).bind(id).all();
            
            return new Response(JSON.stringify({ 
                success: true,
                keyword: keyword.keyword,
                tags_created: results[0].count
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Error reprocessing keyword:', error);
            return new Response(JSON.stringify({ error: 'Failed to reprocess keyword' }), {
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

/**
 * Process existing messages to find keyword matches
 */
async function processExistingMessages(db, keywordId, keyword, caseSensitive, wholeWord) {
    try {
        console.log(`[processExistingMessages] Processing keyword "${keyword}" (ID: ${keywordId})`);
        
        // Get all messages
        const { results: messages } = await db.prepare(
            'SELECT id, content FROM messages'
        ).all();
        
        console.log(`[processExistingMessages] Found ${messages.length} messages to process`);

        const batch = [];
        let messageCount = 0;
        
        for (const message of messages) {
            const matches = findKeywordMatches(message.content, keyword, caseSensitive, wholeWord);
            if (matches.length > 0) {
                messageCount++;
                if (/[一-龥]/.test(keyword)) {
                    console.log(`[processExistingMessages] Chinese keyword "${keyword}" found ${matches.length} matches in message ${message.id}`);
                }
            }
            for (const match of matches) {
                batch.push({
                    message_id: message.id,
                    keyword_tag_id: keywordId,
                    matched_text: match.text,
                    position: match.position
                });
            }
        }

        // Insert matches in batches
        if (batch.length > 0) {
            console.log(`[processExistingMessages] Inserting ${batch.length} tags for keyword "${keyword}" in ${messageCount} messages`);
            const batchSize = 100;
            for (let i = 0; i < batch.length; i += batchSize) {
                const currentBatch = batch.slice(i, i + batchSize);
                const placeholders = currentBatch.map(() => '(?, ?, ?, ?)').join(',');
                const values = currentBatch.flatMap(b => [b.message_id, b.keyword_tag_id, b.matched_text, b.position]);
                
                await db.prepare(`
                    INSERT OR IGNORE INTO message_tags (message_id, keyword_tag_id, matched_text, position)
                    VALUES ${placeholders}
                `).bind(...values).run();
            }
            console.log(`[processExistingMessages] Successfully inserted tags for keyword "${keyword}"`);
        } else {
            console.log(`[processExistingMessages] No matches found for keyword "${keyword}"`);
        }
    } catch (error) {
        console.error('Error processing existing messages:', error);
    }
}

/**
 * Find keyword matches in text
 */
export function findKeywordMatches(text, keyword, caseSensitive = false, wholeWord = false) {
    const matches = [];
    
    if (!text || !keyword) return matches;
    
    let searchText = caseSensitive ? text : text.toLowerCase();
    let searchKeyword = caseSensitive ? keyword : keyword.toLowerCase();
    
    if (wholeWord) {
        // Create word boundary regex
        const wordBoundary = `\\b${escapeRegex(searchKeyword)}\\b`;
        const regex = new RegExp(wordBoundary, caseSensitive ? 'g' : 'gi');
        
        let match;
        while ((match = regex.exec(text)) !== null) {
            matches.push({
                text: match[0],
                position: match.index
            });
        }
    } else {
        // Simple substring search
        let position = 0;
        while ((position = searchText.indexOf(searchKeyword, position)) !== -1) {
            matches.push({
                text: text.substr(position, keyword.length),
                position: position
            });
            position += keyword.length;
        }
    }
    
    return matches;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
