import { nanoid } from 'nanoid';

// AI Models configuration
const AI_MODELS = {
  TEXT_GENERATION: '@cf/meta/llama-4-scout-17b-16e-instruct',
  TEXT_CLASSIFICATION: '@cf/huggingface/distilbert-sst-2-int8',
  EMBEDDINGS: '@cf/baai/bge-base-en-v1.5',
  TRANSLATION: '@cf/meta/m2m100-1.2b'
};

// Ensure keyword tables exist
async function ensureKeywordTables(db) {
    // Create keyword_tags table
    await db.prepare(`
        CREATE TABLE IF NOT EXISTS keyword_tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            keyword TEXT NOT NULL,
            tag TEXT NOT NULL,
            color TEXT DEFAULT '#3B82F6',
            priority INTEGER DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE,
            case_sensitive BOOLEAN DEFAULT FALSE,
            whole_word BOOLEAN DEFAULT FALSE,
            created_by TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        )
    `).run();
    
    // Create message_tags table
    await db.prepare(`
        CREATE TABLE IF NOT EXISTS message_tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL,
            keyword_tag_id INTEGER NOT NULL,
            matched_text TEXT NOT NULL,
            position INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
            FOREIGN KEY (keyword_tag_id) REFERENCES keyword_tags(id) ON DELETE CASCADE,
            UNIQUE(message_id, keyword_tag_id, position)
        )
    `).run();
    
    // Create indexes
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_keyword_tags_keyword ON keyword_tags(keyword)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_keyword_tags_active ON keyword_tags(is_active)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_keyword_tags_priority ON keyword_tags(priority)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_message_tags_message ON message_tags(message_id)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_message_tags_keyword ON message_tags(keyword_tag_id)`).run();
}

export const aiHandler = {
  // Extract verification code with AI
  async extractCode(request) {
    const { env } = request;
    
    try {
      const { content, message_id } = await request.json();
      
      if (!content) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Message content is required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // AI prompt for code extraction
      const prompt = `Extract any verification code, OTP, PIN, or authentication code from this message.
      
Message: "${content}"

Return ONLY a JSON object with this exact format:
{
  "code": "extracted code or null",
  "type": "otp|2fa|verification|pin|null",
  "service": "detected service name or null",
  "expires_in": "expiration time if mentioned or null",
  "confidence": 0.0-1.0
}

Examples:
- "Your Google verification code is 123456" → {"code": "123456", "type": "verification", "service": "Google", "confidence": 0.95}
- "您的验证码是 888888，5分钟内有效" → {"code": "888888", "type": "verification", "expires_in": "5 minutes", "confidence": 0.95}
- "Use 4321 to login to Facebook" → {"code": "4321", "type": "otp", "service": "Facebook", "confidence": 0.9}
- "Thanks for your order!" → {"code": null, "type": null, "service": null, "confidence": 1.0}`;

      const response = await env.AI.run(AI_MODELS.TEXT_GENERATION, {
        prompt,
        max_tokens: 150,
        temperature: 0.1
      });

      let result;
      try {
        result = JSON.parse(response.response);
      } catch (e) {
        console.error('Failed to parse AI response:', response.response);
        result = { code: null, type: null, confidence: 0 };
      }

      // Update message with AI-extracted code if message_id provided
      if (message_id && result.code) {
        await env.DB.prepare(`
          UPDATE messages 
          SET ai_verification_code = ?, ai_confidence = ?, ai_processed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(result.code, result.confidence, message_id).run();

        // Also store detailed insights
        await env.DB.prepare(`
          INSERT OR REPLACE INTO ai_insights (
            message_id, verification_code, confidence_score, 
            sender_category, extracted_at
          ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(
          message_id, 
          result.code, 
          result.confidence,
          result.service
        ).run();
      }

      return new Response(JSON.stringify({
        success: true,
        data: result
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('AI code extraction error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to extract verification code'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Classify message type and content
  async classifyMessage(request) {
    const { env } = request;
    
    try {
      const { content, message_id } = await request.json();
      
      if (!content) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Message content is required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const prompt = `Analyze this SMS message and provide detailed classification.

Message: "${content}"

Return a JSON object with:
{
  "type": "verification|marketing|personal|transaction|delivery|spam|notification",
  "is_spam": boolean,
  "urgency": "high|medium|low",
  "language": "ISO language code (en, zh, es, etc)",
  "sender_type": "bank|social|ecommerce|delivery|telecom|government|unknown",
  "contains_link": boolean,
  "sentiment": "positive|neutral|negative",
  "summary": "Brief summary in 10 words or less"
}`;

      const response = await env.AI.run(AI_MODELS.TEXT_GENERATION, {
        prompt,
        max_tokens: 200,
        temperature: 0.1
      });

      let classification;
      try {
        classification = JSON.parse(response.response);
      } catch (e) {
        console.error('Failed to parse classification:', response.response);
        classification = {
          type: 'unknown',
          is_spam: false,
          urgency: 'low',
          language: 'en'
        };
      }

      // Update message classification if message_id provided
      if (message_id) {
        await env.DB.prepare(`
          UPDATE messages 
          SET ai_classification = ?, ai_processed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(classification.type, message_id).run();

        // Store detailed insights
        await env.DB.prepare(`
          INSERT OR REPLACE INTO ai_insights (
            message_id, classification, is_spam, urgency, 
            language, sender_category, extracted_at
          ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(
          message_id,
          classification.type,
          classification.is_spam ? 1 : 0,
          classification.urgency,
          classification.language,
          classification.sender_type
        ).run();
      }

      return new Response(JSON.stringify({
        success: true,
        data: classification
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Message classification error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to classify message'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Generate message embedding for semantic search
  async generateEmbedding(request) {
    const { env } = request;
    
    try {
      const { content, message_id } = await request.json();
      
      if (!content) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Message content is required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Generate embedding
      const embeddingResponse = await env.AI.run(AI_MODELS.EMBEDDINGS, {
        text: content
      });

      const embedding = embeddingResponse.data[0];

      // Store in Vectorize if message_id provided
      if (message_id && env.VECTORIZE) {
        const message = await env.DB.prepare(
          'SELECT phone_iccid, timestamp, type FROM messages WHERE id = ?'
        ).bind(message_id).first();

        if (message) {
          await env.VECTORIZE.upsert([{
            id: message_id,
            values: embedding,
            metadata: {
              phone_id: message.phone_iccid,
              timestamp: message.timestamp,
              type: message.type
            }
          }]);

          // Also store in database for backup
          await env.DB.prepare(`
            INSERT OR REPLACE INTO message_embeddings (
              message_id, embedding, model_version, created_at
            ) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          `).bind(
            message_id,
            JSON.stringify(embedding),
            AI_MODELS.EMBEDDINGS
          ).run();
        }
      }

      return new Response(JSON.stringify({
        success: true,
        data: {
          embedding: embedding,
          dimensions: embedding.length
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Embedding generation error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to generate embedding'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Semantic search using embeddings with robust fallback
  async search(request) {
    const { env } = request;
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const phoneId = url.searchParams.get('phone_id');
    
    try {
      if (!query) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Search query is required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Try AI-powered search first if available
      let messages = [];
      let searchIntent = null;
      let useAI = false;

      try {
        if (env.AI && env.VECTORIZE) {
          // First, understand the search intent
          const intentPrompt = `Analyze this search query and extract search parameters:
Query: "${query}"

Return JSON with:
{
  "type": "verification|transaction|personal|all",
  "has_code": boolean,
  "time_range": "today|week|month|all",
  "sender_hint": "bank|social|ecommerce|delivery|any",
  "keywords": ["important", "terms"]
}`;

          const intentResponse = await env.AI.run(AI_MODELS.TEXT_GENERATION, {
            prompt: intentPrompt,
            max_tokens: 150,
            temperature: 0.1
          });

          try {
            searchIntent = JSON.parse(intentResponse.response);
          } catch (e) {
            searchIntent = { type: 'all', keywords: [query] };
          }

          // Generate embedding for the query
          const queryEmbedding = await env.AI.run(AI_MODELS.EMBEDDINGS, {
            text: query
          });

          // Build filter for Vectorize
          const filter = {};
          if (phoneId) {
            filter.phone_id = phoneId;
          }
          if (searchIntent.type !== 'all') {
            filter.type = searchIntent.type;
          }

          // Perform vector search
          const searchResults = await env.VECTORIZE.query(
            queryEmbedding.data[0],
            {
              topK: limit,
              filter: filter
            }
          );
          
          const vectorResults = searchResults.matches || [];
          const messageIds = vectorResults.map(r => r.id);
          
          if (messageIds.length > 0) {
            const placeholders = messageIds.map(() => '?').join(',');
            const messagesResult = await env.DB.prepare(`
              SELECT m.*, 
                     ai.classification, 
                     ai.verification_code as ai_verification_code,
                     ai.confidence_score,
                     ai.sender_category
              FROM messages m
              LEFT JOIN ai_insights ai ON m.id = ai.message_id
              WHERE m.id IN (${placeholders})
              ORDER BY m.timestamp DESC
            `).bind(...messageIds).all();
            
            messages = messagesResult.results || [];
            useAI = true;
          }
        }
      } catch (aiError) {
        console.log('AI search not available, falling back to text search:', aiError.message);
      }

      // If AI search didn't work or returned no results, use text-based fallback
      if (messages.length === 0) {
        console.log('Using fallback text-based search for query:', query);
        
        // Parse common search patterns
        const lowerQuery = query.toLowerCase();
        const isVerificationSearch = lowerQuery.includes('验证码') || 
                                    lowerQuery.includes('verification') || 
                                    lowerQuery.includes('code') ||
                                    lowerQuery.includes('otp');
        
        const isAllSearch = lowerQuery.includes('所有') || 
                            lowerQuery.includes('all');

        // Build the SQL query based on search intent
        let sqlQuery;
        let params = [];
        
        if (isVerificationSearch) {
          // Search for verification codes
          sqlQuery = `
            SELECT m.*, 
                   ai.classification, 
                   ai.verification_code as ai_verification_code,
                   ai.confidence_score,
                   ai.sender_category
            FROM messages m
            LEFT JOIN ai_insights ai ON m.id = ai.message_id
            WHERE (
              m.content LIKE '%验证码%' OR 
              m.content LIKE '%verification%' OR 
              m.content LIKE '%OTP%' OR
              m.content LIKE '%code%' OR
              m.content REGEXP '[0-9]{4,8}' OR
              ai.verification_code IS NOT NULL
            )
            ${phoneId ? 'AND m.phone_iccid = ?' : ''}
            ORDER BY m.timestamp DESC
            LIMIT ?
          `;
          
          if (phoneId) params.push(phoneId);
          params.push(limit);
        } else {
          // General text search
          const searchTerms = query.split(/\s+/).filter(term => term.length > 0);
          const whereConditions = searchTerms.map(() => 
            'LOWER(m.content) LIKE ?'
          ).join(' AND ');
          
          sqlQuery = `
            SELECT m.*, 
                   ai.classification, 
                   ai.verification_code as ai_verification_code,
                   ai.confidence_score,
                   ai.sender_category
            FROM messages m
            LEFT JOIN ai_insights ai ON m.id = ai.message_id
            WHERE ${whereConditions || '1=1'}
            ${phoneId ? 'AND m.phone_iccid = ?' : ''}
            ORDER BY m.timestamp DESC
            LIMIT ?
          `;
          
          // Add search term parameters
          searchTerms.forEach(term => {
            params.push(`%${term.toLowerCase()}%`);
          });
          if (phoneId) params.push(phoneId);
          params.push(limit);
        }
        
        const result = await env.DB.prepare(sqlQuery).bind(...params).all();
        messages = result.results || [];
        
        // Also add a simpler fallback for finding any recent messages if nothing found
        if (messages.length === 0 && isAllSearch) {
          const allMessagesQuery = `
            SELECT m.*, 
                   ai.classification, 
                   ai.verification_code as ai_verification_code,
                   ai.confidence_score,
                   ai.sender_category
            FROM messages m
            LEFT JOIN ai_insights ai ON m.id = ai.message_id
            ${phoneId ? 'WHERE m.phone_iccid = ?' : ''}
            ORDER BY m.timestamp DESC
            LIMIT ?
          `;
          
          const allParams = phoneId ? [phoneId, limit] : [limit];
          const allResult = await env.DB.prepare(allMessagesQuery).bind(...allParams).all();
          messages = allResult.results || [];
        }
      }

      return new Response(JSON.stringify({
        success: true,
        data: {
          messages,
          search_intent: searchIntent,
          total: messages.length,
          search_method: useAI ? 'ai' : 'text'
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Search error:', error);
      
      // Last resort - return recent messages
      try {
        const fallbackQuery = `
          SELECT m.*, 
                 ai.classification, 
                 ai.verification_code as ai_verification_code,
                 ai.confidence_score,
                 ai.sender_category
          FROM messages m
          LEFT JOIN ai_insights ai ON m.id = ai.message_id
          ${phoneId ? 'WHERE m.phone_iccid = ?' : ''}
          ORDER BY m.timestamp DESC
          LIMIT ?
        `;
        
        const params = phoneId ? [phoneId, limit] : [limit];
        const result = await env.DB.prepare(fallbackQuery).bind(...params).all();
        
        return new Response(JSON.stringify({
          success: true,
          data: {
            messages: result.results || [],
            search_intent: null,
            total: result.results?.length || 0,
            search_method: 'fallback',
            note: 'Search functionality limited, showing recent messages'
          }
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (fallbackError) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Search service unavailable'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  },

  // Get AI insights for a phone
  async getInsights(request) {
    const { env } = request;
    const phoneId = request.params.phone_id;
    
    try {
      // Get message statistics - filter out system/carrier messages
      const stats = await env.DB.prepare(`
        SELECT 
          COUNT(*) as total_messages,
          COUNT(CASE WHEN m.type = 'received' THEN 1 END) as received,
          COUNT(CASE WHEN m.type = 'sent' THEN 1 END) as sent,
          COUNT(CASE WHEN m.ai_verification_code IS NOT NULL THEN 1 END) as verification_codes,
          COUNT(CASE WHEN ai.is_spam = 1 THEN 1 END) as spam_count
        FROM messages m
        LEFT JOIN ai_insights ai ON m.id = ai.message_id
        WHERE m.phone_iccid = ?
        AND (m.phone_number IS NULL OR m.phone_number NOT LIKE '#%')
      `).bind(phoneId).first();
      
      // Also get recent stats for the AI summary
      const recentStats = await env.DB.prepare(`
        SELECT 
          COUNT(*) as recent_messages,
          COUNT(CASE WHEN m.type = 'received' THEN 1 END) as recent_received,
          COUNT(CASE WHEN m.ai_verification_code IS NOT NULL THEN 1 END) as recent_codes
        FROM messages m
        WHERE m.phone_iccid = ?
        AND m.timestamp > datetime('now', '-7 days')
        AND (m.phone_number IS NULL OR m.phone_number NOT LIKE '#%')
      `).bind(phoneId).first();

      console.log('[AI Insights] Stats for phone', phoneId, ':', JSON.stringify(stats));

      // Get recent verification codes
      const recentCodes = await env.DB.prepare(`
        SELECT 
          m.id,
          m.content,
          m.timestamp,
          ai.verification_code as code,
          ai.sender_category as service,
          ai.confidence_score
        FROM messages m
        INNER JOIN ai_insights ai ON m.id = ai.message_id
        WHERE m.phone_iccid = ?
        AND ai.verification_code IS NOT NULL
        AND (m.phone_number IS NULL OR m.phone_number NOT LIKE '#%')
        ORDER BY m.timestamp DESC
        LIMIT 10
      `).bind(phoneId).all();

      // Get message categories breakdown
      const categories = await env.DB.prepare(`
        SELECT 
          ai.classification as category,
          COUNT(*) as count
        FROM messages m
        INNER JOIN ai_insights ai ON m.id = ai.message_id
        WHERE m.phone_iccid = ?
        AND m.timestamp > datetime('now', '-7 days')
        AND (m.phone_number IS NULL OR m.phone_number NOT LIKE '#%')
        GROUP BY ai.classification
        ORDER BY count DESC
      `).bind(phoneId).all();

      console.log('[AI Insights] Recent codes count:', recentCodes.results?.length || 0);
      console.log('[AI Insights] Categories count:', categories.results?.length || 0);

      // Generate AI summary (handle case where no AI processing has been done)
      let aiSummary = '';
      
      if (stats.total_messages === 0) {
        aiSummary = 'No messages found for this phone.';
      } else if (recentStats.recent_messages === 0) {
        aiSummary = `This phone has ${stats.total_messages} total message${stats.total_messages > 1 ? 's' : ''} (${stats.received} received, ${stats.sent} sent), but no recent activity in the last 7 days.`;
      } else if (stats.verification_codes === 0 && (!categories.results || categories.results.length === 0)) {
        // No AI processing has been done yet
        aiSummary = `This phone has ${stats.total_messages} total message${stats.total_messages > 1 ? 's' : ''} (${recentStats.recent_messages} in the last 7 days). AI analysis is pending - run batch processing to get detailed insights about verification codes and message categorization.`;
      } else {
        try {
          // Normal AI-processed summary
          const topCategories = categories.results ? categories.results.slice(0, 3) : [];
          const summaryPrompt = `Based on these SMS statistics:
- Total messages all-time: ${stats.total_messages} (${stats.received} received, ${stats.sent} sent)
- Recent messages (last 7 days): ${recentStats.recent_messages} (${recentStats.recent_received} received)
- Total verification codes: ${stats.verification_codes}
- Recent verification codes: ${recentStats.recent_codes}
- Spam messages: ${stats.spam_count}
${topCategories.length > 0 ? `- Top categories (recent): ${topCategories.map(c => `${c.category} (${c.count})`).join(', ')}` : ''}

Provide a brief insight summary (2-3 sentences) about the messaging patterns and any notable observations.`;

          console.log('[AI Insights] Generating AI summary with prompt:', summaryPrompt);

          const summaryResponse = await env.AI.run(AI_MODELS.TEXT_GENERATION, {
            prompt: summaryPrompt,
            max_tokens: 100,
            temperature: 0.3
          });
          
          aiSummary = summaryResponse.response;
          console.log('[AI Insights] AI summary generated:', aiSummary);
        } catch (aiError) {
          console.error('[AI Insights] AI summary generation failed:', aiError);
          // Fallback to basic summary without AI
          aiSummary = `This phone has ${stats.total_messages} total message${stats.total_messages > 1 ? 's' : ''} (${stats.received} received, ${stats.sent} sent). Recent activity: ${recentStats.recent_messages} messages in the last 7 days. ${stats.verification_codes > 0 ? `${stats.verification_codes} verification code${stats.verification_codes > 1 ? 's' : ''} detected overall.` : ''}`;
        }
      }

      return new Response(JSON.stringify({
        success: true,
        data: {
          stats,
          recent_codes: recentCodes.results || [],
          categories: categories.results || [],
          ai_summary: aiSummary,
          generated_at: new Date().toISOString()
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Get insights error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to generate insights'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Generate smart reply suggestion
  async suggestReply(request) {
    const { env } = request;
    
    try {
      const { message_content, context, tone = 'professional' } = await request.json();
      
      if (!message_content) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Message content is required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const prompt = `Generate an appropriate SMS reply for this message:

Received message: "${message_content}"
${context ? `Context: ${context}` : ''}
Tone: ${tone}

Requirements:
- Keep under 160 characters
- Be concise and appropriate
- Match the language of the received message
- If it's a verification code, acknowledge receipt
- If it's spam, politely decline

Generate 3 different reply options.`;

      const response = await env.AI.run(AI_MODELS.TEXT_GENERATION, {
        prompt,
        max_tokens: 300,
        temperature: 0.7
      });

      // Parse the response to extract suggestions
      const suggestions = response.response
        .split('\n')
        .filter(line => line.trim())
        .slice(0, 3)
        .map(line => line.replace(/^\d+\.\s*/, '').trim());

      return new Response(JSON.stringify({
        success: true,
        data: {
          suggestions,
          tone,
          generated_at: new Date().toISOString()
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Suggest reply error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to generate reply suggestions'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Batch process existing messages with AI
  async batchProcessMessages(request) {
    const { env } = request;
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '100');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    
    try {
      // Get unprocessed messages
      const messages = await env.DB.prepare(`
        SELECT m.* 
        FROM messages m
        LEFT JOIN ai_insights ai ON m.id = ai.message_id
        WHERE ai.message_id IS NULL
        AND m.content IS NOT NULL
        AND m.content != ''
        ORDER BY m.timestamp DESC
        LIMIT ? OFFSET ?
      `).bind(limit, offset).all();

      const results = {
        processed: 0,
        failed: 0,
        verification_codes_found: 0,
        messages: []
      };

      for (const message of messages) {
        try {
          // Extract verification code
          const codePrompt = `Extract any verification code, OTP, PIN, or authentication code from this message.
          
Message: "${message.content}"

Return ONLY a JSON object with this exact format:
{
  "code": "extracted code or null",
  "type": "otp|2fa|verification|pin|null",
  "service": "detected service name or null",
  "expires_in": "expiration time if mentioned or null",
  "confidence": 0.0-1.0
}`;

          const codeResponse = await env.AI.run(AI_MODELS.TEXT_GENERATION, {
            prompt: codePrompt,
            max_tokens: 150,
            temperature: 0.1
          });

          let codeResult;
          try {
            codeResult = JSON.parse(codeResponse.response);
          } catch (e) {
            codeResult = { code: null, type: null, confidence: 0 };
          }

          // Classify message
          const classifyPrompt = `Analyze this SMS message and provide classification.

Message: "${message.content}"

Return a JSON object with:
{
  "type": "verification|marketing|personal|transaction|delivery|spam|notification",
  "is_spam": boolean,
  "urgency": "high|medium|low",
  "language": "en|zh|es|etc",
  "sender_type": "bank|social|ecommerce|delivery|telecom|government|unknown"
}`;

          const classifyResponse = await env.AI.run(AI_MODELS.TEXT_GENERATION, {
            prompt: classifyPrompt,
            max_tokens: 150,
            temperature: 0.1
          });

          let classification;
          try {
            classification = JSON.parse(classifyResponse.response);
          } catch (e) {
            classification = {
              type: 'unknown',
              is_spam: false,
              urgency: 'low',
              language: 'en',
              sender_type: 'unknown'
            };
          }

          // Update message with AI results
          if (codeResult.code) {
            await env.DB.prepare(`
              UPDATE messages 
              SET ai_verification_code = ?, ai_confidence = ?, ai_classification = ?, ai_processed_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).bind(codeResult.code, codeResult.confidence, classification.type, message.id).run();

            results.verification_codes_found++;
          } else {
            await env.DB.prepare(`
              UPDATE messages 
              SET ai_classification = ?, ai_processed_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).bind(classification.type, message.id).run();
          }

          // Store detailed insights
          await env.DB.prepare(`
            INSERT OR REPLACE INTO ai_insights (
              message_id, classification, verification_code, confidence_score, 
              is_spam, urgency, language, sender_category, extracted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).bind(
            message.id,
            classification.type,
            codeResult.code,
            codeResult.confidence,
            classification.is_spam ? 1 : 0,
            classification.urgency,
            classification.language,
            classification.sender_type
          ).run();

          // Generate and store embedding
          const embeddingResponse = await env.AI.run(AI_MODELS.EMBEDDINGS, {
            text: message.content
          });

          const embedding = embeddingResponse.data[0];

          // Store in Vectorize
          if (env.VECTORIZE) {
            await env.VECTORIZE.upsert([{
              id: message.id,
              values: embedding,
              metadata: {
                phone_id: message.phone_iccid,
                timestamp: message.timestamp,
                type: message.type,
                classification: classification.type,
                has_code: codeResult.code !== null
              }
            }]);
          }

          // Store embedding in database
          await env.DB.prepare(`
            INSERT OR REPLACE INTO message_embeddings (
              message_id, embedding, model_version, created_at
            ) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          `).bind(
            message.id,
            JSON.stringify(embedding),
            AI_MODELS.EMBEDDINGS
          ).run();

          results.processed++;
          results.messages.push({
            id: message.id,
            verification_code: codeResult.code,
            classification: classification.type
          });

        } catch (error) {
          console.error(`Failed to process message ${message.id}:`, error);
          results.failed++;
        }
      }

      return new Response(JSON.stringify({
        success: true,
        data: results,
        has_more: messages.length === limit
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Batch processing error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to batch process messages'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Get all recent verification codes
  async getVerificationCodes(request) {
    const { env } = request;
    const url = new URL(request.url);
    const hours = parseInt(url.searchParams.get('hours') || '24');
    const phoneId = url.searchParams.get('phone_id');
    
    try {
      let query = `
        SELECT 
          m.id,
          m.phone_iccid,
          m.content,
          m.timestamp,
          ai.verification_code as code,
          ai.sender_category as service,
          ai.confidence_score,
          dv.number as phone_number
        FROM messages m
        INNER JOIN ai_insights ai ON m.id = ai.message_id
        LEFT JOIN device_view dv ON m.phone_iccid = dv.iccid
        WHERE ai.verification_code IS NOT NULL
        AND m.timestamp > datetime('now', '-' || ? || ' hours')
      `;
      
      const params = [hours];
      if (phoneId) {
        query += ' AND m.phone_iccid = ?';
        params.push(phoneId);
      }
      
      query += ' ORDER BY m.timestamp DESC';
      
      const result = await env.DB.prepare(query).bind(...params).all();

      return new Response(JSON.stringify({
        success: true,
        data: result.results,
        time_range: `last ${hours} hours`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Get verification codes error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to get verification codes'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Analyze keywords and tags for messages
  async analyzeKeywords(request) {
    const { env } = request;
    
    try {
      // Ensure keyword tables exist
      await ensureKeywordTables(env.DB);
      
      const { phone_iccid, start_date, end_date } = await request.json();
      
      // Get keyword statistics
      const query = `
        SELECT 
          kt.id,
          kt.keyword,
          kt.tag,
          kt.color,
          COUNT(DISTINCT mt.message_id) as message_count,
          COUNT(mt.matched_text) as match_count,
          GROUP_CONCAT(DISTINCT m.source) as sources
        FROM keyword_tags kt
        JOIN message_tags mt ON kt.id = mt.keyword_tag_id
        JOIN messages m ON mt.message_id = m.id
        WHERE kt.is_active = TRUE
        ${phone_iccid ? 'AND m.phone_iccid = ?' : ''}
        ${start_date ? 'AND m.timestamp >= ?' : ''}
        ${end_date ? 'AND m.timestamp <= ?' : ''}
        GROUP BY kt.id
        ORDER BY match_count DESC
      `;
      
      const params = [];
      if (phone_iccid) params.push(phone_iccid);
      if (start_date) params.push(start_date);
      if (end_date) params.push(end_date);
      
      const { results: keywordStats } = await env.DB.prepare(query).bind(...params).all();
      
      // Get recent tagged messages
      const recentQuery = `
        SELECT 
          m.id,
          m.content,
          m.timestamp,
          m.phone_iccid,
          GROUP_CONCAT(kt.tag) as tags,
          GROUP_CONCAT(kt.color) as colors
        FROM messages m
        JOIN message_tags mt ON m.id = mt.message_id
        JOIN keyword_tags kt ON mt.keyword_tag_id = kt.id
        WHERE kt.is_active = TRUE
        ${phone_iccid ? 'AND m.phone_iccid = ?' : ''}
        ${start_date ? 'AND m.timestamp >= ?' : ''}
        ${end_date ? 'AND m.timestamp <= ?' : ''}
        GROUP BY m.id
        ORDER BY m.timestamp DESC
        LIMIT 100
      `;
      
      const { results: recentTagged } = await env.DB.prepare(recentQuery).bind(...params).all();
      
      // Generate AI insights if requested
      let insights = null;
      if (keywordStats.length > 0) {
        const prompt = `Analyze these keyword statistics and provide insights:

Keyword Statistics:
${keywordStats.map(k => `- "${k.keyword}" (${k.tag}): ${k.match_count} matches in ${k.message_count} messages from ${k.sources || 'unknown'}`).join('\n')}

Recent Tagged Messages: ${recentTagged.length} messages

Provide a brief analysis including:
1. Most common keywords and their significance
2. Patterns or trends in the tagged messages
3. Recommendations for keyword optimization
4. Any unusual or noteworthy observations

Keep the response concise and actionable.`;

        try {
          const aiResponse = await env.AI.run(AI_MODELS.TEXT_GENERATION, {
            prompt,
            max_tokens: 500,
            temperature: 0.3
          });
          
          insights = aiResponse.response;
        } catch (error) {
          console.error('AI insights generation error:', error);
        }
      }
      
      return new Response(JSON.stringify({
        success: true,
        data: {
          keyword_stats: keywordStats,
          recent_tagged: recentTagged,
          insights
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error) {
      console.error('Analyze keywords error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to analyze keywords'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};