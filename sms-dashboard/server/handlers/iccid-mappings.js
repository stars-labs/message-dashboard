// ICCID Mappings handler - now uses user_overrides from sims table
export const iccidMappingsHandler = {
  // List all ICCID mappings (user overrides) with pagination
  async list(request) {
    const { env } = request;
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const search = url.searchParams.get('search') || '';
    const isActive = url.searchParams.get('active');
    const offset = (page - 1) * limit;
    
    try {
      // Query from sims table, treating user_override_enabled as the "mapping"
      let query = `
        SELECT
          iccid as id,
          iccid,
          COALESCE(user_phone_number, phone_number) as phone_number,
          COALESCE(user_carrier, carrier) as carrier,
          COALESCE(user_country_code, country_code) as country,
          user_notes as notes,
          user_override_enabled as is_active,
          current_modem_id as equipment_id,
          created_at,
          COALESCE(user_updated_at, updated_at) as updated_at
        FROM sims
        WHERE 1=1
      `;
      const params = [];
      
      // If filtering by active, only show ones with overrides
      if (isActive === 'true') {
        query += ` AND user_override_enabled = TRUE`;
      } else if (isActive === 'false') {
        query += ` AND (user_override_enabled = FALSE OR user_override_enabled IS NULL)`;
      }
      
      if (search) {
        query += ` AND (iccid LIKE ? OR phone_number LIKE ? OR user_phone_number LIKE ? OR carrier LIKE ? OR user_carrier LIKE ? OR user_notes LIKE ?)`;
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
      }
      
      query += ` ORDER BY COALESCE(user_updated_at, created_at) DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      
      const result = await env.DB.prepare(query).bind(...params).all();
      const mappings = result.results || result;
      
      // Get total count
      let countQuery = `SELECT COUNT(*) as total FROM sims WHERE 1=1`;
      const countParams = [];
      
      if (isActive === 'true') {
        countQuery += ` AND user_override_enabled = TRUE`;
      } else if (isActive === 'false') {
        countQuery += ` AND (user_override_enabled = FALSE OR user_override_enabled IS NULL)`;
      }
      
      if (search) {
        countQuery += ` AND (iccid LIKE ? OR phone_number LIKE ? OR user_phone_number LIKE ? OR carrier LIKE ? OR user_carrier LIKE ? OR user_notes LIKE ?)`;
        const searchPattern = `%${search}%`;
        countParams.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
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
          iccid as id,
          iccid,
          COALESCE(user_phone_number, phone_number) as phone_number,
          COALESCE(user_carrier, carrier) as carrier,
          COALESCE(user_country_code, country_code) as country,
          user_notes as notes,
          user_override_enabled as is_active,
          current_modem_id as equipment_id,
          created_at,
          COALESCE(user_updated_at, updated_at) as updated_at,
          user_updated_by as updated_by
        FROM sims
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
          iccid as id,
          iccid,
          COALESCE(user_phone_number, phone_number) as phone_number,
          COALESCE(user_carrier, carrier) as carrier,
          COALESCE(user_country_code, country_code) as country,
          user_notes as notes,
          user_override_enabled as is_active,
          current_modem_id as equipment_id,
          created_at,
          COALESCE(user_updated_at, updated_at) as updated_at,
          user_updated_by as updated_by
        FROM sims
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
  
  // Create a new ICCID mapping (user override)
  async create(request) {
    const { env, user } = request;
    const data = await request.json();
    
    try {
      const { iccid, phone_number, carrier, country, notes } = data;
      
      if (!iccid || !phone_number) {
        return new Response(JSON.stringify({ 
          success: false,
          error: 'ICCID and phone number are required' 
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
        // Create new SIM entry if it doesn't exist
        await env.DB.prepare(`
          INSERT INTO sims (iccid, phone_number, carrier, country_code, user_phone_number, user_carrier, user_country_code, user_notes, user_override_enabled, user_updated_at, user_updated_by, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP, ?, 'active')
        `).bind(
          iccid,
          phone_number, // system phone number
          carrier || null,
          country || null,
          phone_number, // user override phone number
          carrier || null,
          country || null,
          notes || null,
          user?.email || 'system'
        ).run();
      } else {
        // Update existing SIM with user override
        await env.DB.prepare(`
          UPDATE sims 
          SET 
            user_phone_number = ?,
            user_carrier = ?,
            user_country_code = ?,
            user_notes = ?,
            user_override_enabled = TRUE,
            user_updated_at = CURRENT_TIMESTAMP,
            user_updated_by = ?
          WHERE iccid = ?
        `).bind(
          phone_number,
          carrier || null,
          country || null,
          notes || null,
          user?.email || 'system',
          iccid
        ).run();
      }
      
      // Return the created/updated mapping
      const mapping = await env.DB.prepare(`
        SELECT
          iccid as id,
          iccid,
          COALESCE(user_phone_number, phone_number) as phone_number,
          COALESCE(user_carrier, carrier) as carrier,
          COALESCE(user_country_code, country_code) as country,
          user_notes as notes,
          user_override_enabled as is_active,
          current_modem_id as equipment_id,
          created_at,
          COALESCE(user_updated_at, updated_at) as updated_at
        FROM sims
        WHERE iccid = ?
      `).bind(iccid).first();
      
      return new Response(JSON.stringify({
        success: true,
        data: mapping
      }), {
        status: 201,
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
      const { phone_number, carrier, country, notes, is_active } = data;
      
      // Update the user override fields
      await env.DB.prepare(`
        UPDATE sims 
        SET 
          user_phone_number = ?,
          user_carrier = ?,
          user_country_code = ?,
          user_notes = ?,
          user_override_enabled = ?,
          user_updated_at = CURRENT_TIMESTAMP,
          user_updated_by = ?
        WHERE iccid = ?
      `).bind(
        phone_number || null,
        carrier || null,
        country || null,
        notes || null,
        is_active !== false, // convert to boolean
        user?.email || 'system',
        id
      ).run();
      
      // Return updated mapping
      const mapping = await env.DB.prepare(`
        SELECT
          iccid as id,
          iccid,
          COALESCE(user_phone_number, phone_number) as phone_number,
          COALESCE(user_carrier, carrier) as carrier,
          COALESCE(user_country_code, country_code) as country,
          user_notes as notes,
          user_override_enabled as is_active,
          current_modem_id as equipment_id,
          created_at,
          COALESCE(user_updated_at, updated_at) as updated_at
        FROM sims
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
  
  // Delete an ICCID mapping (disable override)
  async delete(request) {
    const { env, params, user } = request;
    const { id } = params;
    
    try {
      // Just disable the user override, don't delete the SIM
      await env.DB.prepare(`
        UPDATE sims 
        SET 
          user_phone_number = NULL,
          user_carrier = NULL,
          user_country_code = NULL,
          user_notes = NULL,
          user_override_enabled = FALSE,
          user_updated_at = CURRENT_TIMESTAMP,
          user_updated_by = ?
        WHERE iccid = ?
      `).bind(user?.email || 'system', id).run();
      
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
          const { iccid, phone_number, carrier, country, notes } = mapping;
          
          if (!iccid || !phone_number) {
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
                user_phone_number = ?,
                user_carrier = ?,
                user_country_code = ?,
                user_notes = ?,
                user_override_enabled = TRUE,
                user_updated_at = CURRENT_TIMESTAMP,
                user_updated_by = ?
              WHERE iccid = ?
            `).bind(
              phone_number,
              carrier || null,
              country || null,
              notes || null,
              user?.email || 'system',
              iccid
            ).run();
            updated++;
          } else {
            // Create new
            await env.DB.prepare(`
              INSERT INTO sims (
                iccid, phone_number, carrier, country_code,
                user_phone_number, user_carrier, user_country_code, user_notes, 
                user_override_enabled, user_updated_at, user_updated_by, status
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP, ?, 'active')
            `).bind(
              iccid,
              phone_number,
              carrier || null,
              country || null,
              phone_number,
              carrier || null,
              country || null,
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