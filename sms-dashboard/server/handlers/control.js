import { nanoid } from 'nanoid';
import { extractVerificationCode } from '../utils/verification';
import { aiHandler } from './ai';
import { findKeywordMatches } from '../api/keywords.js';

export const controlHandler = {
  // New clean endpoint for separate modems and SIMs with state reconciliation
  async updateDevices(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    const expectedKey = env.API_KEY;
    
    if (!apiKey || apiKey !== expectedKey) {
      console.error(`[control.js] API key mismatch in updateDevices`);
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Parse request body with sync metadata
    const { 
      sync_mode = 'incremental',
      session_id = null,
      timestamp = new Date().toISOString(),
      modems = [], 
      sims = [] 
    } = await request.json();
    
    console.log(`[control.js] Received ${modems.length} modems and ${sims.length} SIMs (mode: ${sync_mode}, session: ${session_id})`);
    
    try {
      // Prepare batch operations for better performance
      const batch = [];
      
      // Handle full state synchronization
      if (sync_mode === 'full' && session_id) {
        console.log(`[control.js] Starting FULL STATE SYNC for session ${session_id}`);
        
        // Step 1: Mark all existing connected modems as pending verification
        batch.push(env.DB.prepare(`
          UPDATE modems 
          SET verification_status = 'pending'
          WHERE status = 'connected'
        `));
        
        // Step 2: Collect all received modem IDs
        const receivedModemIds = new Set(modems.map(m => m.equipment_id).filter(id => id));
        const receivedIccids = new Set(sims.map(s => s.iccid).filter(id => id));
        
        console.log(`[control.js] Full sync received ${receivedModemIds.size} modems, ${receivedIccids.size} SIMs`);
        
        // Process modems and SIMs (will be updated below)
      }
      
      // Update modems table
      for (const modem of modems) {
        if (!modem.equipment_id) {
          console.warn('[control.js] Skipping modem without equipment_id');
          continue;
        }
        
        // Include verification status in full sync mode
        const verificationStatus = sync_mode === 'full' ? 'verified' : null;
        const lastVerifiedSession = sync_mode === 'full' ? session_id : null;
        
        batch.push(env.DB.prepare(`
          INSERT INTO modems (
            equipment_id, manufacturer, model, firmware_revision, 
            hardware_revision, status, 
            verification_status, last_verified_session,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(equipment_id) DO UPDATE SET
            manufacturer = excluded.manufacturer,
            model = excluded.model,
            firmware_revision = excluded.firmware_revision,
            hardware_revision = excluded.hardware_revision,
            status = excluded.status,
            verification_status = COALESCE(excluded.verification_status, modems.verification_status),
            last_verified_session = COALESCE(excluded.last_verified_session, modems.last_verified_session),
            updated_at = CURRENT_TIMESTAMP
        `).bind(
          modem.equipment_id,
          modem.manufacturer || null,
          modem.model || null,
          modem.firmware_revision || null,
          modem.hardware_revision || null,
          modem.status || 'unknown',
          verificationStatus,
          lastVerifiedSession
        ));
        
        // Update modem_state if we have signal data
        if (modem.signal !== null || modem.signal !== undefined) {
          batch.push(env.DB.prepare(`
            INSERT INTO modem_state (
              modem_id, modem_index, usb_port, signal_percent, rssi, rsrq, rsrp, snr,
              connection_status, network_type, access_tech, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(modem_id) DO UPDATE SET
              modem_index = excluded.modem_index,
              usb_port = excluded.usb_port,
              signal_percent = excluded.signal_percent,
              rssi = excluded.rssi,
              rsrq = excluded.rsrq,
              rsrp = excluded.rsrp,
              snr = excluded.snr,
              connection_status = excluded.connection_status,
              network_type = excluded.network_type,
              access_tech = excluded.access_tech,
              updated_at = CURRENT_TIMESTAMP
          `).bind(
            modem.equipment_id,
            modem.modem_index || null,
            modem.usb_port || null,
            modem.signal || null,
            modem.rssi || null,
            modem.rsrq || null,
            modem.rsrp || null,
            modem.snr || null,
            modem.connection_status || 'registered',
            modem.network_type || null,
            modem.access_tech || null
          ));
        }
      }
      
      // Update SIMs table
      for (const sim of sims) {
        if (!sim.iccid) {
          console.warn('[control.js] Skipping SIM without ICCID');
          continue;
        }
        
        const lastVerifiedSession = sync_mode === 'full' ? session_id : null;
        
        batch.push(env.DB.prepare(`
          INSERT INTO sims (
            iccid, phone_number, current_modem_id, operator_name,
            operator_id, status, sim_index, 
            last_verified_session,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(iccid) DO UPDATE SET
            phone_number = excluded.phone_number,
            current_modem_id = excluded.current_modem_id,
            operator_name = excluded.operator_name,
            operator_id = excluded.operator_id,
            status = excluded.status,
            sim_index = excluded.sim_index,
            last_verified_session = COALESCE(excluded.last_verified_session, sims.last_verified_session),
            updated_at = CURRENT_TIMESTAMP
        `).bind(
          sim.iccid,
          sim.phone_number || null,
          sim.current_modem_id || null,
          sim.operator_name || null,
          sim.operator_id || null,
          sim.status || 'active',
          sim.sim_index || null,
          lastVerifiedSession
        ));
      }
      
      // Execute all batch operations
      if (batch.length > 0) {
        await env.DB.batch(batch);
      }
      
      // Sync sim_index from modem_state to sims table
      // This ensures sim_index is always in sync even if the daemon doesn't send it
      try {
        const syncResult = await env.DB.prepare(`
          UPDATE sims 
          SET sim_index = (
            SELECT ms.modem_index 
            FROM modem_state ms 
            WHERE ms.modem_id = sims.current_modem_id
            AND ms.modem_index IS NOT NULL
          )
          WHERE current_modem_id IS NOT NULL 
          AND (sim_index IS NULL OR sim_index != (
            SELECT ms.modem_index 
            FROM modem_state ms 
            WHERE ms.modem_id = sims.current_modem_id
            AND ms.modem_index IS NOT NULL
          ))
          AND EXISTS (
            SELECT 1 FROM modem_state ms 
            WHERE ms.modem_id = sims.current_modem_id 
            AND ms.modem_index IS NOT NULL
          )
        `).run();
        
        if (syncResult.meta.changes > 0) {
          console.log(`[control.js] Synchronized sim_index for ${syncResult.meta.changes} SIM cards`);
        }
      } catch (syncError) {
        console.warn('[control.js] Failed to sync sim_index:', syncError);
      }
      
      // Handle reconciliation for full sync
      if (sync_mode === 'full') {
        console.log('[control.js] Reconciling disconnected modems...');
        
        // Mark modems not in this sync as disconnected
        const disconnectResult = await env.DB.prepare(`
          UPDATE modems 
          SET status = 'disconnected',
              verification_status = 'absent'
          WHERE verification_status = 'pending'
        `).run();
        
        console.log(`[control.js] Marked ${disconnectResult.meta.changes} modems as disconnected`);
        
        // Clear SIM associations for disconnected modems
        const clearSimsResult = await env.DB.prepare(`
          UPDATE sims 
          SET current_modem_id = NULL
          WHERE current_modem_id IN (
            SELECT equipment_id FROM modems 
            WHERE verification_status = 'absent'
          )
        `).run();
        
        console.log(`[control.js] Cleared ${clearSimsResult.meta.changes} SIM associations`);
        
        // Record sync history
        await env.DB.prepare(`
          INSERT INTO sync_history (
            daemon_id, session_id, sync_mode, sync_timestamp,
            modems_received, sims_received, modems_disconnected,
            status, created_at
          ) VALUES (
            'orange-pi-main', ?, ?, ?, ?, ?, ?, 'completed', CURRENT_TIMESTAMP
          )
        `).bind(
          session_id,
          sync_mode,
          timestamp,
          modems.length,
          sims.length,
          disconnectResult.meta.changes
        ).run();
      }
      
      // Update daemon heartbeat
      const clientIp = request.headers.get('CF-Connecting-IP') || 
                      request.headers.get('X-Forwarded-For') || 
                      'unknown';
      
      await env.DB.prepare(`
        INSERT INTO daemon_health (
          daemon_id, last_heartbeat, status, modem_count, last_ip, 
          current_session_id, last_full_sync, sync_mode,
          updated_at
        ) VALUES (
          'orange-pi-main', CURRENT_TIMESTAMP, 'online', ?, ?, ?, 
          ${sync_mode === 'full' ? 'CURRENT_TIMESTAMP' : 'NULL'},
          ?, CURRENT_TIMESTAMP
        )
        ON CONFLICT(daemon_id) DO UPDATE SET
          last_heartbeat = CURRENT_TIMESTAMP,
          status = 'online',
          modem_count = excluded.modem_count,
          last_ip = excluded.last_ip,
          current_session_id = COALESCE(?, daemon_health.current_session_id),
          last_full_sync = CASE 
            WHEN ? = 'full' THEN CURRENT_TIMESTAMP 
            ELSE daemon_health.last_full_sync 
          END,
          sync_mode = ?,
          updated_at = CURRENT_TIMESTAMP
      `).bind(
        modems.length, 
        clientIp, 
        session_id,
        sync_mode,
        session_id,
        sync_mode,
        sync_mode
      ).run();
      
      // WebSocket broadcast removed for cost savings - manual refresh only
      // Users must refresh the page to see updates
      
      return new Response(JSON.stringify({
        success: true,
        sync_mode,
        session_id,
        processed: {
          modems: modems.length,
          sims: sims.length
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error) {
      console.error('[control.js] Database error in updateDevices:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to update devices'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
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
        INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type, verification_code, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'received', ?, 'received', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
          
          // Generate a unique message ID with timestamp prefix to ensure uniqueness
          const messageId = msg.id || `msg-${Date.now()}-${nanoid(10)}`;
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
                try {
                  await aiHandler.extractCodeDirect(env, {
                    content: msg.content,
                    message_id: msg.id
                  });
                } catch (error) {
                  console.error(`Failed to extract code for message ${msg.id}:`, error);
                }
                
                // Classify message
                try {
                  await aiHandler.classifyMessageDirect(env, {
                    content: msg.content,
                    message_id: msg.id
                  });
                } catch (error) {
                  console.error(`Failed to classify message ${msg.id}:`, error);
                }
                
                // Generate embedding for search
                try {
                  await aiHandler.generateEmbeddingDirect(env, {
                    content: msg.content,
                    message_id: msg.id
                  });
                } catch (error) {
                  console.error(`Failed to generate embedding for message ${msg.id}:`, error);
                }
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
      
      // Initial modem count from daemon report
      let modemCount = phones.length === 1 && phones[0].iccid === 'ALL_PHONES_OFFLINE' ? 0 : phones.length;
      let daemonStatus = modemCount === 0 ? 'warning' : 'online';
      
      // Mark stale modems as offline
      if (modemCount > 0) {
        // Mark stale modems (not updated in last 10 minutes) as disconnected
        console.log(`[control.js] Marking stale modems offline (not updated in 10 minutes)`);
        const staleResult = await env.DB.prepare(`
          UPDATE modems 
          SET status = 'disconnected',
              updated_at = CURRENT_TIMESTAMP
          WHERE status IN ('connected', 'online', 'active', 'registered')
            AND datetime(updated_at) < datetime('now', '-10 minutes')
        `).run();
        
        if (staleResult.meta.changes > 0) {
          console.log(`[control.js] Marked ${staleResult.meta.changes} stale modems as disconnected`);
        }
        
        // Also clear signal data for disconnected modems
        await env.DB.prepare(`
          UPDATE modem_state 
          SET signal_percent = NULL,
              rssi = NULL,
              rsrq = NULL,
              rsrp = NULL,
              snr = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE modem_id IN (
            SELECT equipment_id FROM modems WHERE status = 'disconnected'
          )
        `).run();
      }
      
      // Store daemon heartbeat with initial count (will be adjusted later if needed)
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
      
      // Special case: mark all modems as offline when no modems found
      if (phones.length === 1 && phones[0].iccid === 'ALL_PHONES_OFFLINE') {
        console.log('[control.js] No modems found - marking all modems as disconnected');
        
        // Update all modems to disconnected status
        const result = await env.DB.prepare(`
          UPDATE modems 
          SET status = 'disconnected', 
              updated_at = CURRENT_TIMESTAMP
          WHERE status != 'disconnected'
        `).run();
        
        console.log(`[control.js] Marked ${result.meta.changes} modems as disconnected`);
        
        // Clear signal data
        await env.DB.prepare(`
          UPDATE modem_state 
          SET signal_percent = NULL,
              rssi = NULL,
              rsrq = NULL,
              rsrp = NULL,
              snr = NULL,
              updated_at = CURRENT_TIMESTAMP
        `).run();
        
        return new Response(JSON.stringify({
          success: true,
          message: `Marked ${result.meta.changes} modems as disconnected`,
          daemon_status: 'warning'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Update phones using new normalized schema (modems + sims + modem_state)
      // Translate old phones format to new schema
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
          
          // Update modems table (hardware data)
          await env.DB.prepare(`
            INSERT INTO modems (
              equipment_id, manufacturer, model, firmware_revision, 
              hardware_revision, status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(equipment_id) DO UPDATE SET
              manufacturer = COALESCE(excluded.manufacturer, modems.manufacturer),
              model = COALESCE(excluded.model, modems.model),
              firmware_revision = COALESCE(excluded.firmware_revision, modems.firmware_revision),
              hardware_revision = COALESCE(excluded.hardware_revision, modems.hardware_revision),
              status = excluded.status,
              updated_at = CURRENT_TIMESTAMP
          `).bind(
            phone.imei || `SIM_${phone.iccid}`,  // Use IMEI as equipment_id, fallback to SIM-based ID
            phone.manufacturer || null,
            phone.model || null,
            phone.firmware_revision || null,
            phone.hardware_revision || null,
            phone.status || 'active'
          ).run();
          
          // Update sims table (SIM card data)
          await env.DB.prepare(`
            INSERT INTO sims (
              iccid, phone_number, carrier, country_code, 
              status, operator_name, operator_id, 
              current_modem_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(iccid) DO UPDATE SET
              phone_number = COALESCE(excluded.phone_number, sims.phone_number),
              carrier = COALESCE(excluded.carrier, sims.carrier),
              country_code = COALESCE(excluded.country_code, sims.country_code),
              status = excluded.status,
              operator_name = COALESCE(excluded.operator_name, sims.operator_name),
              operator_id = COALESCE(excluded.operator_id, sims.operator_id),
              current_modem_id = excluded.current_modem_id,
              updated_at = CURRENT_TIMESTAMP
          `).bind(
            phone.iccid,
            phone.number || null,
            phone.carrier || null,
            phone.country || null,
            phone.status || 'active',
            phone.operator_name || null,
            phone.operator_id || null,
            phone.imei || `SIM_${phone.iccid}`
          ).run();
          
          // Update modem_state table (real-time status)
          await env.DB.prepare(`
            INSERT INTO modem_state (
              modem_id, modem_index, usb_port, signal_percent, 
              rssi, rsrq, rsrp, snr, access_tech, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(modem_id) DO UPDATE SET
              modem_index = excluded.modem_index,
              usb_port = COALESCE(excluded.usb_port, modem_state.usb_port),
              signal_percent = excluded.signal_percent,
              rssi = excluded.rssi,
              rsrq = excluded.rsrq,
              rsrp = excluded.rsrp,
              snr = excluded.snr,
              access_tech = COALESCE(excluded.access_tech, modem_state.access_tech),
              updated_at = CURRENT_TIMESTAMP
          `).bind(
            phone.imei || `SIM_${phone.iccid}`,
            phone.modem_index || null,
            phone.usb_port || null,
            phone.signal || null,
            phone.rssi || null,
            phone.rsrq || null,
            phone.rsrp || null,
            phone.snr || null,
            phone.access_tech || null
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
      
      // Delete test SIMs by ICCID
      const placeholders = phoneIds.map(() => '?').join(',');
      const deleteStmt = env.DB.prepare(
        `DELETE FROM sims WHERE iccid IN (${placeholders})`
      );
      
      const result = await deleteStmt.bind(...phoneIds).run();
      
      // Also delete any SIMs without ICCID
      const cleanupNullIccid = await env.DB.prepare(
        `DELETE FROM sims WHERE iccid IS NULL OR iccid = ''`
      ).run();
      
      return new Response(JSON.stringify({
        success: true,
        deleted: result.meta.changes,
        cleanedNullIccid: cleanupNullIccid.meta.changes,
        message: `Deleted ${result.meta.changes} test SIMs and ${cleanupNullIccid.meta.changes} SIMs without ICCID`
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

  // Daemon heartbeat and check for pending SMS to send
  // This endpoint is polled regularly by the daemon, serving as both:
  // 1. A heartbeat to track daemon health
  // 2. A way to get pending SMS messages to send
  async heartbeatAndGetPendingSMS(request) {
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
      // Update daemon heartbeat since this endpoint is polled regularly
      const clientIp = request.headers.get('CF-Connecting-IP') || 
                      request.headers.get('X-Forwarded-For') || 
                      'unknown';
      const daemonVersion = request.headers.get('X-Daemon-Version') || 'v3.9.0';
      
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
      await env.DB.prepare(`
        INSERT INTO daemon_health (
          daemon_id, last_heartbeat, status, last_ip, version, updated_at
        ) VALUES (
          'orange-pi-main', CURRENT_TIMESTAMP, 'online', ?, ?, CURRENT_TIMESTAMP
        )
        ON CONFLICT(daemon_id) DO UPDATE SET
          last_heartbeat = CURRENT_TIMESTAMP,
          status = 'online',
          last_ip = excluded.last_ip,
          version = excluded.version,
          updated_at = CURRENT_TIMESTAMP
      `).bind(clientIp, daemonVersion).run();
      
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