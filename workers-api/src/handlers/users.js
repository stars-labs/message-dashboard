import { requirePermission, logAuditEvent } from '../middleware/rbac';

export const usersHandler = {
  // List users with pagination
  async list(request) {
    const { env, user } = request;
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const search = url.searchParams.get('search') || '';
    const group = url.searchParams.get('group') || '';
    
    try {
      let query = `
        SELECT 
          u.id, u.email, u.name, u.nickname, u.picture,
          u.provider, u.email_verified, u.is_active, u.is_admin,
          u.last_login, u.login_count, u.created_at,
          GROUP_CONCAT(g.name) as groups
        FROM users u
        LEFT JOIN user_groups ug ON u.id = ug.user_id
        LEFT JOIN groups g ON ug.group_id = g.id
      `;
      
      const conditions = [];
      const params = [];
      
      if (search) {
        conditions.push(`(u.email LIKE ? OR u.name LIKE ?)`);
        params.push(`%${search}%`, `%${search}%`);
      }
      
      if (group) {
        conditions.push(`g.id = ?`);
        params.push(group);
      }
      
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }
      
      query += ` GROUP BY u.id ORDER BY u.created_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      
      // Get total count
      let countQuery = `SELECT COUNT(DISTINCT u.id) as total FROM users u`;
      if (group) {
        countQuery += ` LEFT JOIN user_groups ug ON u.id = ug.user_id WHERE ug.group_id = ?`;
      }
      
      const [users, count] = await Promise.all([
        env.DB.prepare(query).bind(...params).all(),
        env.DB.prepare(countQuery).bind(...(group ? [group] : [])).first()
      ]);
      
      return new Response(JSON.stringify({
        success: true,
        data: users.results.map(u => ({
          ...u,
          groups: u.groups ? u.groups.split(',') : []
        })),
        pagination: {
          total: count.total,
          limit,
          offset
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('List users error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch users'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Get specific user with permissions
  async get(request) {
    const { env } = request;
    const userId = request.params.id;
    
    try {
      const user = await env.DB.prepare(`
        SELECT 
          u.*,
          us.language, us.timezone, us.notifications_enabled, us.theme
        FROM users u
        LEFT JOIN user_settings us ON u.id = us.user_id
        WHERE u.id = ?
      `).bind(userId).first();
      
      if (!user) {
        return new Response(JSON.stringify({
          success: false,
          error: 'User not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Get user's groups
      const groups = await env.DB.prepare(`
        SELECT g.* FROM groups g
        JOIN user_groups ug ON g.id = ug.group_id
        WHERE ug.user_id = ?
      `).bind(userId).all();
      
      // Get user's effective permissions
      const permissions = await env.DB.prepare(`
        SELECT DISTINCT permission_id, resource, action
        FROM user_effective_permissions
        WHERE user_id = ? AND granted = 1
      `).bind(userId).all();
      
      return new Response(JSON.stringify({
        success: true,
        data: {
          ...user,
          groups: groups.results,
          permissions: permissions.results
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Get user error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch user'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Update user
  async update(request) {
    const { env, user: currentUser } = request;
    const userId = request.params.id;
    const body = await request.json();
    
    try {
      // Update user fields
      const allowedFields = ['name', 'is_active', 'is_admin'];
      const updates = [];
      const params = [];
      
      for (const field of allowedFields) {
        if (body.hasOwnProperty(field)) {
          updates.push(`${field} = ?`);
          params.push(body[field]);
        }
      }
      
      if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(userId);
        
        await env.DB.prepare(`
          UPDATE users SET ${updates.join(', ')} WHERE id = ?
        `).bind(...params).run();
      }
      
      // Update user groups if provided
      if (body.groups && Array.isArray(body.groups)) {
        // Remove existing groups
        await env.DB.prepare(`
          DELETE FROM user_groups WHERE user_id = ?
        `).bind(userId).run();
        
        // Add new groups
        for (const groupId of body.groups) {
          await env.DB.prepare(`
            INSERT INTO user_groups (user_id, group_id, assigned_by)
            VALUES (?, ?, ?)
          `).bind(userId, groupId, currentUser.id).run();
        }
      }
      
      // Log the update
      await logAuditEvent(env.DB, {
        user_id: currentUser.id,
        action: 'user.update',
        resource_type: 'user',
        resource_id: userId,
        details: body,
        ip_address: request.headers.get('CF-Connecting-IP'),
        user_agent: request.headers.get('User-Agent')
      });
      
      return new Response(JSON.stringify({
        success: true,
        message: 'User updated successfully'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Update user error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to update user'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Delete user
  async delete(request) {
    const { env, user: currentUser } = request;
    const userId = request.params.id;
    
    try {
      // Don't allow deleting yourself
      if (userId === currentUser.id) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Cannot delete your own account'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Delete user (cascades to related tables)
      await env.DB.prepare(`
        DELETE FROM users WHERE id = ?
      `).bind(userId).run();
      
      // Log the deletion
      await logAuditEvent(env.DB, {
        user_id: currentUser.id,
        action: 'user.delete',
        resource_type: 'user',
        resource_id: userId,
        ip_address: request.headers.get('CF-Connecting-IP'),
        user_agent: request.headers.get('User-Agent')
      });
      
      return new Response(JSON.stringify({
        success: true,
        message: 'User deleted successfully'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Delete user error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to delete user'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Update user settings
  async updateSettings(request) {
    const { env, user } = request;
    const body = await request.json();
    
    try {
      const allowedSettings = ['language', 'timezone', 'notifications_enabled', 'theme', 'dashboard_layout', 'phone_filters', 'message_filters'];
      const updates = [];
      const params = [];
      
      for (const field of allowedSettings) {
        if (body.hasOwnProperty(field)) {
          updates.push(`${field} = ?`);
          params.push(typeof body[field] === 'object' ? JSON.stringify(body[field]) : body[field]);
        }
      }
      
      if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(user.id);
        
        await env.DB.prepare(`
          INSERT INTO user_settings (user_id, ${updates.map(() => '?').join(', ')})
          VALUES (?, ${params.map(() => '?').join(', ')})
          ON CONFLICT(user_id) DO UPDATE SET ${updates.join(', ')}
        `).bind(user.id, ...params, ...params).run();
      }
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Settings updated successfully'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Update settings error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to update settings'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};