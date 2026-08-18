// ICCID Mappings handler - manages user-authoritative sims table
// New schema: sims table is purely user-managed, status computed dynamically
export const SIM_SERVICE_TYPES = ['unknown', 'prepaid', 'postpaid', 'n/a'];
export const SIM_SERVICE_TYPE_SOURCES = [
  'carrier_account',
  'carrier_support',
  'contract_or_bill',
  'carrier_message',
];

export const SIM_ROLES = ['standalone', 'primary', 'secondary'];

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Coerce the per-SIM balance threshold from the API payload into a nullable
 * number. Empty string / null / undefined → null (fall back to the currency
 * default in the client lib). Non-finite values are also rejected to null.
 */
function parseBalanceThreshold(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function resolveServiceType(data, existing = null) {
  const serviceTypeProvided = hasOwn(data, 'service_type') || hasOwn(data, 'service_type_source');
  const serviceType = hasOwn(data, 'service_type')
    ? String(data.service_type || 'unknown')
    : existing?.service_type || 'unknown';

  if (!SIM_SERVICE_TYPES.includes(serviceType)) {
    return { error: 'service_type must be unknown, prepaid, postpaid, or n/a' };
  }

  if (serviceType === 'unknown' || serviceType === 'n/a') {
    return { serviceType, serviceTypeSource: null, serviceTypeProvided };
  }

  const serviceTypeSource = hasOwn(data, 'service_type_source')
    ? data.service_type_source || null
    : existing?.service_type_source || null;

  if (!SIM_SERVICE_TYPE_SOURCES.includes(serviceTypeSource)) {
    return {
      error: 'A valid service_type_source is required for prepaid or postpaid SIMs',
    };
  }

  return { serviceType, serviceTypeSource, serviceTypeProvided };
}

/**
 * Resolve the primary/secondary role for a SIM. Unlike resolveServiceType,
 * this is async: a secondary must point at a real primary SIM, which requires
 * a cross-row DB lookup the SQL triggers cannot do safely.
 *
 * Returns { role, primaryIccid, roleProvided } or { error }.
 */
export async function resolveSimRole(data, existing, env) {
  const roleProvided = hasOwn(data, 'sim_role') || hasOwn(data, 'primary_iccid');
  const role = hasOwn(data, 'sim_role')
    ? String(data.sim_role || 'standalone')
    : existing?.sim_role || 'standalone';

  if (!SIM_ROLES.includes(role)) {
    return { error: 'sim_role must be standalone, primary, or secondary' };
  }

  let primaryIccid = null;
  if (role === 'secondary') {
    primaryIccid = hasOwn(data, 'primary_iccid')
      ? (data.primary_iccid || null)
      : (existing?.primary_iccid || null);
    if (!primaryIccid) {
      return { error: 'primary_iccid is required for a secondary SIM' };
    }
    const target = await env.DB.prepare(
      'SELECT sim_role FROM sims WHERE iccid = ?'
    ).bind(primaryIccid).first();
    if (!target) return { error: 'primary_iccid does not match any SIM' };
    if (target.sim_role !== 'primary') {
      return { error: `primary_iccid points to a ${target.sim_role} SIM, not a primary` };
    }
  }

  return { role, primaryIccid, roleProvided };
}

function badRequest(error) {
  return new Response(JSON.stringify({ success: false, error }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const iccidMappingsHandler = {
  // List all ICCID mappings with pagination
  async list(request) {
    const { env } = request;
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const search = url.searchParams.get('search') || '';
    const offset = (page - 1) * limit;

    try {
      let query = `
        SELECT
          iccid as id,
          iccid,
          sim_index,
          number as phone_number,
          country,
          carrier,
          service_type,
          service_type_source,
          service_type_verified_at,
          sim_role,
          primary_iccid,
          balance_threshold,
          equipment_id,
          notes,
          sim_status as is_active,
          signal_quality,
          modem_status,
          detected_iccid,
          operator,
          usb_path,
          last_usb_path,
          created_at,
          updated_at
        FROM device_view
        WHERE 1=1
      `;
      const params = [];

      if (search) {
        query += ` AND (iccid LIKE ? OR number LIKE ? OR carrier LIKE ? OR notes LIKE ?)`;
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern, searchPattern);
      }

      query += ` ORDER BY sim_index ASC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const result = await env.DB.prepare(query).bind(...params).all();
      const mappings = result.results || result;

      // Get total count
      let countQuery = `SELECT COUNT(*) as total FROM device_view WHERE 1=1`;
      const countParams = [];

      if (search) {
        countQuery += ` AND (iccid LIKE ? OR number LIKE ? OR carrier LIKE ? OR notes LIKE ?)`;
        const searchPattern = `%${search}%`;
        countParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
      }

      const totalResult = await env.DB.prepare(countQuery).bind(...countParams).first();
      const total = totalResult?.total || 0;

      return new Response(JSON.stringify({
        success: true,
        data: mappings,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[iccid-mappings.js] Error listing ICCID mappings:', error);
      console.error('[iccid-mappings.js] Error stack:', error.stack);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch ICCID mappings',
        details: error.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Get a specific ICCID mapping
  async get(request) {
    const { env, params } = request;
    const { id } = params;

    try {
      const mapping = await env.DB.prepare(`
        SELECT
          iccid as id, iccid, sim_index, number as phone_number,
          country, carrier, service_type, service_type_source,
          service_type_verified_at, equipment_id, notes,
          sim_status as is_active, signal_quality, modem_status, detected_iccid,
          operator, usb_path, last_usb_path, sim_role, primary_iccid,
          created_at, updated_at
        FROM device_view
        WHERE iccid = ?
      `).bind(id).first();

      if (!mapping) {
        return new Response(JSON.stringify({
          success: false,
          error: 'ICCID mapping not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        data: mapping
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[iccid-mappings.js] Error fetching ICCID mapping:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch ICCID mapping'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Get mapping by ICCID
  async getByIccid(request) {
    const { env, params } = request;
    const { iccid } = params;

    try {
      const mapping = await env.DB.prepare(`
        SELECT
          iccid as id, iccid, sim_index, number as phone_number,
          country, carrier, service_type, service_type_source,
          service_type_verified_at, equipment_id, notes,
          sim_status as is_active, signal_quality, modem_status, detected_iccid,
          operator, usb_path, last_usb_path, sim_role, primary_iccid,
          created_at, updated_at
        FROM device_view
        WHERE iccid = ?
      `).bind(iccid).first();

      if (!mapping) {
        return new Response(JSON.stringify({
          success: false,
          error: 'ICCID not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        data: mapping
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[iccid-mappings.js] Error fetching ICCID by ID:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch ICCID mapping'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Create or update ICCID mapping
  async create(request) {
    const { env, user } = request;
    const data = await request.json();

    try {
      const {
        iccid,
        phone_number,
        sim_index,
        country_code,
        carrier,
        imei,
        notes,
      } = data;
      const balanceThreshold = parseBalanceThreshold(data.balance_threshold);

      if (!iccid || !phone_number || !sim_index) {
        return new Response(JSON.stringify({
          success: false,
          error: 'ICCID, phone number, and sim_index are required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Check if SIM exists
      const simExists = await env.DB.prepare(`
        SELECT iccid, service_type, service_type_source, sim_role, primary_iccid
        FROM sims WHERE iccid = ?
      `).bind(iccid).first();
      const service = resolveServiceType(data, simExists);
      if (service.error) return badRequest(service.error);
      const role = await resolveSimRole(data, simExists, env);
      if (role.error) return badRequest(role.error);

      if (!simExists) {
        // INSERT new SIM (NO status field - computed dynamically)
        await env.DB.prepare(`
          INSERT INTO sims (
            iccid, sim_index, phone_number, country_code, carrier, imei, notes,
            service_type, service_type_source, service_type_verified_at,
            sim_role, primary_iccid, balance_threshold,
            updated_at, updated_by
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
            CASE WHEN ? = 'unknown' OR ? = 'n/a' THEN NULL ELSE CURRENT_TIMESTAMP END,
            ?, ?, ?,
            CURRENT_TIMESTAMP, ?)
        `).bind(
          iccid,
          sim_index,
          phone_number,
          country_code || null,
          carrier || null,
          imei || null,
          notes || null,
          service.serviceType,
          service.serviceTypeSource,
          service.serviceType,
          service.serviceType,
          role.role,
          role.primaryIccid,
          balanceThreshold,
          user?.email || 'system'
        ).run();
      } else {
        // UPDATE existing SIM (NO status field - computed dynamically)
        await env.DB.prepare(`
          UPDATE sims
          SET sim_index = ?, phone_number = ?, country_code = ?, carrier = ?, imei = ?, notes = ?,
              service_type = ?, service_type_source = ?,
              service_type_verified_at = CASE
                WHEN ? = 0 THEN service_type_verified_at
                WHEN ? = 'unknown' OR ? = 'n/a' THEN NULL
                ELSE CURRENT_TIMESTAMP
              END,
              sim_role = ?,
              primary_iccid = ?,
              balance_threshold = ?,
              updated_at = CURRENT_TIMESTAMP, updated_by = ?
          WHERE iccid = ?
        `).bind(
          sim_index,
          phone_number,
          country_code || null,
          carrier || null,
          imei || null,
          notes || null,
          service.serviceType,
          service.serviceTypeSource,
          service.serviceTypeProvided ? 1 : 0,
          service.serviceType,
          service.serviceType,
          role.role,
          role.primaryIccid,
          balanceThreshold,
          user?.email || 'system',
          iccid
        ).run();
      }

      // Return updated mapping with computed status from device_view
      const mapping = await env.DB.prepare(`
        SELECT
          iccid, sim_index, number as phone_number,
          country as country_code, carrier, equipment_id as imei,
          notes, service_type, service_type_source, service_type_verified_at,
          sim_role, primary_iccid, balance_threshold,
          sim_status as status, usb_path, last_usb_path,
          created_at, updated_at
        FROM device_view
        WHERE iccid = ?
      `).bind(iccid).first();

      return new Response(JSON.stringify({
        success: true,
        data: mapping
      }), {
        status: simExists ? 200 : 201,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[iccid-mappings.js] Error creating ICCID mapping:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to create ICCID mapping',
        details: error.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Update an ICCID mapping
  async update(request) {
    const { env, params, user } = request;
    const { id } = params;
    const data = await request.json();

    try {
      const {
        phone_number,
        sim_index,
        country_code,
        carrier,
        imei,
        notes,
      } = data;
      const balanceThreshold = parseBalanceThreshold(data.balance_threshold);

      const existing = await env.DB.prepare(`
        SELECT iccid, service_type, service_type_source, sim_role, primary_iccid
        FROM sims WHERE iccid = ?
      `).bind(id).first();
      if (!existing) {
        return new Response(JSON.stringify({
          success: false,
          error: 'ICCID mapping not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const service = resolveServiceType(data, existing);
      if (service.error) return badRequest(service.error);
      const role = await resolveSimRole(data, existing, env);
      if (role.error) return badRequest(role.error);

      // Update sims table (NO status field)
      await env.DB.prepare(`
        UPDATE sims
        SET
          phone_number = ?,
          sim_index = ?,
          country_code = ?,
          carrier = ?,
          imei = ?,
          notes = ?,
          service_type = ?,
          service_type_source = ?,
          service_type_verified_at = CASE
            WHEN ? = 0 THEN service_type_verified_at
            WHEN ? = 'unknown' OR ? = 'n/a' THEN NULL
            ELSE CURRENT_TIMESTAMP
          END,
          sim_role = ?,
          primary_iccid = ?,
          balance_threshold = ?,
          updated_at = CURRENT_TIMESTAMP,
          updated_by = ?
        WHERE iccid = ?
      `).bind(
        phone_number || null,
        sim_index || null,
        country_code || null,
        carrier || null,
        imei || null,
        notes || null,
        service.serviceType,
        service.serviceTypeSource,
        service.serviceTypeProvided ? 1 : 0,
        service.serviceType,
        service.serviceType,
        role.role,
        role.primaryIccid,
        balanceThreshold,
        user?.email || 'system',
        id
      ).run();

      // Return updated mapping with computed status from device_view
      const mapping = await env.DB.prepare(`
        SELECT
          iccid as id, iccid, sim_index, number as phone_number,
          country, carrier, service_type, service_type_source,
          service_type_verified_at, sim_role, primary_iccid, balance_threshold,
          equipment_id, notes,
          sim_status as is_active, usb_path, last_usb_path,
          created_at, updated_at
        FROM device_view
        WHERE iccid = ?
      `).bind(id).first();

      if (!mapping) {
        return new Response(JSON.stringify({
          success: false,
          error: 'ICCID mapping not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        data: mapping
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[iccid-mappings.js] Error updating ICCID mapping:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to update ICCID mapping'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Delete an ICCID mapping
  async delete(request) {
    const { env, params } = request;
    const { id } = params;

    try {
      // Actually delete the SIM from sims table. If this SIM is a primary with
      // secondaries still attached, the ON DELETE RESTRICT FK aborts.
      await env.DB.prepare(`
        DELETE FROM sims WHERE iccid = ?
      `).bind(id).run();

      return new Response(JSON.stringify({
        success: true,
        message: 'ICCID mapping deleted successfully'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      if (/FOREIGN KEY constraint failed/i.test(error?.message || '')) {
        return new Response(JSON.stringify({
          success: false,
          error: 'This is a primary SIM with secondary SIMs still attached. Set them back to standalone first.'
        }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      console.error('[iccid-mappings.js] Error deleting ICCID mapping:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to delete ICCID mapping'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Bulk import ICCID mappings
  async bulkImport(request) {
    const { env, user } = request;
    const { mappings } = await request.json();

    if (!Array.isArray(mappings)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Mappings must be an array'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      let created = 0;
      let updated = 0;
      let failed = 0;
      const errors = [];

      for (const mapping of mappings) {
        try {
          const { iccid, phone_number, sim_index, country_code, carrier, imei, notes } = mapping;

          if (!iccid || !phone_number || !sim_index) {
            failed++;
            errors.push(`Missing required fields for mapping: ${JSON.stringify(mapping)}`);
            continue;
          }

          // Check if SIM exists
          const existing = await env.DB.prepare(`
            SELECT iccid, service_type, service_type_source, sim_role, primary_iccid
            FROM sims WHERE iccid = ?
          `).bind(iccid).first();
          const service = resolveServiceType(mapping, existing);
          if (service.error) {
            failed++;
            errors.push(`Invalid service type for ICCID ${iccid}: ${service.error}`);
            continue;
          }
          const role = await resolveSimRole(mapping, existing, env);
          if (role.error) {
            failed++;
            errors.push(`Invalid SIM role for ICCID ${iccid}: ${role.error}`);
            continue;
          }

          if (existing) {
            // Update existing
            await env.DB.prepare(`
              UPDATE sims
              SET
                sim_index = ?,
                phone_number = ?,
                country_code = ?,
                carrier = ?,
                imei = ?,
                notes = ?,
                service_type = ?,
                service_type_source = ?,
                service_type_verified_at = CASE
                  WHEN ? = 0 THEN service_type_verified_at
                  WHEN ? = 'unknown' OR ? = 'n/a' THEN NULL
                  ELSE CURRENT_TIMESTAMP
                END,
                sim_role = ?,
                primary_iccid = ?,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = ?
              WHERE iccid = ?
            `).bind(
              sim_index,
              phone_number,
              country_code || null,
              carrier || null,
              imei || null,
              notes || null,
              service.serviceType,
              service.serviceTypeSource,
              service.serviceTypeProvided ? 1 : 0,
              service.serviceType,
              service.serviceType,
              role.role,
              role.primaryIccid,
              user?.email || 'system',
              iccid
            ).run();
            updated++;
          } else {
            // Create new
            await env.DB.prepare(`
              INSERT INTO sims (
                iccid, sim_index, phone_number, country_code, carrier, imei, notes,
                service_type, service_type_source, service_type_verified_at,
                sim_role, primary_iccid,
                updated_at, updated_by
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
                CASE WHEN ? = 'unknown' OR ? = 'n/a' THEN NULL ELSE CURRENT_TIMESTAMP END,
                ?, ?,
                CURRENT_TIMESTAMP, ?)
            `).bind(
              iccid,
              sim_index,
              phone_number,
              country_code || null,
              carrier || null,
              imei || null,
              notes || null,
              service.serviceType,
              service.serviceTypeSource,
              service.serviceType,
              service.serviceType,
              role.role,
              role.primaryIccid,
              user?.email || 'system'
            ).run();
            created++;
          }
        } catch (error) {
          failed++;
          errors.push(`Failed to import mapping for ICCID ${mapping.iccid}: ${error.message}`);
        }
      }

      return new Response(JSON.stringify({
        success: true,
        summary: {
          total: mappings.length,
          created,
          updated,
          failed
        },
        errors: errors.length > 0 ? errors : undefined
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[iccid-mappings.js] Error in bulk import:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to import ICCID mappings',
        details: error.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
