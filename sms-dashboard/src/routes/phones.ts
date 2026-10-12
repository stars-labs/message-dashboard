import { Elysia, t } from 'elysia';
import { eq, sql, desc, like, and, or } from 'drizzle-orm';
import { phones, sims, modems, modem_state, iccid_mappings } from '../db/schema';
import { requirePermission } from '../middleware/auth';

export const phonesRoutes = new Elysia({ prefix: '/phones' })
  // Get all phones with details
  .get('/', async ({ db, query }) => {
    const { search, status, carrier, limit = '100', offset = '0' } = query;
    
    // Build query with filters
    let baseQuery = db
      .select({
        iccid: phones.iccid,
        number: sql<string>`COALESCE(${iccid_mappings.phone_number}, ${phones.number})`,
        country: sql<string>`COALESCE(${iccid_mappings.country}, ${phones.country})`,
        flag: phones.flag,
        carrier: sql<string>`COALESCE(${iccid_mappings.carrier}, ${phones.carrier})`,
        status: phones.status,
        signal: phones.signal,
        rssi: phones.rssi,
        rsrq: phones.rsrq,
        rsrp: phones.rsrp,
        snr: phones.snr,
        operator_name: phones.operator_name,
        operator_id: phones.operator_id,
        imei: phones.imei,
        access_tech: phones.access_tech,
        modem_index: phones.modem_index,
        sim_index: phones.sim_index,
        created_at: phones.created_at,
        updated_at: phones.updated_at,
        mapped_number: iccid_mappings.phone_number,
        mapped_carrier: iccid_mappings.carrier,
        mapped_country: iccid_mappings.country,
        mapping_notes: iccid_mappings.notes
      })
      .from(phones)
      .leftJoin(iccid_mappings, and(
        eq(phones.iccid, iccid_mappings.iccid),
        eq(iccid_mappings.is_active, true)
      ));
    
    // Apply filters
    const conditions = [];
    
    if (search) {
      conditions.push(or(
        like(phones.number, `%${search}%`),
        like(phones.iccid, `%${search}%`),
        like(phones.carrier, `%${search}%`),
        like(iccid_mappings.phone_number, `%${search}%`)
      ));
    }
    
    if (status) {
      conditions.push(eq(phones.status, status));
    }
    
    if (carrier) {
      conditions.push(or(
        eq(phones.carrier, carrier),
        eq(iccid_mappings.carrier, carrier)
      ));
    }
    
    if (conditions.length > 0) {
      baseQuery = baseQuery.where(and(...conditions));
    }
    
    // Add ordering and pagination
    const results = await baseQuery
      .orderBy(desc(phones.updated_at))
      .limit(parseInt(limit))
      .offset(parseInt(offset));
    
    return results;
  }, {
    query: t.Object({
      search: t.Optional(t.String()),
      status: t.Optional(t.String()),
      carrier: t.Optional(t.String()),
      limit: t.Optional(t.String()),
      offset: t.Optional(t.String())
    })
  })
  
  // Get single phone by ICCID
  .get('/:iccid', async ({ db, params }) => {
    const { iccid } = params;
    
    const result = await db
      .select({
        iccid: phones.iccid,
        number: sql<string>`COALESCE(${iccid_mappings.phone_number}, ${phones.number})`,
        country: sql<string>`COALESCE(${iccid_mappings.country}, ${phones.country})`,
        flag: phones.flag,
        carrier: sql<string>`COALESCE(${iccid_mappings.carrier}, ${phones.carrier})`,
        status: phones.status,
        signal: phones.signal,
        rssi: phones.rssi,
        rsrq: phones.rsrq,
        rsrp: phones.rsrp,
        snr: phones.snr,
        operator_name: phones.operator_name,
        operator_id: phones.operator_id,
        imei: phones.imei,
        access_tech: phones.access_tech,
        modem_index: phones.modem_index,
        sim_index: phones.sim_index,
        created_at: phones.created_at,
        updated_at: phones.updated_at,
        mapped_number: iccid_mappings.phone_number,
        mapped_carrier: iccid_mappings.carrier,
        mapped_country: iccid_mappings.country,
        mapping_notes: iccid_mappings.notes
      })
      .from(phones)
      .leftJoin(iccid_mappings, and(
        eq(phones.iccid, iccid_mappings.iccid),
        eq(iccid_mappings.is_active, true)
      ))
      .where(eq(phones.iccid, iccid))
      .limit(1);
    
    if (result.length === 0) {
      throw new Error('Phone not found');
    }
    
    return result[0];
  }, {
    params: t.Object({
      iccid: t.String()
    })
  })
  
  // Update phone details (requires permission)
  .use(requirePermission('phones.write'))
  .put('/:iccid', async ({ db, params, body }) => {
    const { iccid } = params;
    
    await db.update(phones)
      .set({
        ...body,
        updated_at: sql`CURRENT_TIMESTAMP`
      })
      .where(eq(phones.iccid, iccid));
    
    return { success: true };
  }, {
    params: t.Object({
      iccid: t.String()
    }),
    body: t.Object({
      number: t.Optional(t.String()),
      country: t.Optional(t.String()),
      flag: t.Optional(t.String()),
      carrier: t.Optional(t.String()),
      status: t.Optional(t.String())
    })
  })
  
  // Delete phone (requires permission)
  .delete('/:iccid', async ({ db, params }) => {
    const { iccid } = params;
    
    await db.delete(phones)
      .where(eq(phones.iccid, iccid));
    
    return { success: true };
  }, {
    params: t.Object({
      iccid: t.String()
    })
  });