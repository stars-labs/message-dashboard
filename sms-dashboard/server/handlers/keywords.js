// Keyword/Tag management handler
export const keywordsHandler = {
  // List all keywords
  async list(request) {
    const { env } = request;
    
    try {
      const keywords = await env.DB.prepare(`
        SELECT 
          id,
          keyword,
          tag,
          color,
          priority,
          is_active,
          case_sensitive,
          whole_word,
          usage_count,
          created_at,
          updated_at
        FROM keyword_tags
        ORDER BY priority DESC, keyword ASC
      `).all();
      
      return new Response(JSON.stringify({
        success: true,
        data: keywords.results || keywords
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[Keywords] List error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch keywords'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Get a specific keyword
  async get(request) {
    const { env, params } = request;
    const { id } = params;
    
    try {
      const keyword = await env.DB.prepare(`
        SELECT * FROM keyword_tags WHERE id = ?
      `).bind(id).first();
      
      if (!keyword) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Keyword not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(JSON.stringify({
        success: true,
        data: keyword
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[Keywords] Get error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch keyword'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Create a new keyword
  async create(request) {
    const { env, user } = request;
    const data = await request.json();
    
    try {
      const { keyword, tag, color, priority, case_sensitive, whole_word, is_active = true } = data;
      
      if (!keyword || !tag) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Keyword and tag are required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Check for duplicates
      const existing = await env.DB.prepare(`
        SELECT id FROM keyword_tags WHERE keyword = ?
      `).bind(keyword).first();
      
      if (existing) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Keyword already exists'
        }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Generate ID
      const id = crypto.randomUUID();
      
      // Insert keyword
      await env.DB.prepare(`
        INSERT INTO keyword_tags (
          id, keyword, tag, color, priority, is_active, 
          case_sensitive, whole_word, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(
        id,
        keyword,
        tag,
        color || '#3B82F6',
        priority || 0,
        is_active ? 1 : 0,
        case_sensitive ? 1 : 0,
        whole_word ? 1 : 0,
        user?.email || 'system'
      ).run();
      
      // Return created keyword
      const created = await env.DB.prepare(`
        SELECT * FROM keyword_tags WHERE id = ?
      `).bind(id).first();
      
      return new Response(JSON.stringify({
        success: true,
        data: created
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[Keywords] Create error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to create keyword'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Update a keyword
  async update(request) {
    const { env, params, user } = request;
    const { id } = params;
    const data = await request.json();
    
    try {
      const { keyword, tag, color, priority, case_sensitive, whole_word, is_active } = data;
      
      // Check if keyword exists
      const existing = await env.DB.prepare(`
        SELECT id FROM keyword_tags WHERE id = ?
      `).bind(id).first();
      
      if (!existing) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Keyword not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Update keyword
      await env.DB.prepare(`
        UPDATE keyword_tags SET
          keyword = ?,
          tag = ?,
          color = ?,
          priority = ?,
          is_active = ?,
          case_sensitive = ?,
          whole_word = ?,
          updated_at = CURRENT_TIMESTAMP,
          updated_by = ?
        WHERE id = ?
      `).bind(
        keyword,
        tag,
        color,
        priority || 0,
        is_active !== false ? 1 : 0,
        case_sensitive ? 1 : 0,
        whole_word ? 1 : 0,
        user?.email || 'system',
        id
      ).run();
      
      // Return updated keyword
      const updated = await env.DB.prepare(`
        SELECT * FROM keyword_tags WHERE id = ?
      `).bind(id).first();
      
      return new Response(JSON.stringify({
        success: true,
        data: updated
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[Keywords] Update error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to update keyword'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Delete a keyword
  async delete(request) {
    const { env, params } = request;
    const { id } = params;
    
    try {
      // Delete associated message tags first
      await env.DB.prepare(`
        DELETE FROM message_tags WHERE keyword_tag_id = ?
      `).bind(id).run();
      
      // Delete keyword
      await env.DB.prepare(`
        DELETE FROM keyword_tags WHERE id = ?
      `).bind(id).run();
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Keyword deleted successfully'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[Keywords] Delete error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to delete keyword'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Get tags for a specific message
  async getMessageTags(request) {
    const { env, params } = request;
    const { id } = params;
    
    try {
      const tags = await env.DB.prepare(`
        SELECT 
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
        WHERE mt.message_id = ?
        ORDER BY mt.position ASC
      `).bind(id).all();
      
      return new Response(JSON.stringify({
        success: true,
        tags: tags.results || tags
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[Keywords] Get message tags error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch message tags'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // NEW: Batch get tags for multiple messages
  async getBatchMessageTags(request) {
    const { env } = request;
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
      // Limit to prevent abuse
      const limitedIds = messageIds.slice(0, 100);
      const placeholders = limitedIds.map(() => '?').join(',');
      
      const tags = await env.DB.prepare(`
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
      const tagResults = tags.results || tags || [];
      for (const tag of tagResults) {
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
      console.error('[Keywords] Batch get message tags error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch message tags'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Reprocess messages for a specific keyword
  async reprocessKeyword(request) {
    const { env, params } = request;
    const { id } = params;
    
    try {
      // Get the keyword
      const keyword = await env.DB.prepare(`
        SELECT * FROM keyword_tags WHERE id = ?
      `).bind(id).first();
      
      if (!keyword) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Keyword not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Delete existing tags for this keyword
      await env.DB.prepare(`
        DELETE FROM message_tags WHERE keyword_tag_id = ?
      `).bind(id).run();
      
      // Get all messages
      const messages = await env.DB.prepare(`
        SELECT id, content FROM messages
        WHERE content IS NOT NULL AND content != ''
        ORDER BY timestamp DESC
        LIMIT 1000
      `).all();
      
      // Process messages
      let processed = 0;
      for (const message of (messages.results || messages)) {
        const matches = findKeywordMatches(message.content, keyword);
        for (const match of matches) {
          await env.DB.prepare(`
            INSERT INTO message_tags (message_id, keyword_tag_id, matched_text, position)
            VALUES (?, ?, ?, ?)
          `).bind(message.id, id, match.text, match.position).run();
        }
        processed++;
      }
      
      // Update usage count
      await env.DB.prepare(`
        UPDATE keyword_tags 
        SET usage_count = (
          SELECT COUNT(DISTINCT message_id) 
          FROM message_tags 
          WHERE keyword_tag_id = ?
        ),
        updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(id, id).run();
      
      return new Response(JSON.stringify({
        success: true,
        processed
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[Keywords] Reprocess error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to reprocess keyword'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

// Helper function to find keyword matches in text
function findKeywordMatches(text, keyword) {
  const matches = [];
  if (!text || !keyword.keyword) return matches;
  
  const searchText = keyword.case_sensitive ? text : text.toLowerCase();
  const searchKeyword = keyword.case_sensitive ? keyword.keyword : keyword.keyword.toLowerCase();
  
  if (keyword.whole_word) {
    // Whole word matching
    const regex = new RegExp(`\\b${escapeRegExp(searchKeyword)}\\b`, keyword.case_sensitive ? 'g' : 'gi');
    let match;
    while ((match = regex.exec(text)) !== null) {
      matches.push({
        position: match.index,
        text: match[0],
        length: match[0].length
      });
    }
  } else {
    // Substring matching
    let pos = 0;
    while ((pos = searchText.indexOf(searchKeyword, pos)) !== -1) {
      matches.push({
        position: pos,
        text: text.substr(pos, searchKeyword.length),
        length: searchKeyword.length
      });
      pos += searchKeyword.length;
    }
  }
  
  return matches;
}

// Helper function to escape regex special characters
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
