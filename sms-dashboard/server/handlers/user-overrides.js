// User override management handler
export const userOverridesHandler = {
  
  // Get user overrides for a specific SIM
  async get(request) {
    const { env, user } = request;
    const url = new URL(request.url);
    const iccid = url.searchParams.get('iccid');
    
    if (!iccid) {
      return new Response(JSON.stringify({
        success: false,
        error: 'ICCID is required'
      }), { status: 400 });
    }
    
    try {
      const override = await env.DB.prepare(`
        SELECT 
          iccid,
          phone_number as system_phone_number,
          carrier as system_carrier,
          country_code as system_country_code,
          user_phone_number,
          user_carrier,
          user_country_code,
          user_notes,
          user_override_enabled,
          user_updated_at,
          user_updated_by
        FROM sims 
        WHERE iccid = ?
      `).bind(iccid).first();
      
      if (!override) {
        return new Response(JSON.stringify({
          success: false,
          error: 'SIM not found'
        }), { status: 404 });
      }
      
      return new Response(JSON.stringify({
        success: true,
        data: override
      }), { headers: { 'Content-Type': 'application/json' } });
      
    } catch (error) {
      console.error('[User Overrides] Get error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch override'
      }), { status: 500 });
    }
  },
  
  // Set/update user overrides for a SIM
  async update(request) {
    const { env, user } = request;
    
    try {
      const { 
        iccid, 
        user_phone_number, 
        user_carrier, 
        user_country_code, 
        user_notes, 
        user_override_enabled = true 
      } = await request.json();
      
      if (!iccid) {
        return new Response(JSON.stringify({
          success: false,
          error: 'ICCID is required'
        }), { status: 400 });
      }
      
      // Check if SIM exists
      const simExists = await env.DB.prepare(`
        SELECT 1 FROM sims WHERE iccid = ?
      `).bind(iccid).first();
      
      if (!simExists) {
        return new Response(JSON.stringify({
          success: false,
          error: 'SIM not found'
        }), { status: 404 });
      }
      
      // Update user overrides
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
        user_phone_number,
        user_carrier,
        user_country_code,
        user_notes,
        user_override_enabled,
        user?.email || 'system',
        iccid
      ).run();
      
      // Return updated override data
      const updated = await env.DB.prepare(`
        SELECT 
          iccid,
          phone_number as system_phone_number,
          carrier as system_carrier,
          country_code as system_country_code,
          user_phone_number,
          user_carrier,
          user_country_code,
          user_notes,
          user_override_enabled,
          user_updated_at,
          user_updated_by
        FROM sims 
        WHERE iccid = ?
      `).bind(iccid).first();
      
      return new Response(JSON.stringify({
        success: true,
        data: updated
      }), { headers: { 'Content-Type': 'application/json' } });
      
    } catch (error) {
      console.error('[User Overrides] Update error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to update override'
      }), { status: 500 });
    }
  },
  
  // Remove user overrides (revert to system values)
  async remove(request) {
    const { env, user } = request;
    const url = new URL(request.url);
    const iccid = url.searchParams.get('iccid');
    
    if (!iccid) {
      return new Response(JSON.stringify({
        success: false,
        error: 'ICCID is required'
      }), { status: 400 });
    }
    
    try {
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
      `).bind(user?.email || 'system', iccid).run();
      
      return new Response(JSON.stringify({
        success: true,
        message: 'User overrides removed successfully'
      }), { headers: { 'Content-Type': 'application/json' } });
      
    } catch (error) {
      console.error('[User Overrides] Remove error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to remove overrides'
      }), { status: 500 });
    }
  },
  
  // List all SIMs with user overrides
  async list(request) {
    const { env } = request;
    
    try {
      const overrides = await env.DB.prepare(`
        SELECT 
          iccid,
          phone_number as system_phone_number,
          carrier as system_carrier,
          country_code as system_country_code,
          user_phone_number,
          user_carrier,
          user_country_code,
          user_notes,
          user_override_enabled,
          user_updated_at,
          user_updated_by
        FROM sims 
        WHERE user_override_enabled = TRUE
        ORDER BY user_updated_at DESC
      `).all();
      
      return new Response(JSON.stringify({
        success: true,
        data: overrides.results || overrides
      }), { headers: { 'Content-Type': 'application/json' } });
      
    } catch (error) {
      console.error('[User Overrides] List error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch overrides'
      }), { status: 500 });
    }
  }
};