import { Elysia, t } from 'elysia';
import { eq, sql, and, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { modems, modem_state, sims, phones, messages, daemon_health } from '../db/schema';

// Helper to extract verification code from message
function extractVerificationCode(content: string): string | null {
  const patterns = [
    /(\d{4,8})/,
    /code:?\s*(\d{4,8})/i,
    /verification:?\s*(\d{4,8})/i,
    /otp:?\s*(\d{4,8})/i
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

export const controlRoutes = new Elysia({ prefix: '/control' })
  // Middleware to check API key for control endpoints
  .derive(({ headers, env, set }) => {
    const apiKey = headers['x-api-key'];
    if (apiKey !== env.API_KEY) {
      set.status = 401;
      throw new Error('Invalid API key');
    }
    return {};
  })
  
  // Update phones (legacy endpoint for backward compatibility)
  .post('/phones', async ({ db, body }) => {
    const { phones: phoneData } = body;
    console.log(`[Control] Received ${phoneData.length} phones`);
    
    const results = [];
    
    // Use transaction for atomic updates
    await db.transaction(async (tx) => {
      for (const phone of phoneData) {
        // Skip phones without ICCID
        if (!phone.iccid) {
          console.warn('[Control] Skipping phone without ICCID');
          continue;
        }
        
        // Update modems table if we have IMEI
        if (phone.imei) {
          await tx.insert(modems)
            .values({
              equipment_id: phone.imei,
              manufacturer: phone.manufacturer,
              model: phone.model,
              firmware_revision: phone.firmware_revision,
              hardware_revision: phone.hardware_revision,
              status: phone.status === 'online' ? 'connected' : 'disconnected',
              modem_index: phone.modem_index
            })
            .onConflictDoUpdate({
              target: modems.equipment_id,
              set: {
                status: phone.status === 'online' ? 'connected' : 'disconnected',
                modem_index: phone.modem_index,
                updated_at: sql`CURRENT_TIMESTAMP`
              }
            });
          
          // Update modem state
          if (phone.signal !== undefined || phone.rssi !== undefined) {
            await tx.insert(modem_state)
              .values({
                modem_id: phone.imei,
                signal_percent: phone.signal,
                rssi: phone.rssi,
                rsrq: phone.rsrq,
                rsrp: phone.rsrp,
                snr: phone.snr,
                access_tech: phone.access_tech,
                modem_index: phone.modem_index,
                sim_index: phone.sim_index
              })
              .onConflictDoUpdate({
                target: modem_state.modem_id,
                set: {
                  signal_percent: phone.signal,
                  rssi: phone.rssi,
                  rsrq: phone.rsrq,
                  rsrp: phone.rsrp,
                  snr: phone.snr,
                  access_tech: phone.access_tech,
                  modem_index: phone.modem_index,
                  sim_index: phone.sim_index,
                  updated_at: sql`CURRENT_TIMESTAMP`
                }
              });
          }
        }
        
        // Update SIMs table
        await tx.insert(sims)
          .values({
            iccid: phone.iccid,
            phone_number: phone.number,
            carrier: phone.carrier,
            operator_name: phone.operator_name,
            operator_id: phone.operator_id,
            status: phone.status === 'online' ? 'active' : 'inactive',
            current_modem_id: phone.imei,
            sim_index: phone.sim_index
          })
          .onConflictDoUpdate({
            target: sims.iccid,
            set: {
              phone_number: phone.number,
              carrier: phone.carrier,
              operator_name: phone.operator_name,
              operator_id: phone.operator_id,
              status: phone.status === 'online' ? 'active' : 'inactive',
              current_modem_id: phone.imei,
              sim_index: phone.sim_index,
              updated_at: sql`CURRENT_TIMESTAMP`
            }
          });
        
        // Update legacy phones table for backward compatibility
        await tx.insert(phones)
          .values({
            iccid: phone.iccid,
            number: phone.number,
            country: phone.country,
            flag: phone.flag,
            carrier: phone.carrier,
            status: phone.status,
            signal: phone.signal,
            rssi: phone.rssi,
            rsrq: phone.rsrq,
            rsrp: phone.rsrp,
            snr: phone.snr,
            operator_name: phone.operator_name,
            operator_id: phone.operator_id,
            imei: phone.imei,
            access_tech: phone.access_tech,
            modem_index: phone.modem_index,
            sim_index: phone.sim_index
          })
          .onConflictDoUpdate({
            target: phones.iccid,
            set: {
              number: phone.number,
              country: phone.country,
              flag: phone.flag,
              carrier: phone.carrier,
              status: phone.status,
              signal: phone.signal,
              rssi: phone.rssi,
              rsrq: phone.rsrq,
              rsrp: phone.rsrp,
              snr: phone.snr,
              operator_name: phone.operator_name,
              operator_id: phone.operator_id,
              imei: phone.imei,
              access_tech: phone.access_tech,
              modem_index: phone.modem_index,
              sim_index: phone.sim_index,
              updated_at: sql`CURRENT_TIMESTAMP`
            }
          });
        
        results.push({ iccid: phone.iccid, status: 'updated' });
      }
    });
    
    // Mark offline phones not in update
    const receivedIccids = phoneData.map(p => p.iccid).filter(Boolean);
    if (receivedIccids.length > 0) {
      await db.update(phones)
        .set({ 
          status: 'offline',
          updated_at: sql`CURRENT_TIMESTAMP`
        })
        .where(sql`iccid NOT IN (${sql.join(receivedIccids.map(id => sql`${id}`), sql`, `)})`);
    }
    
    return { 
      success: true,
      processed: results.length,
      results
    };
  }, {
    body: t.Object({
      phones: t.Array(t.Object({
        iccid: t.String(),
        number: t.Optional(t.String()),
        country: t.Optional(t.String()),
        flag: t.Optional(t.String()),
        carrier: t.Optional(t.String()),
        status: t.Optional(t.String()),
        signal: t.Optional(t.Number()),
        rssi: t.Optional(t.Number()),
        rsrq: t.Optional(t.Number()),
        rsrp: t.Optional(t.Number()),
        snr: t.Optional(t.Number()),
        operator_name: t.Optional(t.String()),
        operator_id: t.Optional(t.String()),
        imei: t.Optional(t.String()),
        access_tech: t.Optional(t.String()),
        modem_index: t.Optional(t.Number()),
        sim_index: t.Optional(t.Number()),
        manufacturer: t.Optional(t.String()),
        model: t.Optional(t.String()),
        firmware_revision: t.Optional(t.String()),
        hardware_revision: t.Optional(t.String())
      }))
    })
  })
  
  // Update messages
  .post('/messages', async ({ db, body, ai }) => {
    const { messages: messageData } = body;
    console.log(`[Control] Received ${messageData.length} messages`);
    
    const newMessages = [];
    
    for (const msg of messageData) {
      const id = nanoid();
      const verificationCode = extractVerificationCode(msg.content);
      
      // Insert message
      await db.insert(messages).values({
        id,
        phone_iccid: msg.phone_iccid,
        phone_number: msg.phone_number,
        content: msg.content,
        type: 'received',
        timestamp: msg.timestamp || sql`CURRENT_TIMESTAMP`,
        verification_code: verificationCode,
        status: 'received'
      });
      
      newMessages.push({
        id,
        ...msg,
        verification_code: verificationCode
      });
      
      // Generate embedding if AI is available
      try {
        if (ai) {
          const embedding = await ai.generateEmbedding(msg.content);
          // Store embedding in vectorize if available
          // This would need additional implementation
        }
      } catch (error) {
        console.error('[Control] Failed to generate embedding:', error);
      }
    }
    
    return {
      success: true,
      messages: newMessages
    };
  }, {
    body: t.Object({
      messages: t.Array(t.Object({
        phone_iccid: t.String(),
        phone_number: t.Optional(t.String()),
        content: t.String(),
        timestamp: t.Optional(t.String())
      }))
    })
  })
  
  // Daemon health update
  .post('/daemon/health', async ({ db, body }) => {
    const { daemon_id, ...healthData } = body;
    
    await db.insert(daemon_health)
      .values({
        daemon_id,
        ...healthData
      })
      .onConflictDoUpdate({
        target: daemon_health.daemon_id,
        set: {
          ...healthData,
          updated_at: sql`CURRENT_TIMESTAMP`
        }
      });
    
    return { success: true };
  }, {
    body: t.Object({
      daemon_id: t.String(),
      hostname: t.Optional(t.String()),
      ip_address: t.Optional(t.String()),
      version: t.Optional(t.String()),
      status: t.Optional(t.String()),
      connected_modems: t.Optional(t.Number()),
      active_sims: t.Optional(t.Number()),
      uptime_seconds: t.Optional(t.Number()),
      cpu_usage: t.Optional(t.Number()),
      memory_usage: t.Optional(t.Number()),
      error_count: t.Optional(t.Number()),
      last_error: t.Optional(t.String())
    })
  })
  
  // Get pending messages for sending
  .get('/messages/pending', async ({ db, query }) => {
    const { phone_iccid } = query;
    
    let baseQuery = db.select()
      .from(messages)
      .where(and(
        eq(messages.type, 'sent'),
        eq(messages.status, 'pending')
      ))
      .orderBy(desc(messages.created_at))
      .limit(10);
    
    if (phone_iccid) {
      baseQuery = db.select()
        .from(messages)
        .where(and(
          eq(messages.phone_iccid, phone_iccid),
          eq(messages.type, 'sent'),
          eq(messages.status, 'pending')
        ))
        .orderBy(desc(messages.created_at))
        .limit(10);
    }
    
    const pendingMessages = await baseQuery;
    
    return {
      pending_messages: pendingMessages.map(msg => ({
        id: msg.id,
        phone_iccid: msg.phone_iccid,
        recipient: msg.recipient,
        content: msg.content
      }))
    };
  }, {
    query: t.Object({
      phone_iccid: t.Optional(t.String())
    })
  })
  
  // Update message status
  .post('/messages/:id/status', async ({ db, params, body }) => {
    const { id } = params;
    const { status, error_message } = body;
    
    await db.update(messages)
      .set({
        status,
        error_message,
        updated_at: sql`CURRENT_TIMESTAMP`
      })
      .where(eq(messages.id, id));
    
    return { success: true };
  }, {
    params: t.Object({
      id: t.String()
    }),
    body: t.Object({
      status: t.String(),
      error_message: t.Optional(t.String())
    })
  });