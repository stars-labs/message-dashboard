import { nanoid } from 'nanoid';
import { extractVerificationCode } from '../utils/verification';
import { aiHandler } from './ai';
import { findKeywordMatches } from '../api/keywords.js';
import { ensureTablesExist, ensureKeywordTablesExist } from '../utils/database-setup.js';
import { createConnection } from '../utils/database-wrapper.js';

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
      
      // Create database connection wrapper for this request
      const conn = createConnection(env.DB);
      
      // Update daemon heartbeat
      const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
      const daemonVersion = request.headers.get('X-Daemon-Version') || 'unknown';
      
      // Ensure tables exist (simple one-time setup)
      await ensureTablesExist(env.DB);
      
      // Update daemon heartbeat
      const modemCount = phones.length === 1 && phones[0].iccid === 'ALL_PHONES_OFFLINE' ? 0 : phones.length;
      const daemonStatus = modemCount === 0 ? 'warning' : 'online';
      
      // Mark modems as disconnected only if they haven't been updated recently
      // This prevents race conditions where concurrent daemon updates might mark valid modems as disconnected
      if (modemCount > 0) {
        console.log(`[control.js] Checking for stale phantom modems (modem_index >= ${modemCount})`);
        
        // Only mark as disconnected if not updated in the last 60 seconds
        const staleThreshold = new Date(Date.now() - 60000).toISOString();
        
        const phantomResult = await conn.execute(`
          UPDATE modems 
          SET status = 'disconnected',
              updated_at = CURRENT_TIMESTAMP
          WHERE modem_index >= ? 
            AND status != 'disconnected'
            AND (updated_at IS NULL OR updated_at < ?)
        `, [modemCount, staleThreshold]);
        
        if (phantomResult.meta.changes > 0) {
          console.log(`[control.js] Marked ${phantomResult.meta.changes} stale phantom modems as disconnected`);
        }
      } else {
        // When no modems are found, only mark modems as disconnected if they're stale
        console.log('[control.js] No modems found - marking stale modems as disconnected');
        
        const staleThreshold = new Date(Date.now() - 120000).toISOString(); // 2 minutes for complete offline
        
        const updateModems = await conn.execute(`
          UPDATE modems 
          SET status = 'disconnected', 
              updated_at = CURRENT_TIMESTAMP
          WHERE status != 'disconnected'
            AND (updated_at IS NULL OR updated_at < ?)
        `, [staleThreshold]);
        
        console.log(`[control.js] Marked ${updateModems.meta.changes} stale modems as disconnected`);
      }
      
      await conn.execute(`
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
      `, [daemonStatus, clientIp, daemonVersion, modemCount]);
      
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
      
      // Special case: when no modems found (ALL_PHONES_OFFLINE)
      // The stale modem check above already handles this case with proper timing
      if (phones.length === 1 && phones[0].iccid === 'ALL_PHONES_OFFLINE') {
        console.log('[control.js] No modems found - stale modems already marked as disconnected above');
        
        // Clear modem state data for disconnected modems
        const clearState = await conn.execute(`
          UPDATE modem_state 
          SET connection_status = 'disconnected',
              signal_percent = NULL,
              rssi = NULL,
              rsrq = NULL,
              rsrp = NULL,
              snr = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE modem_id IN (
            SELECT equipment_id FROM modems WHERE status = 'disconnected'
          )
        `);
        
        console.log(`[control.js] Cleared state for ${clearState.meta.changes} disconnected modems`);
        
        // Get all devices to broadcast
        const offlineDevices = await env.DB.prepare(`
          SELECT * FROM device_view WHERE modem_status = 'disconnected'
        `).all();
        
        // Broadcast phone updates to all connected clients
        const ws = env.WEBSOCKET_HANDLER.get(env.WEBSOCKET_HANDLER.idFromName('broadcast'));
        await ws.fetch('http://internal/broadcast', {
          method: 'POST',
          body: JSON.stringify({
            type: 'phone_update',
            data: offlineDevices.results
          })
        });
        
        return new Response(JSON.stringify({
          success: true,
          message: `Marked ${updateModems.meta.changes} modems as disconnected`,
          daemon_status: 'warning'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Define SQL queries (will be cached by the connection wrapper)
      const MODEM_UPSERT_SQL = `
        INSERT INTO modems (equipment_id, manufacturer, model, firmware_revision, hardware_revision, device_path, status, modem_index, usb_port)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(equipment_id) DO UPDATE SET
          manufacturer = COALESCE(excluded.manufacturer, modems.manufacturer),
          model = COALESCE(excluded.model, modems.model),
          firmware_revision = COALESCE(excluded.firmware_revision, modems.firmware_revision),
          hardware_revision = COALESCE(excluded.hardware_revision, modems.hardware_revision),
          device_path = COALESCE(excluded.device_path, modems.device_path),
          status = excluded.status,
          modem_index = excluded.modem_index,
          usb_port = COALESCE(excluded.usb_port, modems.usb_port),
          updated_at = CURRENT_TIMESTAMP
      `;
      
      const SIM_UPSERT_SQL = `
        INSERT INTO sims (iccid, phone_number, carrier, operator_name, operator_id, country_code, status, current_modem_id, sim_index)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(iccid) DO UPDATE SET
          phone_number = COALESCE(excluded.phone_number, sims.phone_number),
          carrier = COALESCE(excluded.carrier, sims.carrier),
          operator_name = COALESCE(excluded.operator_name, sims.operator_name),
          operator_id = COALESCE(excluded.operator_id, sims.operator_id),
          country_code = COALESCE(excluded.country_code, sims.country_code),
          status = excluded.status,
          current_modem_id = excluded.current_modem_id,
          sim_index = excluded.sim_index,
          updated_at = CURRENT_TIMESTAMP
      `;
      
      const MODEM_STATE_UPSERT_SQL = `
        INSERT INTO modem_state (modem_id, connection_status, signal_percent, rssi, rsrq, rsrp, snr, network_type, access_tech, band_info)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(modem_id) DO UPDATE SET
          connection_status = excluded.connection_status,
          signal_percent = COALESCE(excluded.signal_percent, modem_state.signal_percent),
          rssi = COALESCE(excluded.rssi, modem_state.rssi),
          rsrq = COALESCE(excluded.rsrq, modem_state.rsrq),
          rsrp = COALESCE(excluded.rsrp, modem_state.rsrp),
          snr = COALESCE(excluded.snr, modem_state.snr),
          network_type = COALESCE(excluded.network_type, modem_state.network_type),
          access_tech = COALESCE(excluded.access_tech, modem_state.access_tech),
          band_info = COALESCE(excluded.band_info, modem_state.band_info),
          updated_at = CURRENT_TIMESTAMP
      `;
      
      // Process phones in batches with transactions for consistency
      let successCount = 0;
      let errorCount = 0;
      const errors = [];
      
      // Process in batches to avoid long-running transactions
      const batchSize = 10;
      for (let i = 0; i < phones.length; i += batchSize) {
        const batch = phones.slice(i, Math.min(i + batchSize, phones.length));
        
        // Clear transaction queue for this batch
        conn.clearTransaction();
        
        try {
          for (const phone of batch) {
            // Skip phantom phones that exceed daemon's modem count
            if (phone.modem_index !== null && phone.modem_index !== undefined && phone.modem_index >= modemCount) {
              console.log(`[control.js] Skipping phantom phone with modem_index=${phone.modem_index} (>= ${modemCount}): ICCID=${phone.iccid}`);
              continue;
            }
            
            // Validate and generate equipment ID
            let equipmentId = phone.imei;
            if (!equipmentId || equipmentId.trim() === '') {
              // Generate synthetic ID only if IMEI is missing
              if (phone.modem_index !== null && phone.modem_index !== undefined) {
                equipmentId = `MODEM_${phone.modem_index}`;
              } else {
                console.error(`[control.js] Phone missing both IMEI and modem_index, skipping: ${phone.iccid}`);
                errorCount++;
                errors.push({
                  phone: phone.iccid || 'unknown',
                  error: 'Missing equipment ID (IMEI) and modem_index'
                });
                continue;
              }
            }
            
            // Add modem update to transaction
            conn.addToTransaction(MODEM_UPSERT_SQL, [
              equipmentId,
              phone.manufacturer || null,
              phone.model || null,
              phone.firmware_revision || null,
              phone.hardware_revision || null,
              phone.device_path || null,
              phone.status === 'online' || phone.status === 'active' ? 'connected' : 'disconnected',
              phone.modem_index || null,
              phone.usb_port || phone.modem_index || null
            ]);
            
            // Add SIM update to transaction if ICCID is valid
            if (phone.iccid && phone.iccid.trim() !== '' && !phone.iccid.startsWith('SIM_')) {
              conn.addToTransaction(SIM_UPSERT_SQL, [
                phone.iccid,
                phone.number || null,
                phone.carrier || null,
                phone.operator_name || null,
                phone.operator_id || null,
                phone.country || null,
                phone.status === 'online' || phone.status === 'active' ? 'active' : 'inactive',
                equipmentId, // Link SIM to modem
                phone.sim_index || null // Store SIM index from daemon
              ]);
            }
            
            // Add modem state update to transaction
            const connectionStatus = phone.status === 'online' ? 'registered' : 
                                    phone.status === 'active' ? 'connected' : 'disconnected';
            
            conn.addToTransaction(MODEM_STATE_UPSERT_SQL, [
              equipmentId,
              connectionStatus,
              phone.signal || null,
              phone.rssi || null,
              phone.rsrq || null,
              phone.rsrp || null,
              phone.snr || null,
              null, // network_type - not provided yet
              phone.access_tech || null,
              null // band_info - not provided yet
            ]);
          }
          
          // Execute all updates in the batch as a transaction
          const result = await conn.executeTransaction();
          if (result.success) {
            successCount += batch.filter(p => 
              !(p.modem_index !== null && p.modem_index !== undefined && p.modem_index >= modemCount)
            ).length;
          }
        } catch (err) {
          // If the batch fails, try processing individually to identify the problematic record
          console.error(`[control.js] Batch update failed, trying individual updates:`, err);
          
          for (const phone of batch) {
            try {
              // Skip phantom phones
              if (phone.modem_index !== null && phone.modem_index !== undefined && phone.modem_index >= modemCount) {
                continue;
              }
              
              const equipmentId = phone.imei || `MODEM_${phone.modem_index}`;
              
              // Try individual updates (using cached prepared statements)
              await conn.execute(MODEM_UPSERT_SQL, [
                equipmentId,
                phone.manufacturer || null,
                phone.model || null,
                phone.firmware_revision || null,
                phone.hardware_revision || null,
                phone.device_path || null,
                phone.status === 'online' || phone.status === 'active' ? 'connected' : 'disconnected',
                phone.modem_index || null,
                phone.usb_port || phone.modem_index || null
              ]);
              
              if (phone.iccid && phone.iccid.trim() !== '' && !phone.iccid.startsWith('SIM_')) {
                await conn.execute(SIM_UPSERT_SQL, [
                  phone.iccid,
                  phone.number || null,
                  phone.carrier || null,
                  phone.operator_name || null,
                  phone.operator_id || null,
                  phone.country || null,
                  phone.status === 'online' || phone.status === 'active' ? 'active' : 'inactive',
                  equipmentId,
                  phone.sim_index || null // Store SIM index from daemon
                ]);
              }
              
              const connectionStatus = phone.status === 'online' ? 'registered' : 
                                      phone.status === 'active' ? 'connected' : 'disconnected';
              
              await conn.execute(MODEM_STATE_UPSERT_SQL, [
                equipmentId,
                connectionStatus,
                phone.signal || null,
                phone.rssi || null,
                phone.rsrq || null,
                phone.rsrp || null,
                phone.snr || null,
                null,
                phone.access_tech || null,
                null
              ]);
              
              successCount++;
            } catch (individualErr) {
              errorCount++;
              errors.push({
                phone: phone.iccid || phone.number || 'unknown',
                error: individualErr.message
              });
              console.error(`[control.js] Failed to update phone ${phone.iccid || phone.number}:`, individualErr);
            }
          }
        }
      }
      
      // Filter out invalid phones before broadcasting
      const validPhones = phones.filter(phone => 
        phone.iccid && 
        phone.iccid.trim() !== '' && 
        !phone.iccid.startsWith('SIM_')
      );
      
      // Log performance stats (for monitoring)
      const stats = conn.getStats();
      console.log(`[control.js] Performance stats: ${stats.cachedStatements} statements cached, ${successCount} phones updated`);
      
      return new Response(JSON.stringify({
        success: errorCount === 0,
        updated: successCount,
        failed: errorCount,
        message: `Updated ${successCount} phones${errorCount > 0 ? `, ${errorCount} failed` : ''}`,
        errors: errors.length > 0 ? errors : undefined,
        performance: stats // Include performance stats in response
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
      
      // Delete test data by ICCID - clean up SIMs and related data
      const placeholders = phoneIds.map(() => '?').join(',');
      
      // Delete SIMs
      const deleteSimsStmt = env.DB.prepare(
        `DELETE FROM sims WHERE iccid IN (${placeholders})`
      );
      
      const result = await deleteSimsStmt.bind(...phoneIds).run();
      
      // Clean up any orphaned modems without corresponding SIMs
      const cleanupOrphanedModems = await env.DB.prepare(
        `DELETE FROM modems WHERE equipment_id NOT IN (SELECT current_modem_id FROM sims WHERE current_modem_id IS NOT NULL)`
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


// Process keywords for a message
async function processMessageKeywords(db, message) {
  try {
    // Ensure keyword tables exist first
    await ensureKeywordTablesExist(db);
    
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