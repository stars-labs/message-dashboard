import { eq, sql, and, or, desc } from 'drizzle-orm';
import { createDb } from '../db/client';
import { modems, sims, modem_state, iccid_mappings } from '../db/schema';
import type { Context } from 'hono';

// Custom type for our context with bindings
type AppContext = Context<{
  Bindings: {
    DB: D1Database;
    [key: string]: any;
  };
  Variables: {
    db: ReturnType<typeof createDb>;
    user?: any;
    userPermissions?: string[];
  };
}>;

export const phonesHandler = {
  // List all phones with a device_view-like query using Drizzle
  async list(c: AppContext) {
    const db = c.get('db');
    
    try {
      // Complex join query to replicate device_view
      const results = await db
        .select({
          // From sims table
          id: sims.iccid,
          iccid: sims.iccid,
          number: sql<string>`COALESCE(${iccid_mappings.phone_number}, ${sims.phone_number})`,
          country: sql<string>`COALESCE(${iccid_mappings.country}, 'Unknown')`,
          flag: sql<string>`
            CASE 
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'Indonesia' THEN '🇮🇩'
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'Malaysia' THEN '🇲🇾'
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'Singapore' THEN '🇸🇬'
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'Thailand' THEN '🇹🇭'
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'Philippines' THEN '🇵🇭'
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'Vietnam' THEN '🇻🇳'
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'USA' THEN '🇺🇸'
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'China' THEN '🇨🇳'
              ELSE '🏳️'
            END
          `,
          carrier: sql<string>`COALESCE(${iccid_mappings.carrier}, ${sims.carrier})`,
          status: sims.status,
          signal: modem_state.signal_percent,
          rssi: modem_state.rssi,
          rsrq: modem_state.rsrq,
          rsrp: modem_state.rsrp,
          snr: modem_state.snr,
          operator_name: sims.operator_name,
          operator_id: sims.operator_id,
          imei: modems.equipment_id,
          access_tech: modem_state.access_tech,
          modem_index: modems.modem_index,
          sim_index: sims.sim_index,
          created_at: modems.created_at,
          updated_at: sims.updated_at,
          // Mapping info
          mapped_number: iccid_mappings.phone_number,
          mapped_carrier: iccid_mappings.carrier,
          mapped_country: iccid_mappings.country,
          mapping_notes: iccid_mappings.notes,
          // Additional modem/SIM info
          modem_id: modems.equipment_id,
          modem_manufacturer: modems.manufacturer,
          modem_model: modems.model,
          modem_status: modems.status,
          sim_iccid: sims.iccid,
          sim_phone_number: sims.phone_number,
          sim_status: sims.status,
          usb_port: modems.usb_port
        })
        .from(sims)
        .leftJoin(modems, eq(sims.current_modem_id, modems.equipment_id))
        .leftJoin(modem_state, eq(modems.equipment_id, modem_state.modem_id))
        .leftJoin(
          iccid_mappings, 
          and(
            eq(sims.iccid, iccid_mappings.iccid),
            eq(iccid_mappings.is_active, true)
          )
        )
        .orderBy(modems.usb_port, sims.iccid);

      return c.json({
        success: true,
        data: results
      });
    } catch (error: any) {
      console.error('[Phones] List error:', error);
      return c.json({
        success: false,
        error: 'Failed to fetch phones'
      }, 500);
    }
  },

  // Get specific phone by ID
  async get(c: AppContext) {
    const db = c.get('db');
    const phoneId = c.req.param('id');
    
    try {
      const results = await db
        .select({
          id: sims.iccid,
          iccid: sims.iccid,
          number: sql<string>`COALESCE(${iccid_mappings.phone_number}, ${sims.phone_number})`,
          country: sql<string>`COALESCE(${iccid_mappings.country}, 'Unknown')`,
          flag: sql<string>`
            CASE 
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'Indonesia' THEN '🇮🇩'
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'Malaysia' THEN '🇲🇾'
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'Singapore' THEN '🇸🇬'
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'Thailand' THEN '🇹🇭'
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'Philippines' THEN '🇵🇭'
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'Vietnam' THEN '🇻🇳'
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'USA' THEN '🇺🇸'
              WHEN COALESCE(${iccid_mappings.country}, 'Unknown') = 'China' THEN '🇨🇳'
              ELSE '🏳️'
            END
          `,
          carrier: sql<string>`COALESCE(${iccid_mappings.carrier}, ${sims.carrier})`,
          status: sims.status,
          signal: modem_state.signal_percent,
          rssi: modem_state.rssi,
          rsrq: modem_state.rsrq,
          rsrp: modem_state.rsrp,
          snr: modem_state.snr,
          operator_name: sims.operator_name,
          operator_id: sims.operator_id,
          imei: modems.equipment_id,
          access_tech: modem_state.access_tech,
          modem_index: modems.modem_index,
          sim_index: sims.sim_index,
          created_at: modems.created_at,
          updated_at: sims.updated_at,
          // Mapping info
          mapped_number: iccid_mappings.phone_number,
          mapped_carrier: iccid_mappings.carrier,
          mapped_country: iccid_mappings.country,
          mapping_notes: iccid_mappings.notes,
          // Additional modem/SIM info
          modem_id: modems.equipment_id,
          modem_manufacturer: modems.manufacturer,
          modem_model: modems.model,
          modem_status: modems.status,
          sim_iccid: sims.iccid,
          sim_phone_number: sims.phone_number,
          sim_status: sims.status,
          usb_port: modems.usb_port
        })
        .from(sims)
        .leftJoin(modems, eq(sims.current_modem_id, modems.equipment_id))
        .leftJoin(modem_state, eq(modems.equipment_id, modem_state.modem_id))
        .leftJoin(
          iccid_mappings, 
          and(
            eq(sims.iccid, iccid_mappings.iccid),
            eq(iccid_mappings.is_active, true)
          )
        )
        .where(eq(sims.iccid, phoneId))
        .limit(1);

      if (results.length === 0) {
        return c.json({
          success: false,
          error: 'Phone not found'
        }, 404);
      }

      return c.json({
        success: true,
        data: results[0]
      });
    } catch (error: any) {
      console.error('[Phones] Get error:', error);
      return c.json({
        success: false,
        error: 'Failed to fetch phone'
      }, 500);
    }
  },

  // Update phone details
  async update(c: AppContext) {
    const db = c.get('db');
    const phoneId = c.req.param('id');
    const body = await c.req.json();
    
    try {
      // Update SIM details if provided
      if (body.phone_number || body.carrier || body.operator_name) {
        await db
          .update(sims)
          .set({
            phone_number: body.phone_number,
            carrier: body.carrier,
            operator_name: body.operator_name,
            updated_at: sql`CURRENT_TIMESTAMP`
          })
          .where(eq(sims.iccid, phoneId));
      }

      // Update modem state if signal info provided
      if (body.signal !== undefined || body.rssi !== undefined) {
        // Get the modem ID for this SIM
        const simRecord = await db
          .select({ modem_id: sims.current_modem_id })
          .from(sims)
          .where(eq(sims.iccid, phoneId))
          .limit(1);

        if (simRecord[0]?.modem_id) {
          await db
            .update(modem_state)
            .set({
              signal_percent: body.signal,
              rssi: body.rssi,
              rsrq: body.rsrq,
              rsrp: body.rsrp,
              snr: body.snr,
              updated_at: sql`CURRENT_TIMESTAMP`
            })
            .where(eq(modem_state.modem_id, simRecord[0].modem_id));
        }
      }

      return c.json({
        success: true,
        message: 'Phone updated successfully'
      });
    } catch (error: any) {
      console.error('[Phones] Update error:', error);
      return c.json({
        success: false,
        error: 'Failed to update phone'
      }, 500);
    }
  },

  // Delete phone (marks as inactive)
  async deletePhone(c: AppContext) {
    const db = c.get('db');
    const phoneId = c.req.param('id');
    
    try {
      await db
        .update(sims)
        .set({
          status: 'removed',
          current_modem_id: null,
          updated_at: sql`CURRENT_TIMESTAMP`
        })
        .where(eq(sims.iccid, phoneId));

      return c.json({
        success: true,
        message: 'Phone deleted successfully'
      });
    } catch (error: any) {
      console.error('[Phones] Delete error:', error);
      return c.json({
        success: false,
        error: 'Failed to delete phone'
      }, 500);
    }
  }
};