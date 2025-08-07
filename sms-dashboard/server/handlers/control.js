import { nanoid } from 'nanoid';
import { extractVerificationCode } from '../utils/verification';
import { aiHandler } from './ai';
import { findKeywordMatches } from '../api/keywords.js';

export const controlHandler = {
  // Upload messages from Orange Pi
  async uploadMessages(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    
    // Check against environment API key
    const expectedKey = env.API_KEY;
    
    if (!apiKey || apiKey !== expectedKey) {
      console.error(`[control.js] API key mismatch - expected: ${expectedKey?.substring(0, 8)}..., got: ${apiKey?.substring(0, 8)}...`);
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      const { messages } = await request.json();
      
      if (!Array.isArray(messages)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Messages must be an array'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Process messages in batches
      const batchSize = 50;
      let processed = 0;
      let duplicates = 0;
      const newMessages = [];
      
      // Prepare statements outside the loop for better performance
      const checkStmt = env.DB.prepare(`
        SELECT id FROM messages 
        WHERE phone_iccid = ? 
        AND content = ? 
        AND datetime(timestamp) BETWEEN datetime(?, '-10 seconds') AND datetime(?, '+10 seconds')
      `);
      
      const insertStmt = env.DB.prepare(`
        INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type, verification_code)
        VALUES (?, ?, ?, ?, ?, 'received', ?)
      `);
      
      // First, deduplicate within the entire request
      const uniqueMessages = [];
      const seen = new Set();
      
      for (const msg of messages) {
        // Create a unique key for each message
        const key = `${msg.phone_iccid}|${msg.content}|${msg.timestamp || 'no-timestamp'}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueMessages.push(msg);
        } else {
          duplicates++;
        }
      }
      
      for (let i = 0; i < uniqueMessages.length; i += batchSize) {
        const batch = uniqueMessages.slice(i, i + batchSize);
        
        const promises = batch.map(async (msg, index) => {
          const phone_iccid = msg.phone_iccid;
          
          // Validate required fields
          if (!phone_iccid) {
            console.error(`[control.js] Message ${index} missing phone_iccid:`, msg);
            throw new Error(`Message ${index} missing required field: phone_iccid`);
          }
          if (!msg.content) {
            console.error(`[control.js] Message ${index} missing content:`, msg);
            throw new Error(`Message ${index} missing required field: content`);
          }
          
          // Simple validation: Messages must come from the daemon reading actual SIM cards
          // This is the ONLY way to create 'received' messages - no fake/simulated paths
          
          const messageId = msg.id || `msg-${nanoid()}`;
          const verificationCode = extractVerificationCode(msg.content);
          // Fix timestamp - handle various formatting issues
          let timestamp = msg.timestamp || new Date().toISOString();
          
          // First handle URL-encoded + signs (convert to space temporarily for processing)
          timestamp = timestamp.replace(/\+/g, ' ');
          
          // Try to match timestamp with spaces or T separator
          const timeMatch = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})[T\s]+(\d{1,2}):(\d{1,2}):(\d{1,2})(\.\d{3})?Z?$/);
          if (timeMatch) {
            const [_, year, month, day, hours, minutes, seconds, millis] = timeMatch;
            // Pad single digits with leading zeros
            const paddedHours = hours.padStart(2, '0');
            const paddedMinutes = minutes.padStart(2, '0');
            const paddedSeconds = seconds.padStart(2, '0');
            timestamp = `${year}-${month}-${day}T${paddedHours}:${paddedMinutes}:${paddedSeconds}${millis || '.000'}Z`;
          } else {
            // Remove all remaining spaces and ensure proper format
            timestamp = timestamp.replace(/\s+/g, '');
            if (timestamp.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?$/) && !timestamp.endsWith('Z')) {
              timestamp += 'Z';
            }
          }
          
          const phoneNumber = msg.phone_number || null;
          
          // Check for duplicate using the prepared statement
          const existing = await checkStmt.bind(phone_iccid, msg.content, timestamp, timestamp).first();
          if (existing) {
            duplicates++;
            return null;
          }
          
          // Only add to newMessages if we're actually inserting it
          newMessages.push({
            id: messageId,
            phone_iccid: phone_iccid,
            phone_number: phoneNumber,
            content: msg.content,
            timestamp,
            type: 'received',
            verification_code: verificationCode
          });
          
          // Insert the message
          const result = await insertStmt.bind(
            messageId,
            phone_iccid,
            phoneNumber,
            msg.content,
            timestamp,
            verificationCode
          ).run();
          
          return result;
        });
        
        const results = await Promise.all(promises);
        // Count actual inserts (excluding nulls from duplicates)
        const inserted = results.filter(r => r !== null).length;
        processed += inserted;
      }
      
      // Process new messages with AI and keywords (async, don't wait)
      if (newMessages.length > 0) {
        // Process messages in the background
        request.ctx.waitUntil(
          Promise.all(newMessages.map(async (msg) => {
            try {
              // Process keywords first
              await processMessageKeywords(env.DB, msg);
              
              // Then process with AI if available
              if (env.AI) {
              // Extract verification code with AI
              const codeRequest = new Request('https://fake.url', {
                method: 'POST',
                body: JSON.stringify({
                  content: msg.content,
                  message_id: msg.id
                })
              });
              codeRequest.env = env;
              await aiHandler.extractCode(codeRequest);
              
              // Classify message
              const classifyRequest = new Request('https://fake.url', {
                method: 'POST',
                body: JSON.stringify({
                  content: msg.content,
                  message_id: msg.id
                })
              });
              classifyRequest.env = env;
              await aiHandler.classifyMessage(classifyRequest);
              
              // Generate embedding for search
              const embeddingRequest = new Request('https://fake.url', {
                method: 'POST',
                body: JSON.stringify({
                  content: msg.content,
                  message_id: msg.id
                })
              });
              embeddingRequest.env = env;
              await aiHandler.generateEmbedding(embeddingRequest);
              }
            } catch (error) {
              console.error(`Message processing error for message ${msg.id}:`, error);
            }
          }))
        );
      }
      
      // Messages are now picked up by polling
      
      return new Response(JSON.stringify({
        success: true,
        processed,
        duplicates,
        message: `Successfully uploaded ${processed} messages${duplicates > 0 ? `, skipped ${duplicates} duplicates` : ''}`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[control.js] Upload messages error:', error);
      console.error('[control.js] Error stack:', error.stack);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to upload messages: ' + error.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Update phone statuses from Orange Pi
  async updatePhones(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    
    // Check against environment API key
    const expectedKey = env.API_KEY;
    
    if (!apiKey || apiKey !== expectedKey) {
      console.error(`[control.js] API key mismatch - expected: ${expectedKey?.substring(0, 8)}..., got: ${apiKey?.substring(0, 8)}...`);
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      const { phones } = await request.json();
      
      // Update daemon heartbeat
      const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
      const daemonVersion = request.headers.get('X-Daemon-Version') || 'unknown';
      
      // Create daemon_health table if it doesn't exist
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS daemon_health (
          daemon_id TEXT PRIMARY KEY,
          last_heartbeat TIMESTAMP NOT NULL,
          status TEXT DEFAULT 'online',
          last_ip TEXT,
          version TEXT,
          modem_count INTEGER DEFAULT 0,
          error_count INTEGER DEFAULT 0,
          last_error TEXT,
          metadata TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
      
      // Update daemon heartbeat
      const modemCount = phones.length === 1 && phones[0].iccid === 'ALL_PHONES_OFFLINE' ? 0 : phones.length;
      const daemonStatus = modemCount === 0 ? 'warning' : 'online';
      
      // Mark phones with modem_index >= modemCount as offline (phantom records)
      if (modemCount > 0) {
        console.log(`[control.js] Marking phantom phones offline (modem_index >= ${modemCount})`);
        const phantomResult = await env.DB.prepare(`
          UPDATE phones 
          SET status = 'offline',
              signal = NULL,
              rssi = NULL,
              rsrq = NULL,
              rsrp = NULL,
              snr = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE modem_index >= ? AND status != 'offline'
        `).bind(modemCount).run();
        
        if (phantomResult.meta.changes > 0) {
          console.log(`[control.js] Marked ${phantomResult.meta.changes} phantom phones as offline`);
        }
      }
      
      await env.DB.prepare(`
        INSERT INTO daemon_health (daemon_id, last_heartbeat, status, last_ip, version, modem_count, error_count, updated_at)
        VALUES ('orange-pi-main', CURRENT_TIMESTAMP, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(daemon_id) DO UPDATE SET
          last_heartbeat = CURRENT_TIMESTAMP,
          status = excluded.status,
          last_ip = excluded.last_ip,
          version = excluded.version,
          modem_count = excluded.modem_count,
          error_count = CASE 
            WHEN excluded.status = 'online' THEN 0 
            ELSE daemon_health.error_count 
          END,
          updated_at = CURRENT_TIMESTAMP
      `).bind(daemonStatus, clientIp, daemonVersion, modemCount).run();
      
      console.log(`[control.js] Daemon heartbeat updated: status=${daemonStatus}, modems=${modemCount}, ip=${clientIp}`);
      
      if (!Array.isArray(phones)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Phones must be an array'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Special case: mark all phones as offline when no modems found
      if (phones.length === 1 && phones[0].iccid === 'ALL_PHONES_OFFLINE') {
        console.log('[control.js] No modems found - marking all phones as offline');
        
        // Update all phones to offline status
        const updateStmt = env.DB.prepare(`
          UPDATE phones 
          SET status = 'offline', 
              signal = NULL,
              rssi = NULL,
              rsrq = NULL,
              rsrp = NULL,
              snr = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE status != 'offline'
        `);
        
        const result = await updateStmt.run();
        console.log(`[control.js] Marked ${result.meta.changes} phones as offline`);
        
        // Get all offline phones to broadcast
        const offlinePhones = await env.DB.prepare(`
          SELECT * FROM phones WHERE status = 'offline'
        `).all();
        
        // Broadcast phone updates to all connected clients
        const ws = env.WEBSOCKET_HANDLER.get(env.WEBSOCKET_HANDLER.idFromName('broadcast'));
        await ws.fetch('http://internal/broadcast', {
          method: 'POST',
          body: JSON.stringify({
            type: 'phone_update',
            data: offlinePhones.results
          })
        });
        
        return new Response(JSON.stringify({
          success: true,
          message: `Marked ${result.meta.changes} phones as offline`,
          daemon_status: 'warning'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Update phones using ICCID as primary key
      const stmt = env.DB.prepare(`
        INSERT INTO phones (iccid, number, country, flag, carrier, status, signal, rssi, rsrq, rsrp, snr, operator_name, operator_id, imei, access_tech, modem_index, sim_index)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(iccid) DO UPDATE SET
          number = COALESCE(excluded.number, phones.number),
          carrier = COALESCE(excluded.carrier, phones.carrier),
          status = excluded.status,
          signal = COALESCE(excluded.signal, phones.signal),
          rssi = COALESCE(excluded.rssi, phones.rssi),
          rsrq = COALESCE(excluded.rsrq, phones.rsrq),
          rsrp = COALESCE(excluded.rsrp, phones.rsrp),
          snr = COALESCE(excluded.snr, phones.snr),
          operator_name = COALESCE(excluded.operator_name, phones.operator_name),
          operator_id = COALESCE(excluded.operator_id, phones.operator_id),
          imei = COALESCE(excluded.imei, phones.imei),
          access_tech = excluded.access_tech,
          modem_index = excluded.modem_index,
          sim_index = excluded.sim_index,
          updated_at = CURRENT_TIMESTAMP
      `);
      
      // Process phones one by one for now to avoid batch issues
      let successCount = 0;
      let errorCount = 0;
      const errors = [];
      
      for (const phone of phones) {
        try {
          // Skip phones without valid ICCIDs
          if (!phone.iccid || phone.iccid.trim() === '') {
            console.log(`[control.js] Skipping phone without ICCID: number=${phone.number}, keys=${Object.keys(phone)}`);
            errorCount++;
            errors.push(`Phone without ICCID (number: ${phone.number || 'unknown'})`);
            continue;
          }
          
          // Skip phantom phones that exceed daemon's modem count
          if (phone.modem_index !== null && phone.modem_index !== undefined && phone.modem_index >= modemCount) {
            console.log(`[control.js] Skipping phantom phone with modem_index=${phone.modem_index} (>= ${modemCount}): ICCID=${phone.iccid}`);
            continue;
          }
          
          await stmt.bind(
            phone.iccid,  // ICCID is now the primary key
            phone.number || null,
            phone.country || null,
            phone.flag || null,
            phone.carrier || null,
            phone.status || 'active',
            phone.signal || null,
            phone.rssi || null,
            phone.rsrq || null,
            phone.rsrp || null,
            phone.snr || null,
            phone.operator_name || null,
            phone.operator_id || null,
            phone.imei || null,
            phone.access_tech || null,
            phone.modem_index || null,
            phone.sim_index || null
          ).run();
          successCount++;
        } catch (err) {
          errorCount++;
          errors.push({
            phone: phone.iccid || phone.number || 'unknown',
            error: err.message
          });
          console.error(`[control.js] Failed to update phone ${phone.iccid || phone.number}:`, err);
        }
      }
      
      // Filter out invalid phones before broadcasting
      const validPhones = phones.filter(phone => 
        phone.iccid && 
        phone.iccid.trim() !== '' && 
        !phone.iccid.startsWith('SIM_')
      );
      
      
      return new Response(JSON.stringify({
        success: errorCount === 0,
        updated: successCount,
        failed: errorCount,
        message: `Updated ${successCount} phones${errorCount > 0 ? `, ${errorCount} failed` : ''}`,
        errors: errors.length > 0 ? errors : undefined
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      // Update phones error
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to update phones'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Cleanup test data
  async cleanupTestData(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    const expectedKey = env.API_KEY;
    
    if (!apiKey || apiKey !== expectedKey) {
      console.error(`[control.js] API key mismatch - expected: ${expectedKey?.substring(0, 8)}..., got: ${apiKey?.substring(0, 8)}...`);
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      const { phoneIds } = await request.json();
      
      if (!Array.isArray(phoneIds)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'phoneIds must be an array'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Delete test phones by ICCID
      const placeholders = phoneIds.map(() => '?').join(',');
      const deleteStmt = env.DB.prepare(
        `DELETE FROM phones WHERE iccid IN (${placeholders})`
      );
      
      const result = await deleteStmt.bind(...phoneIds).run();
      
      // Also delete any phones without ICCID
      const cleanupNullIccid = await env.DB.prepare(
        `DELETE FROM phones WHERE iccid IS NULL OR iccid = ''`
      ).run();
      
      return new Response(JSON.stringify({
        success: true,
        deleted: result.meta.changes,
        cleanedNullIccid: cleanupNullIccid.meta.changes,
        message: `Deleted ${result.meta.changes} test phones and ${cleanupNullIccid.meta.changes} phones without ICCID`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Cleanup error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to cleanup test data'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Get pending SMS sends for daemon polling
  async getPendingSMS(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    const expectedKey = env.API_KEY;
    
    if (!apiKey || apiKey !== expectedKey) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      // Get pending SMS messages (status = 'sending')
      const stmt = env.DB.prepare(`
        SELECT id, phone_iccid, phone_number, content, recipient, created_at
        FROM messages 
        WHERE type = 'sent' AND status = 'sending'
        ORDER BY created_at ASC
        LIMIT 50
      `);
      
      const { results } = await stmt.all();
      
      return new Response(JSON.stringify({
        success: true,
        pending_messages: results || []
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Get pending SMS error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to get pending SMS'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Update SMS send result from daemon
  async updateSMSResult(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    const expectedKey = env.API_KEY;
    
    if (!apiKey || apiKey !== expectedKey) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      const { message_id, success, error_message, sms_id } = await request.json();
      
      if (!message_id) {
        return new Response(JSON.stringify({
          success: false,
          error: 'message_id is required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Update message status
      const status = success ? 'sent' : 'failed';
      const stmt = env.DB.prepare(`
        UPDATE messages 
        SET status = ?, error_message = ?, sms_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      
      const result = await stmt.bind(status, error_message || null, sms_id || null, message_id).run();
      
      if (result.meta.changes === 0) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Message not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Status updates are now picked up by polling
      
      return new Response(JSON.stringify({
        success: true,
        message: 'SMS result updated successfully'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Update SMS result error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to update SMS result'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Clear all messages (admin endpoint)
  async clearMessages(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    const expectedKey = env.API_KEY;
    
    if (!apiKey || apiKey !== expectedKey) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid API key'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      const result = await env.DB.prepare('DELETE FROM messages').run();
      
      return new Response(JSON.stringify({
        success: true,
        message: `Cleared ${result.changes} messages`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[control.js] Clear messages error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to clear messages: ' + error.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Daemon heartbeat endpoint
  async heartbeat(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    const expectedKey = env.API_KEY;
    
    if (!apiKey || apiKey !== expectedKey) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      const { device_id, version, status = 'online' } = await request.json();
      
      // Store heartbeat in KV with 5 minute expiration
      const heartbeatData = {
        device_id,
        version,
        status,
        timestamp: new Date().toISOString(),
        last_heartbeat: Date.now()
      };
      
      await env.SESSIONS.put(
        'daemon:heartbeat',
        JSON.stringify(heartbeatData),
        { expirationTtl: 300 } // 5 minutes
      );
      
      console.log(`[control.js] Daemon heartbeat received: device=${device_id}, version=${version}, status=${status}`);
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Heartbeat received'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[control.js] Heartbeat error:', error);
      console.error('[control.js] Heartbeat error stack:', error.stack);
      console.error('[control.js] Heartbeat error message:', error.message);
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to process heartbeat: ${error.message}`
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
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

// Process keywords for a message
async function processMessageKeywords(db, message) {
  try {
    // Ensure keyword tables exist first
    await ensureKeywordTables(db);
    
    // Get active keywords
    const { results: keywords } = await db.prepare(`
      SELECT id, keyword, tag, color, priority, case_sensitive, whole_word
      FROM keyword_tags
      WHERE is_active = TRUE
      ORDER BY priority DESC
    `).all();
    
    if (keywords.length === 0) return;
    
    // Find matches for each keyword
    const matches = [];
    for (const keyword of keywords) {
      const keywordMatches = findKeywordMatches(message.content, keyword.keyword, keyword.case_sensitive, keyword.whole_word);
      for (const match of keywordMatches) {
        matches.push({
          message_id: message.id,
          keyword_tag_id: keyword.id,
          matched_text: match.text,
          position: match.position
        });
      }
    }
    
    // Insert matches in batch if any found
    if (matches.length > 0) {
      const placeholders = matches.map(() => '(?, ?, ?, ?)').join(',');
      const values = matches.flatMap(m => [m.message_id, m.keyword_tag_id, m.matched_text, m.position]);
      
      await db.prepare(`
        INSERT OR IGNORE INTO message_tags (message_id, keyword_tag_id, matched_text, position)
        VALUES ${placeholders}
      `).bind(...values).run();
      
      console.log(`[control.js] Processed ${matches.length} keyword matches for message ${message.id}`);
    }
  } catch (error) {
    console.error(`[control.js] Keyword processing error for message ${message.id}:`, error);
  }
}