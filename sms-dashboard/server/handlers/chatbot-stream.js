import { nanoid } from 'nanoid';

// Dashboard functions that the chatbot can call
const DASHBOARD_FUNCTIONS = [
  {
    name: 'searchMessages',
    description: 'Search for messages using natural language or specific criteria',
    parameters: {
      query: 'string',
      phone_id: 'string (optional)',
      time_range: 'string (optional: today, week, month)',
      type: 'string (optional: received, sent, verification)'
    }
  },
  {
    name: 'sendSMS',
    description: 'Send an SMS message',
    parameters: {
      phone_id: 'string (ICCID of the phone to use)',
      recipient: 'string (phone number)',
      content: 'string (message content)'
    }
  },
  {
    name: 'getPhoneStatus',
    description: 'Get status of all phones or a specific phone',
    parameters: {
      phone_id: 'string (optional)'
    }
  },
  {
    name: 'getVerificationCodes',
    description: 'Get recent verification codes',
    parameters: {
      hours: 'number (optional, default 24)',
      phone_id: 'string (optional)'
    }
  },
  {
    name: 'getMessageStats',
    description: 'Get messaging statistics',
    parameters: {
      time_range: 'string (optional: today, week, month)',
      phone_id: 'string (optional)'
    }
  }
];

export const chatbotStreamHandler = {
  // Main chat streaming endpoint
  async chatStream(request) {
    const { env } = request;
    const user = request.user;
    
    // Parse request body first (can only be read once)
    let requestData;
    try {
      requestData = await request.json();
    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid JSON in request body'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Set up SSE response
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    
    // Start SSE response
    const response = new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      }
    });
    
    // Process in background
    request.ctx.waitUntil((async () => {
      try {
        const { message, conversation_id } = requestData;
        console.log('[Stream] Starting chat stream for message:', message);
        
        if (!message) {
          await writer.write(encoder.encode(`event: error\ndata: {"error": "Message is required"}\n\n`));
          await writer.close();
          return;
        }

        // Send initial acknowledgment
        await writer.write(encoder.encode(`event: start\ndata: {"conversation_id": "${conversation_id || 'new'}"}\n\n`));
        console.log('[Stream] Sent start event');

        // Get or create conversation
        let conversationId = conversation_id;
        if (!conversationId) {
          conversationId = `conv_${nanoid()}`;
          const userId = user.id || user.sub;
          console.log('[Stream] Creating conversation for user:', userId);
          await env.DB.prepare(`
            INSERT INTO chat_conversations (id, user_id, message_count)
            VALUES (?, ?, 0)
          `).bind(conversationId, userId).run();
          
          await writer.write(encoder.encode(`event: conversation\ndata: {"conversation_id": "${conversationId}"}\n\n`));
        }

        // Get conversation history
        const historyResult = await env.DB.prepare(`
          SELECT role, content, function_calls
          FROM chat_messages
          WHERE conversation_id = ?
          ORDER BY created_at DESC
          LIMIT 10
        `).bind(conversationId).all();
        
        const history = historyResult?.results || [];

        // Build context for AI
        const systemPrompt = `You are an intelligent SMS Dashboard Assistant. You help users manage their SMS messages and phones.

Current user: ${user.name || user.email}
User permissions: ${user.permissions?.join(', ') || 'standard'}

You can help with:
- Finding and searching messages (including verification codes)
- Sending SMS messages (if user has permission)
- Checking phone status and statistics
- Analyzing messaging patterns
- Answering questions about the dashboard

Available functions you can call:
${DASHBOARD_FUNCTIONS.map(f => `- ${f.name}: ${f.description}`).join('\n')}

IMPORTANT: You MUST use function calls to access real data. Never make up fake data or example responses. When a user asks about:
- Phone status: ALWAYS call getPhoneStatus()
- Verification codes: ALWAYS call getVerificationCodes()
- Messages: ALWAYS call searchMessages()
- Sending SMS: ALWAYS call sendSMS() (if permitted)
- Statistics: ALWAYS call getMessageStats()

Guidelines:
- Be helpful and concise
- Use natural, conversational language
- Ask for clarification if needed
- Respect user permissions (don't offer to send SMS if they lack permission)
- When showing verification codes, always mention when they were received
- Format responses with proper spacing and bullet points when listing items
- NEVER make up fake data - always use function calls to get real information`;

        // Build messages array for AI
        const messages = [
          { role: 'system', content: systemPrompt }
        ];

        // Add conversation history (in chronological order)
        if (history.length > 0) {
          history.reverse().forEach(msg => {
            messages.push({
              role: msg.role,
              content: msg.content
            });
          });
        }

        // Add current user message
        messages.push({ role: 'user', content: message });

        // Store user message
        await env.DB.prepare(`
          INSERT INTO chat_messages (conversation_id, role, content)
          VALUES (?, 'user', ?)
        `).bind(conversationId, message).run();

        // Get AI response with function calling
        await writer.write(encoder.encode(`event: thinking\ndata: {"status": "thinking"}\n\n`));
        
        const aiResponse = await this.getAIResponse(env, messages);
        console.log('[Stream] AI Response:', JSON.stringify(aiResponse));
        console.log('[Stream] Function calls detected:', aiResponse.function_calls ? aiResponse.function_calls.length : 0);

        // Execute any function calls
        let functionResults = [];
        if (aiResponse.function_calls && aiResponse.function_calls.length > 0) {
          await writer.write(encoder.encode(`event: functions\ndata: {"status": "calling_functions", "functions": ${JSON.stringify(aiResponse.function_calls.map(f => f.name))}}\n\n`));
          
          console.log('[Stream] Executing function calls:', JSON.stringify(aiResponse.function_calls));
          functionResults = await this.executeFunctionCalls(
            env, 
            aiResponse.function_calls, 
            user,
            conversationId
          );
          console.log('[Stream] Function results:', JSON.stringify(functionResults));
        }

        // Get final response incorporating function results
        let finalResponse = aiResponse.content;
        if (functionResults.length > 0) {
          await writer.write(encoder.encode(`event: processing\ndata: {"status": "processing_results"}\n\n`));
          console.log('[Stream] Starting response generation with function results');
          
          // Add function results to context and get final response
          const functionContext = functionResults
            .map(r => `${r.function}: ${JSON.stringify(r.result)}`)
            .join('\n');

          const finalPrompt = `Based on the function results below, provide a helpful response to the user:

Function Results:
${functionContext}

Original query: "${message}"

Provide a natural, conversational response that incorporates these results.`;

          console.log('[Stream] Final prompt for AI:', finalPrompt);

          // Stream the final response
          try {
            // Cloudflare AI doesn't support streaming yet, so we'll simulate it
            const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
              prompt: finalPrompt,
              max_tokens: 500,
              temperature: 0.7
            });

            console.log('[Stream] AI response received:', JSON.stringify(response));
            const fullResponse = response.response || '';
            console.log('[Stream] Starting to stream response, length:', fullResponse.length);
            
            // Simulate streaming by splitting into words
            const words = fullResponse.split(' ');
            for (let i = 0; i < words.length; i++) {
              const chunk = words[i] + (i < words.length - 1 ? ' ' : '');
              await writer.write(encoder.encode(`event: message\ndata: {"chunk": ${JSON.stringify(chunk)}}\n\n`));
              await new Promise(resolve => setTimeout(resolve, 30)); // Small delay for streaming effect
            }
            
            console.log('[Stream] Finished streaming response');
            finalResponse = fullResponse;
          } catch (streamError) {
            console.error('Error streaming final response:', streamError);
            // Fallback to sending the whole message at once
            await writer.write(encoder.encode(`event: message\ndata: {"chunk": ${JSON.stringify('Error generating response. Please try again.')}}\n\n`));
            finalResponse = 'Error generating response. Please try again.';
          }
        } else {
          // Stream the initial response
          const words = finalResponse.split(' ');
          for (let i = 0; i < words.length; i++) {
            const chunk = words[i] + (i < words.length - 1 ? ' ' : '');
            await writer.write(encoder.encode(`event: message\ndata: {"chunk": ${JSON.stringify(chunk)}}\n\n`));
            await new Promise(resolve => setTimeout(resolve, 50)); // Small delay for streaming effect
          }
        }

        // Store assistant response
        await env.DB.prepare(`
          INSERT INTO chat_messages (conversation_id, role, content, function_calls)
          VALUES (?, 'assistant', ?, ?)
        `).bind(
          conversationId, 
          finalResponse,
          aiResponse.function_calls ? JSON.stringify(aiResponse.function_calls) : null
        ).run();

        // Update conversation
        await env.DB.prepare(`
          UPDATE chat_conversations 
          SET last_message_at = CURRENT_TIMESTAMP, 
              message_count = message_count + 2
          WHERE id = ?
        `).bind(conversationId).run();

        // Send completion event
        await writer.write(encoder.encode(`event: done\ndata: {"status": "complete", "conversation_id": "${conversationId}"}\n\n`));
        
      } catch (error) {
        console.error('Chatbot stream error:', error);
        await writer.write(encoder.encode(`event: error\ndata: {"error": "Failed to process chat message: ${error.message}"}\n\n`));
      } finally {
        await writer.close();
      }
    })());
    
    return response;
  },

  // Get AI response with function calling
  async getAIResponse(env, messages) {
    const prompt = `${messages.map(m => `${m.role}: ${m.content}`).join('\n\n')}

assistant: Based on the conversation above, I need to determine if I should call any functions to help the user.

IMPORTANT: If the user is asking about data (phone status, messages, verification codes, statistics), I MUST call the appropriate function to get real data. I should NEVER make up example data.

If I need to call functions, I will respond with:
FUNCTION_CALLS:
functionName(param1="value1", param2="value2")

If I can answer without functions (like explaining features or greeting), I'll provide a direct response.

My response:`;

    console.log('Sending prompt to AI:', prompt);
    
    const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      prompt,
      max_tokens: 500,
      temperature: 0.1
    });
    
    console.log('AI raw response:', JSON.stringify(response));

    // Parse response for function calls
    const responseText = response.response;
    let functionCalls = null;
    let content = responseText;

    if (responseText.includes('FUNCTION_CALLS:')) {
      const parts = responseText.split('FUNCTION_CALLS:');
      content = parts[0].trim();
      const callsText = parts[1].trim();
      
      // Parse function calls
      functionCalls = this.parseFunctionCalls(callsText);
    }

    return { content, function_calls: functionCalls };
  },

  // Parse function calls from AI response
  parseFunctionCalls(callsText) {
    const calls = [];
    const lines = callsText.split('\n').filter(line => line.trim());

    for (const line of lines) {
      const match = line.match(/(\w+)\((.*)\)/);
      if (match) {
        const functionName = match[1];
        const paramsStr = match[2];
        
        // Parse parameters
        const params = {};
        if (paramsStr) {
          const paramMatches = paramsStr.matchAll(/(\w+)="([^"]*)"/g);
          for (const paramMatch of paramMatches) {
            params[paramMatch[1]] = paramMatch[2];
          }
        }

        calls.push({ name: functionName, parameters: params });
      }
    }

    return calls.length > 0 ? calls : null;
  },

  // Execute function calls (reuse from chatbot.js)
  async executeFunctionCalls(env, functionCalls, user, conversationId) {
    const results = [];

    for (const call of functionCalls) {
      const startTime = Date.now();
      let result;
      let success = true;
      let error = null;

      try {
        switch (call.name) {
          case 'searchMessages':
            result = await this.searchMessages(env, call.parameters);
            break;
          case 'sendSMS':
            // Check permission
            if (!user.permissions?.includes('messages.send')) {
              result = { error: 'You do not have permission to send messages' };
              success = false;
            } else {
              result = await this.sendSMS(env, call.parameters);
            }
            break;
          case 'getPhoneStatus':
            result = await this.getPhoneStatus(env, call.parameters);
            break;
          case 'getVerificationCodes':
            result = await this.getVerificationCodes(env, call.parameters);
            break;
          case 'getMessageStats':
            result = await this.getMessageStats(env, call.parameters);
            break;
          default:
            result = { error: `Unknown function: ${call.name}` };
            success = false;
        }
      } catch (e) {
        console.error(`Function ${call.name} error:`, e);
        result = { error: e.message };
        success = false;
        error = e.message;
      }

      const executionTime = Date.now() - startTime;

      // Log function call
      await env.DB.prepare(`
        INSERT INTO ai_function_calls (
          conversation_id, function_name, parameters, 
          result, success, error_message, execution_time_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        conversationId,
        call.name,
        JSON.stringify(call.parameters),
        JSON.stringify(result),
        success ? 1 : 0,
        error,
        executionTime
      ).run();

      results.push({
        function: call.name,
        parameters: call.parameters,
        result,
        success
      });
    }

    return results;
  },

  // Function implementations (copied from chatbot.js)
  async searchMessages(env, params) {
    const { query, phone_id, time_range, type } = params;
    
    // Build SQL query based on parameters
    let sql = `
      SELECT m.*, ai.verification_code, ai.classification
      FROM messages m
      LEFT JOIN ai_insights ai ON m.id = ai.message_id
      WHERE 1=1
    `;
    const bindings = [];

    if (query) {
      sql += ` AND m.content LIKE ?`;
      bindings.push(`%${query}%`);
    }

    if (phone_id) {
      sql += ` AND m.phone_iccid = ?`;
      bindings.push(phone_id);
    }

    if (type) {
      sql += ` AND m.type = ?`;
      bindings.push(type);
    }

    if (time_range) {
      const ranges = {
        today: "datetime('now', '-1 day')",
        week: "datetime('now', '-7 days')",
        month: "datetime('now', '-30 days')"
      };
      if (ranges[time_range]) {
        sql += ` AND m.timestamp > ${ranges[time_range]}`;
      }
    }

    sql += ` ORDER BY m.timestamp DESC LIMIT 20`;

    const queryResult = await env.DB.prepare(sql).bind(...bindings).all();
    const results = queryResult?.results || [];
    return {
      count: results.length,
      messages: results.map(m => ({
        id: m.id,
        content: m.content.substring(0, 100) + (m.content.length > 100 ? '...' : ''),
        timestamp: m.timestamp,
        type: m.type,
        verification_code: m.verification_code,
        classification: m.classification
      }))
    };
  },

  async sendSMS(env, params) {
    const { phone_id, recipient, content } = params;
    
    if (!phone_id || !recipient || !content) {
      return { error: 'Missing required parameters' };
    }

    // Check if phone exists and is active
    const phone = await env.DB.prepare(`
      SELECT * FROM device_view WHERE iccid = ? AND status IN ('registered', 'active', 'online')
    `).bind(phone_id).first();

    if (!phone) {
      return { error: 'Phone not found or not active' };
    }

    // Create message
    const messageId = `msg-sent-${nanoid()}`;
    await env.DB.prepare(`
      INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type, recipient, status)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'sent', ?, 'sending')
    `).bind(messageId, phone_id, phone.number, content, recipient).run();

    return {
      success: true,
      message_id: messageId,
      status: 'queued for sending'
    };
  },

  async getPhoneStatus(env, params) {
    const { phone_id } = params;
    
    let sql = `
      SELECT iccid, number, status, signal, carrier, country, modem_index
      FROM device_view
    `;
    const bindings = [];

    if (phone_id) {
      sql += ` WHERE iccid = ?`;
      bindings.push(phone_id);
    }

    sql += ` ORDER BY modem_index`;

    const queryResult = await env.DB.prepare(sql).bind(...bindings).all();
    const results = queryResult?.results || [];
    return {
      phones: results,
      online_count: results.filter(p => 
        ['registered', 'active', 'online'].includes(p.status)
      ).length,
      total_count: results.length
    };
  },

  async getVerificationCodes(env, params) {
    const hours = parseInt(params.hours || '24');
    const { phone_id } = params;

    let sql = `
      SELECT m.content, m.timestamp, ai.verification_code, ai.sender_category
      FROM messages m
      INNER JOIN ai_insights ai ON m.id = ai.message_id
      WHERE ai.verification_code IS NOT NULL
      AND m.timestamp > datetime('now', '-${hours} hours')
    `;
    const bindings = [];

    if (phone_id) {
      sql += ` AND m.phone_iccid = ?`;
      bindings.push(phone_id);
    }

    sql += ` ORDER BY m.timestamp DESC`;

    const queryResult = await env.DB.prepare(sql).bind(...bindings).all();
    const results = queryResult?.results || [];
    return {
      codes: results.map(r => ({
        code: r.verification_code,
        service: r.sender_category || 'Unknown',
        timestamp: r.timestamp,
        preview: r.content.substring(0, 50) + '...'
      })),
      time_range: `last ${hours} hours`
    };
  },

  async getMessageStats(env, params) {
    const { time_range, phone_id } = params;
    
    let timeClause = '';
    if (time_range) {
      const ranges = {
        today: "datetime('now', '-1 day')",
        week: "datetime('now', '-7 days')",
        month: "datetime('now', '-30 days')"
      };
      timeClause = ranges[time_range] ? `AND timestamp > ${ranges[time_range]}` : '';
    }

    let sql = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN type = 'received' THEN 1 END) as received,
        COUNT(CASE WHEN type = 'sent' THEN 1 END) as sent,
        COUNT(CASE WHEN ai_verification_code IS NOT NULL THEN 1 END) as verification_codes
      FROM messages
      WHERE 1=1 ${timeClause}
    `;
    const bindings = [];

    if (phone_id) {
      sql += ` AND phone_iccid = ?`;
      bindings.push(phone_id);
    }

    const stats = await env.DB.prepare(sql).bind(...bindings).first();
    return {
      ...stats,
      time_range: time_range || 'all time'
    };
  }
};