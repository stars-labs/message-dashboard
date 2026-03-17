// ICCID Mappings handler - manages user-authoritative sims table
// New schema: sims table is purely user-managed, status computed dynamically
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
          equipment_id,
          notes,
          sim_status as is_active,
          signal_quality,
          modem_status,
          detected_iccid,
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
          country, carrier, equipment_id, notes,
          sim_status as is_active, signal_quality, modem_status, detected_iccid,
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
          country, carrier, equipment_id, notes,
          sim_status as is_active, signal_quality, modem_status, detected_iccid,
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
      const { iccid, phone_number, sim_index, country_code, carrier, imei, notes } = data;

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
        SELECT iccid FROM sims WHERE iccid = ?
      `).bind(iccid).first();

      if (!simExists) {
        // INSERT new SIM (NO status field - computed dynamically)
        await env.DB.prepare(`
          INSERT INTO sims (iccid, sim_index, phone_number, country_code, carrier, imei, notes, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
        `).bind(
          iccid,
          sim_index,
          phone_number,
          country_code || null,
          carrier || null,
          imei || null,
          notes || null,
          user?.email || 'system'
        ).run();
      } else {
        // UPDATE existing SIM (NO status field - computed dynamically)
        await env.DB.prepare(`
          UPDATE sims
          SET sim_index = ?, phone_number = ?, country_code = ?, carrier = ?, imei = ?, notes = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
          WHERE iccid = ?
        `).bind(
          sim_index,
          phone_number,
          country_code || null,
          carrier || null,
          imei || null,
          notes || null,
          user?.email || 'system',
          iccid
        ).run();
      }

      // Return updated mapping with computed status from device_view
      const mapping = await env.DB.prepare(`
        SELECT
          iccid, sim_index, number as phone_number,
          country as country_code, carrier, equipment_id as imei,
          notes, sim_status as status,
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
      const { phone_number, sim_index, country_code, carrier, imei, notes } = data;

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
        user?.email || 'system',
        id
      ).run();

      // Return updated mapping with computed status from device_view
      const mapping = await env.DB.prepare(`
        SELECT
          iccid as id, iccid, sim_index, number as phone_number,
          country, carrier, equipment_id, notes,
          sim_status as is_active,
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
      // Actually delete the SIM from sims table
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
            SELECT iccid FROM sims WHERE iccid = ?
          `).bind(iccid).first();

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
              user?.email || 'system',
              iccid
            ).run();
            updated++;
          } else {
            // Create new
            await env.DB.prepare(`
              INSERT INTO sims (iccid, sim_index, phone_number, country_code, carrier, imei, notes, updated_at, updated_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
            `).bind(
              iccid,
              sim_index,
              phone_number,
              country_code || null,
              carrier || null,
              imei || null,
              notes || null,
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
