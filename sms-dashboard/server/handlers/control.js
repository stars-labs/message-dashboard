import { nanoid } from 'nanoid';
import { extractVerificationCode } from '../utils/verification';
import { findKeywordMatches } from '../api/keywords.js';
import { classifyMessage, loadActiveRules } from '../utils/spam-filter.js';
import { HEALTH_SCHEMA_VERSION, normalizeHealthSnapshot } from '../utils/daemon-health.js';
import {
  findPendingBalanceCheck,
  linkBalanceReply,
  updateBalanceCheckForSmsResult,
} from './balance-queries.js';

const IS_LEGACY_DAEMON_HEALTH_SQL = `(
  daemon_health.metadata IS NULL OR
  json_valid(daemon_health.metadata) = 0 OR
  COALESCE(json_extract(daemon_health.metadata, '$.schema_version'), 0) < ${HEALTH_SCHEMA_VERSION}
)`;

const DAEMON_SESSION_ID = /^[A-Za-z0-9._:-]{1,120}$/;

export function normalizeDaemonSessionId(value) {
  return typeof value === 'string' && DAEMON_SESSION_ID.test(value) ? value : null;
}

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
    
    // Parse request body
    const body = await request.json();
    const {
      sync_mode = 'incremental',
      session_id = null,
      timestamp = new Date().toISOString(),
    } = body;

    try {
      // Format detection: new path (modem_reports) vs legacy path (modems + sims)
      if (body.modem_reports) {
        // === NEW PATH: Single-loop modem_reports ===
        const reports = body.modem_reports;
        console.log(`[control.js] Received ${reports.length} modem_reports (mode: ${sync_mode}, session: ${session_id})`);

        const batch = [];

        // Full sync: mark all active modems as pending verification
        if (sync_mode === 'full' && session_id) {
          console.log(`[control.js] Starting FULL STATE SYNC for session ${session_id}`);
          batch.push(env.DB.prepare(`
            UPDATE modems
            SET verification_status = 'pending'
            WHERE status IN ('active', 'connected', 'online')
          `));
        }

        // Single upsert per modem report — no SIM association loop, no eviction
        for (const report of reports) {
          if (!report.equipment_id) {
            console.warn('[control.js] Skipping report without equipment_id');
            continue;
          }

          if (report.equipment_id.startsWith('MODEM_') &&
              (!report.manufacturer || report.manufacturer === null) &&
              (!report.model || report.model === null)) {
            console.warn(`[control.js] Rejecting fake modem entry: ${report.equipment_id}`);
            continue;
          }

          const verificationStatus = sync_mode === 'full' ? 'verified' : null;
          const lastVerifiedSession = sync_mode === 'full' ? session_id : null;

          batch.push(env.DB.prepare(`
            INSERT INTO modems (
              equipment_id, manufacturer, model, firmware_revision,
              hardware_revision, detected_iccid, detected_phone_number,
              detected_operator, signal_percent, rssi,
              modem_index, usb_port, usb_path, last_usb_path, status,
              verification_status, last_verified_session,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(equipment_id) DO UPDATE SET
              manufacturer = excluded.manufacturer,
              model = excluded.model,
              firmware_revision = excluded.firmware_revision,
              hardware_revision = excluded.hardware_revision,
              detected_iccid = excluded.detected_iccid,
              detected_phone_number = excluded.detected_phone_number,
              detected_operator = excluded.detected_operator,
              signal_percent = excluded.signal_percent,
              rssi = excluded.rssi,
              modem_index = excluded.modem_index,
              usb_port = excluded.usb_port,
              usb_path = excluded.usb_path,
              last_usb_path = COALESCE(excluded.last_usb_path, modems.last_usb_path),
              status = excluded.status,
              verification_status = COALESCE(excluded.verification_status, modems.verification_status),
              last_verified_session = COALESCE(excluded.last_verified_session, modems.last_verified_session),
              updated_at = CURRENT_TIMESTAMP
          `).bind(
            report.equipment_id,
            report.manufacturer || null,
            report.model || null,
            report.firmware_revision || null,
            report.hardware_revision || null,
            report.detected_iccid || null,
            report.detected_phone_number || null,
            report.detected_operator || null,
            report.signal_percent ?? null,
            report.rssi ?? null,
            report.modem_index ?? null,
            report.usb_port ?? null,
            report.usb_path ?? null,
            report.usb_path ?? null,
            report.status || 'active',
            verificationStatus,
            lastVerifiedSession
          ));
        }

        // Execute batch
        if (batch.length > 0) {
          await env.DB.batch(batch);
        }

        // Reconciliation for full sync
        if (sync_mode === 'full') {
          console.log('[control.js] Reconciling disconnected modems...');

          const disconnectResult = await env.DB.prepare(`
            UPDATE modems
            SET status = 'disconnected',
                verification_status = 'absent'
            WHERE verification_status = 'pending'
          `).run();

          console.log(`[control.js] Marked ${disconnectResult.meta.changes} modems as disconnected`);

          // Clear detected data for disconnected modems. usb_path is detected
          // state too — a modem we can't see is not at that socket any more.
          await env.DB.prepare(`
            UPDATE modems
            SET detected_iccid = NULL,
                detected_phone_number = NULL,
                detected_operator = NULL,
                signal_percent = NULL,
                rssi = NULL,
                usb_path = NULL
            WHERE verification_status = 'absent'
          `).run();

          // Record sync history
          await env.DB.prepare(`
            INSERT INTO sync_history (
              daemon_id, session_id, sync_mode, sync_timestamp,
              modems_received, sims_received, modems_disconnected,
              status, created_at
            ) VALUES (
              'orange-pi-main', ?, ?, ?, ?, 0, ?, 'completed', CURRENT_TIMESTAMP
            )
          `).bind(
            session_id, sync_mode, timestamp,
            reports.length, disconnectResult.meta.changes
          ).run();
        }

      } else {
        // === LEGACY PATH: modems[] + sims[] ===
        const { modems = [], sims = [] } = body;
        console.log(`[control.js] [legacy] Received ${modems.length} modems and ${sims.length} SIMs (mode: ${sync_mode}, session: ${session_id})`);

        const batch = [];

        if (sync_mode === 'full' && session_id) {
          console.log(`[control.js] Starting FULL STATE SYNC for session ${session_id}`);
          batch.push(env.DB.prepare(`
            UPDATE modems
            SET verification_status = 'pending'
            WHERE status IN ('active', 'connected', 'online')
          `));
        }

        // Update modems table
        for (const modem of modems) {
          if (!modem.equipment_id) continue;
          if (modem.equipment_id.startsWith('MODEM_') &&
              (!modem.manufacturer || modem.manufacturer === null) &&
              (!modem.model || modem.model === null)) continue;

          const verificationStatus = sync_mode === 'full' ? 'verified' : null;
          const lastVerifiedSession = sync_mode === 'full' ? session_id : null;

          batch.push(env.DB.prepare(`
            INSERT INTO modems (
              equipment_id, manufacturer, model, firmware_revision,
              hardware_revision, status, sim_read_status,
              signal_percent, rssi,
              verification_status, last_verified_session,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(equipment_id) DO UPDATE SET
              manufacturer = excluded.manufacturer,
              model = excluded.model,
              firmware_revision = excluded.firmware_revision,
              hardware_revision = excluded.hardware_revision,
              status = excluded.status,
              sim_read_status = excluded.sim_read_status,
              signal_percent = excluded.signal_percent,
              rssi = excluded.rssi,
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
            modem.sim_read_status || null,
            modem.signal ?? null,
            modem.rssi ?? null,
            verificationStatus,
            lastVerifiedSession
          ));
        }

        // Process SIMs — write detected_iccid/detected_operator to modems table
        for (const sim of sims) {
          if (!sim.iccid || !sim.current_modem_id) continue;
          if (sim.current_modem_id.startsWith('MODEM_')) continue;

          batch.push(env.DB.prepare(`
            UPDATE modems
            SET detected_iccid = ?,
                detected_phone_number = ?,
                detected_operator = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE equipment_id = ?
          `).bind(
            sim.iccid,
            sim.phone_number || null,
            sim.operator_name || null,
            sim.current_modem_id
          ));
        }

        // Clear detected_iccid for modems with failed SIM reads
        for (const modem of modems) {
          if (modem.sim_read_status === 'failed' && modem.equipment_id) {
            batch.push(env.DB.prepare(`
              UPDATE modems SET detected_iccid = NULL, detected_phone_number = NULL
              WHERE equipment_id = ?
            `).bind(modem.equipment_id));
          }
        }

        if (batch.length > 0) {
          await env.DB.batch(batch);
        }

        // Reconciliation for full sync
        if (sync_mode === 'full') {
          console.log('[control.js] Reconciling disconnected modems...');

          const disconnectResult = await env.DB.prepare(`
            UPDATE modems
            SET status = 'disconnected',
                verification_status = 'absent'
            WHERE verification_status = 'pending'
          `).run();

          console.log(`[control.js] Marked ${disconnectResult.meta.changes} modems as disconnected`);

          // Clear detected data for disconnected modems. usb_path is detected
          // state too — a modem we can't see is not at that socket any more.
          await env.DB.prepare(`
            UPDATE modems
            SET detected_iccid = NULL,
                detected_phone_number = NULL,
                detected_operator = NULL,
                signal_percent = NULL,
                rssi = NULL,
                usb_path = NULL
            WHERE verification_status = 'absent'
          `).run();

          await env.DB.prepare(`
            INSERT INTO sync_history (
              daemon_id, session_id, sync_mode, sync_timestamp,
              modems_received, sims_received, modems_disconnected,
              status, created_at
            ) VALUES (
              'orange-pi-main', ?, ?, ?, ?, ?, ?, 'completed', CURRENT_TIMESTAMP
            )
          `).bind(
            session_id, sync_mode, timestamp,
            modems.length, sims.length, disconnectResult.meta.changes
          ).run();
        }
      } // end legacy path

      // Update daemon heartbeat (shared by both paths)
      const modemCount = body.modem_reports ? body.modem_reports.length : (body.modems || []).length;
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
          last_heartbeat = CASE
            WHEN ${IS_LEGACY_DAEMON_HEALTH_SQL}
              THEN CURRENT_TIMESTAMP
            ELSE daemon_health.last_heartbeat
          END,
          status = CASE
            WHEN ${IS_LEGACY_DAEMON_HEALTH_SQL}
              THEN 'online'
            ELSE daemon_health.status
          END,
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
        modemCount,
        clientIp,
        session_id,
        sync_mode,
        session_id,
        sync_mode,
        sync_mode
      ).run();

      return new Response(JSON.stringify({
        success: true,
        sync_mode,
        session_id,
        processed: { modem_reports: modemCount }
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
      console.error('[control.js] API key mismatch in uploadMessages');
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
        INSERT INTO messages (
          id, phone_iccid, phone_number, content, timestamp, type,
          verification_code, status, created_at, updated_at,
          filter_status, filter_rule_id, purpose, balance_check_id
        )
        VALUES (
          ?, ?, ?, ?, ?, 'received', ?, 'received',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?
        )
      `);

      // Spam rules are loaded ONCE per upload, not per message. Classification is
      // done inline rather than in ctx.waitUntil: the row must never be readable
      // while still 'pending', or marketing SMS would flash into the default list
      // in the window before a background task caught up.
      const filterRules = await loadActiveRules(env.DB);
      
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
          const balanceCheck = await findPendingBalanceCheck(env.DB, {
            phone_iccid,
            phone_number: phoneNumber,
          });
          const verificationCode = balanceCheck
            ? null
            : extractVerificationCode(msg.content);
          
          // Check for duplicate using the prepared statement
          const existing = await checkStmt.bind(phone_iccid, msg.content, timestamp, timestamp).first();
          if (existing) {
            if (balanceCheck) {
              await linkBalanceReply(env.DB, balanceCheck, {
                id: existing.id,
                phone_number: phoneNumber,
                content: msg.content,
              });
            }
            duplicates++;
            return null;
          }
          
          const record = {
            id: messageId,
            phone_iccid: phone_iccid,
            phone_number: phoneNumber,
            content: msg.content,
            timestamp,
            type: 'received',
            verification_code: verificationCode,
            purpose: balanceCheck ? 'balance_maintenance' : 'user',
            balance_check_id: balanceCheck?.id || null,
          };

          // Spam/marketing verdict. phone_number carries the SENDER's number for
          // received messages, which is what the sender rules match on.
          const verdict = balanceCheck
            ? { filter_status: 'filtered', filter_rule_id: null }
            : classifyMessage(record, filterRules);

          // Maintenance replies stay out of keyword and verification processing.
          if (!balanceCheck) newMessages.push(record);

          // Insert the message
          const result = await insertStmt.bind(
            messageId,
            phone_iccid,
            phoneNumber,
            msg.content,
            timestamp,
            verificationCode,
            verdict.filter_status,
            verdict.filter_rule_id,
            record.purpose,
            record.balance_check_id,
          ).run();

          if (balanceCheck) {
            await linkBalanceReply(env.DB, balanceCheck, record);
          }
          
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
  // Cleanup test data
  async cleanupTestData(request) {
    const { env } = request;
    
    // Check API key
    const apiKey = request.headers.get('X-API-Key');
    const expectedKey = env.API_KEY;

    if (!apiKey || apiKey !== expectedKey) {
      console.error('[control.js] API key mismatch in clearMessages');
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
  //
  // SMS Status Flow:
  //   'sending' (created by user)
  //   → 'processing' (atomically set when daemon fetches)
  //   → 'sent'/'failed' (reported by daemon after modem response)
  //
  // The atomic transition to 'processing' prevents duplicate sends in the race condition
  // where daemon polls again before the SMS send completes and status is updated to 'sent'.
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
      const rawDaemonSessionId = request.headers.get('X-Daemon-Session-Id');
      const daemonSessionId = normalizeDaemonSessionId(rawDaemonSessionId);

      if (rawDaemonSessionId && !daemonSessionId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid daemon session ID',
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      
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
          last_heartbeat = CASE
            WHEN ${IS_LEGACY_DAEMON_HEALTH_SQL}
              THEN CURRENT_TIMESTAMP
            ELSE daemon_health.last_heartbeat
          END,
          status = CASE
            WHEN ${IS_LEGACY_DAEMON_HEALTH_SQL}
              THEN 'online'
            ELSE daemon_health.status
          END,
          last_ip = excluded.last_ip,
          version = CASE
            WHEN ${IS_LEGACY_DAEMON_HEALTH_SQL}
              THEN excluded.version
            ELSE daemon_health.version
          END,
          updated_at = CURRENT_TIMESTAMP
      `).bind(clientIp, daemonVersion).run();

      // A message claimed by a previous daemon process has an indeterminate
      // delivery result. Never put it back in the send queue automatically: the
      // old process may have handed it to the modem before restarting. Mark it
      // explicitly unknown so a human can decide whether to send a new message.
      // The NULL branch safely adopts records created by pre-session daemons,
      // after allowing their normal send/report window to expire.
      if (daemonSessionId) {
        await env.DB.prepare(`
          UPDATE messages
          SET status = 'unknown',
              error_message = 'Daemon restarted before confirming SMS delivery; delivery status is unknown',
              processing_session_id = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE type = 'sent'
            AND status = 'processing'
            AND (
              (processing_session_id IS NOT NULL AND processing_session_id <> ?)
              OR (
                processing_session_id IS NULL
                AND datetime(updated_at) <= datetime('now', '-5 minutes')
              )
            )
        `).bind(daemonSessionId).run();
      }
      
      // Get pending SMS messages and atomically mark as 'processing' to prevent duplicate sends
      // This prevents the race condition where daemon polls again before status update completes

      // First, get IDs of pending messages
      const pendingIds = await env.DB.prepare(`
        SELECT id
        FROM (
          SELECT
            id,
            purpose,
            created_at,
            ROW_NUMBER() OVER (PARTITION BY purpose ORDER BY created_at, id) AS purpose_rank
          FROM messages
          WHERE type = 'sent' AND status = 'sending'
        ) pending
        WHERE purpose != 'balance_maintenance' OR purpose_rank <= 5
        ORDER BY CASE WHEN purpose = 'balance_maintenance' THEN 1 ELSE 0 END,
                 created_at,
                 id
        LIMIT 50
      `).all();

      if (!pendingIds.results || pendingIds.results.length === 0) {
        return new Response(JSON.stringify({
          success: true,
          pending_messages: []
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Atomically update status to 'processing' and fetch message details
      const ids = pendingIds.results.map(row => row.id);
      const placeholders = ids.map(() => '?').join(',');

      // Update to 'processing' status
      await env.DB.prepare(`
        UPDATE messages
        SET status = 'processing',
            processing_session_id = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
      `).bind(daemonSessionId, ...ids).run();

      // Fetch the updated messages
      const messages = await env.DB.prepare(`
        SELECT id, phone_iccid, phone_number, content, recipient, purpose, created_at
        FROM messages
        WHERE id IN (${placeholders})
        ORDER BY created_at ASC
      `).bind(...ids).all();

      return new Response(JSON.stringify({
        success: true,
        pending_messages: messages.results || []
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
        SET status = ?, error_message = ?, sms_id = ?,
            processing_session_id = NULL, updated_at = CURRENT_TIMESTAMP
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

      await updateBalanceCheckForSmsResult(
        env.DB,
        message_id,
        Boolean(success),
        error_message || null,
      );
      
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
      const body = await request.json();
      const clientIp = request.headers.get('CF-Connecting-IP') ||
        request.headers.get('X-Forwarded-For') || 'unknown';

      if (body.schema_version === HEALTH_SCHEMA_VERSION) {
        const snapshot = normalizeHealthSnapshot(body);
        await env.DB.prepare(`
          INSERT INTO daemon_health (
            daemon_id, last_heartbeat, status, last_ip, version, modem_count,
            error_count, metadata, current_session_id, updated_at
          ) VALUES (
            'orange-pi-main', CURRENT_TIMESTAMP, 'online', ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP
          )
          ON CONFLICT(daemon_id) DO UPDATE SET
            last_heartbeat = CURRENT_TIMESTAMP,
            status = 'online',
            last_ip = excluded.last_ip,
            version = excluded.version,
            modem_count = excluded.modem_count,
            error_count = excluded.error_count,
            metadata = excluded.metadata,
            current_session_id = excluded.current_session_id,
            updated_at = CURRENT_TIMESTAMP
        `).bind(
          clientIp,
          snapshot.version,
          snapshot.modems.discovered,
          JSON.stringify(snapshot),
          snapshot.session_id,
        ).run();

        console.log(`[control.js] Health snapshot received: session=${snapshot.session_id}, version=${snapshot.version}`);
      } else {
        // Compatibility for older daemons that used the explicit endpoint without
        // task telemetry. This path can be removed after the fleet is upgraded.
        const deviceId = typeof body.device_id === 'string' ? body.device_id : 'orange-pi-main';
        const version = typeof body.version === 'string' ? body.version.slice(0, 80) : 'unknown';
        await env.DB.prepare(`
          INSERT INTO daemon_health (daemon_id, last_heartbeat, status, last_ip, version, updated_at)
          VALUES ('orange-pi-main', CURRENT_TIMESTAMP, 'online', ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(daemon_id) DO UPDATE SET
            last_heartbeat = CURRENT_TIMESTAMP,
            status = 'online',
            last_ip = excluded.last_ip,
            version = excluded.version,
            updated_at = CURRENT_TIMESTAMP
        `).bind(clientIp, version).run();
        console.log(`[control.js] Legacy heartbeat received: device=${deviceId}, version=${version}`);
      }
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Heartbeat received',
        received_at: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[control.js] Heartbeat error:', error);
      console.error('[control.js] Heartbeat error stack:', error.stack);
      console.error('[control.js] Heartbeat error message:', error.message);
      const status = error.message?.startsWith('Unsupported health schema') ||
        error.message?.includes('required') ? 400 : 500;
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to process heartbeat: ${error.message}`
      }), {
        status,
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
