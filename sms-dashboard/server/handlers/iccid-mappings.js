export const iccidMappingsHandler = {
  // List all ICCID mappings with pagination
  async list(request) {
    const { env } = request;
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const search = url.searchParams.get('search') || '';
    const isActive = url.searchParams.get('active');
    const offset = (page - 1) * limit;
    
    try {
      let query = `
        SELECT 
          id,
          iccid,
          phone_number,
          carrier,
          description,
          is_active,
          created_at,
          updated_at,
          created_by,
          updated_by
        FROM iccid_mappings
        WHERE 1=1
      `;
      const params = [];
      
      if (search) {
        query += ` AND (iccid LIKE ? OR phone_number LIKE ? OR carrier LIKE ? OR description LIKE ?)`;
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern, searchPattern);
      }
      
      if (isActive !== null && isActive !== undefined) {
        query += ` AND is_active = ?`;
        params.push(isActive === 'true' ? 1 : 0);
      }
      
      query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      
      const mappings = await env.DB.prepare(query).bind(...params).all();
      
      // Get total count
      let countQuery = `SELECT COUNT(*) as total FROM iccid_mappings WHERE 1=1`;
      const countParams = [];
      
      if (search) {
        countQuery += ` AND (iccid LIKE ? OR phone_number LIKE ? OR carrier LIKE ? OR description LIKE ?)`;
        const searchPattern = `%${search}%`;
        countParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
      }
      
      if (isActive !== null && isActive !== undefined) {
        countQuery += ` AND is_active = ?`;
        countParams.push(isActive === 'true' ? 1 : 0);
      }
      
      const totalResult = await env.DB.prepare(countQuery).bind(...countParams).first();
      const total = totalResult?.total || 0;
      
      return new Response(JSON.stringify({
        success: true,
        data: mappings.results,
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
      console.error('Error listing ICCID mappings:', error);
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Failed to list ICCID mappings' 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Get a single ICCID mapping
  async get(request) {
    const { env } = request;
    const url = new URL(request.url);
    const id = url.pathname.split('/').pop();
    
    try {
      const mapping = await env.DB.prepare(`
        SELECT * FROM iccid_mappings WHERE id = ?
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
      console.error('Error getting ICCID mapping:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to get ICCID mapping'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Get mapping by ICCID
  async getByIccid(request) {
    const { env } = request;
    const url = new URL(request.url);
    const iccid = url.pathname.split('/').slice(-2)[0];
    
    try {
      const mapping = await env.DB.prepare(`
        SELECT * FROM iccid_mappings WHERE iccid = ? AND is_active = true
      `).bind(iccid).first();
      
      if (!mapping) {
        return new Response(JSON.stringify({
          success: false,
          error: 'No active mapping found for this ICCID'
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
      console.error('Error getting ICCID mapping by ICCID:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to get ICCID mapping'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Create a new ICCID mapping
  async create(request) {
    const { env, user } = request;
    
    try {
      const body = await request.json();
      const { iccid, phone_number, carrier, description } = body;
      
      if (!iccid || !phone_number) {
        return new Response(JSON.stringify({
          success: false,
          error: 'ICCID and phone number are required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Check if ICCID already exists
      const existing = await env.DB.prepare(`
        SELECT id FROM iccid_mappings WHERE iccid = ?
      `).bind(iccid).first();
      
      if (existing) {
        return new Response(JSON.stringify({
          success: false,
          error: 'ICCID already exists in mappings'
        }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Create new mapping
      const result = await env.DB.prepare(`
        INSERT INTO iccid_mappings (iccid, phone_number, carrier, description, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        iccid,
        phone_number,
        carrier || null,
        description || null,
        user.id,
        user.id
      ).run();
      
      const newMapping = await env.DB.prepare(`
        SELECT * FROM iccid_mappings WHERE id = ?
      `).bind(result.meta.last_row_id).first();
      
      return new Response(JSON.stringify({
        success: true,
        data: newMapping
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Error creating ICCID mapping:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to create ICCID mapping'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Update an ICCID mapping
  async update(request) {
    const { env, user } = request;
    const url = new URL(request.url);
    const id = url.pathname.split('/').pop();
    
    try {
      const body = await request.json();
      const { phone_number, carrier, description, is_active } = body;
      
      // Check if mapping exists
      const existing = await env.DB.prepare(`
        SELECT id FROM iccid_mappings WHERE id = ?
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
      
      // Update mapping
      await env.DB.prepare(`
        UPDATE iccid_mappings 
        SET phone_number = ?,
            carrier = ?,
            description = ?,
            is_active = ?,
            updated_at = datetime('now'),
            updated_by = ?
        WHERE id = ?
      `).bind(
        phone_number,
        carrier || null,
        description || null,
        is_active !== undefined ? (is_active ? 1 : 0) : 1,
        user.id,
        id
      ).run();
      
      const updated = await env.DB.prepare(`
        SELECT * FROM iccid_mappings WHERE id = ?
      `).bind(id).first();
      
      return new Response(JSON.stringify({
        success: true,
        data: updated
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Error updating ICCID mapping:', error);
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
    const { env } = request;
    const url = new URL(request.url);
    const id = url.pathname.split('/').pop();
    
    try {
      // Check if mapping exists
      const existing = await env.DB.prepare(`
        SELECT id FROM iccid_mappings WHERE id = ?
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
      
      // Delete mapping
      await env.DB.prepare(`
        DELETE FROM iccid_mappings WHERE id = ?
      `).bind(id).run();
      
      return new Response(JSON.stringify({
        success: true,
        message: 'ICCID mapping deleted successfully'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Error deleting ICCID mapping:', error);
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
    
    try {
      const body = await request.json();
      const { mappings } = body;
      
      if (!Array.isArray(mappings) || mappings.length === 0) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid mappings data'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const results = {
        success: 0,
        failed: 0,
        errors: []
      };
      
      for (const mapping of mappings) {
        try {
          if (!mapping.iccid || !mapping.phone_number) {
            results.failed++;
            results.errors.push({
              iccid: mapping.iccid,
              error: 'ICCID and phone number are required'
            });
            continue;
          }
          
          // Check if ICCID already exists
          const existing = await env.DB.prepare(`
            SELECT id FROM iccid_mappings WHERE iccid = ?
          `).bind(mapping.iccid).first();
          
          if (existing) {
            // Update existing mapping
            await env.DB.prepare(`
              UPDATE iccid_mappings 
              SET phone_number = ?,
                  carrier = ?,
                  description = ?,
                  updated_at = datetime('now'),
                  updated_by = ?
              WHERE iccid = ?
            `).bind(
              mapping.phone_number,
              mapping.carrier || null,
              mapping.description || null,
              user.id,
              mapping.iccid
            ).run();
          } else {
            // Create new mapping
            await env.DB.prepare(`
              INSERT INTO iccid_mappings (iccid, phone_number, carrier, description, created_by, updated_by)
              VALUES (?, ?, ?, ?, ?, ?)
            `).bind(
              mapping.iccid,
              mapping.phone_number,
              mapping.carrier || null,
              mapping.description || null,
              user.id,
              user.id
            ).run();
          }
          
          results.success++;
        } catch (error) {
          results.failed++;
          results.errors.push({
            iccid: mapping.iccid,
            error: error.message
          });
        }
      }
      
      return new Response(JSON.stringify({
        success: true,
        results
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Error bulk importing ICCID mappings:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to bulk import ICCID mappings'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};