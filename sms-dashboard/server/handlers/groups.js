import { nanoid } from 'nanoid';
import { logAuditEvent } from '../middleware/rbac';

export const groupsHandler = {
  // List all groups
  async list(request) {
    const { env } = request;
    
    try {
      const groups = await env.DB.prepare(`
        SELECT 
          g.*,
          COUNT(DISTINCT ug.user_id) as member_count,
          COUNT(DISTINCT gp.permission_id) as permission_count
        FROM groups g
        LEFT JOIN user_groups ug ON g.id = ug.group_id
        LEFT JOIN group_permissions gp ON g.id = gp.group_id
        GROUP BY g.id
        ORDER BY g.is_system DESC, g.name ASC
      `).all();
      
      return new Response(JSON.stringify({
        success: true,
        data: groups.results
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('List groups error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch groups'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Get specific group with members and permissions
  async get(request) {
    const { env } = request;
    const groupId = request.params.id;
    
    try {
      const group = await env.DB.prepare(`
        SELECT * FROM groups WHERE id = ?
      `).bind(groupId).first();
      
      if (!group) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Group not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Get members
      const members = await env.DB.prepare(`
        SELECT u.id, u.email, u.name, u.picture, ug.assigned_at
        FROM users u
        JOIN user_groups ug ON u.id = ug.user_id
        WHERE ug.group_id = ?
        ORDER BY u.name ASC
      `).bind(groupId).all();
      
      // Get permissions
      const permissions = await env.DB.prepare(`
        SELECT p.*, gp.granted_at
        FROM permissions p
        JOIN group_permissions gp ON p.id = gp.permission_id
        WHERE gp.group_id = ?
        ORDER BY p.resource, p.action
      `).bind(groupId).all();
      
      return new Response(JSON.stringify({
        success: true,
        data: {
          ...group,
          members: members.results,
          permissions: permissions.results
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Get group error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to fetch group'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Create new group
  async create(request) {
    const { env, user } = request;
    const body = await request.json();
    
    if (!body.name) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Group name is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      const groupId = `group_${nanoid()}`;
      
      await env.DB.prepare(`
        INSERT INTO groups (id, name, description, is_system)
        VALUES (?, ?, ?, FALSE)
      `).bind(
        groupId,
        body.name,
        body.description || null
      ).run();
      
      // Add initial permissions if provided
      if (body.permissions && Array.isArray(body.permissions)) {
        for (const permissionId of body.permissions) {
          await env.DB.prepare(`
            INSERT INTO group_permissions (group_id, permission_id, granted_by)
            VALUES (?, ?, ?)
          `).bind(groupId, permissionId, user.id).run();
        }
      }
      
      // Log the creation
      await logAuditEvent(env.DB, {
        user_id: user.id,
        action: 'group.create',
        resource_type: 'group',
        resource_id: groupId,
        details: body,
        ip_address: request.headers.get('CF-Connecting-IP'),
        user_agent: request.headers.get('User-Agent')
      });
      
      return new Response(JSON.stringify({
        success: true,
        data: { id: groupId }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Create group error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to create group'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Update group
  async update(request) {
    const { env, user } = request;
    const groupId = request.params.id;
    const body = await request.json();
    
    try {
      // Check if group is system group
      const group = await env.DB.prepare(`
        SELECT is_system FROM groups WHERE id = ?
      `).bind(groupId).first();
      
      if (!group) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Group not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (group.is_system && body.name) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Cannot rename system groups'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Update group details
      if (body.name || body.description !== undefined) {
        const updates = [];
        const params = [];
        
        if (body.name) {
          updates.push('name = ?');
          params.push(body.name);
        }
        if (body.description !== undefined) {
          updates.push('description = ?');
          params.push(body.description);
        }
        
        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(groupId);
        
        await env.DB.prepare(`
          UPDATE groups SET ${updates.join(', ')} WHERE id = ?
        `).bind(...params).run();
      }
      
      // Update permissions if provided
      if (body.permissions && Array.isArray(body.permissions)) {
        // Remove existing permissions
        await env.DB.prepare(`
          DELETE FROM group_permissions WHERE group_id = ?
        `).bind(groupId).run();
        
        // Add new permissions
        for (const permissionId of body.permissions) {
          await env.DB.prepare(`
            INSERT INTO group_permissions (group_id, permission_id, granted_by)
            VALUES (?, ?, ?)
          `).bind(groupId, permissionId, user.id).run();
        }
      }
      
      // Log the update
      await logAuditEvent(env.DB, {
        user_id: user.id,
        action: 'group.update',
        resource_type: 'group',
        resource_id: groupId,
        details: body,
        ip_address: request.headers.get('CF-Connecting-IP'),
        user_agent: request.headers.get('User-Agent')
      });
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Group updated successfully'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Update group error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to update group'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Delete group
  async delete(request) {
    const { env, user } = request;
    const groupId = request.params.id;
    
    try {
      // Check if group is system group
      const group = await env.DB.prepare(`
        SELECT is_system FROM groups WHERE id = ?
      `).bind(groupId).first();
      
      if (!group) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Group not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      if (group.is_system) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Cannot delete system groups'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Delete group (cascades to user_groups and group_permissions)
      await env.DB.prepare(`
        DELETE FROM groups WHERE id = ?
      `).bind(groupId).run();
      
      // Log the deletion
      await logAuditEvent(env.DB, {
        user_id: user.id,
        action: 'group.delete',
        resource_type: 'group',
        resource_id: groupId,
        ip_address: request.headers.get('CF-Connecting-IP'),
        user_agent: request.headers.get('User-Agent')
      });
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Group deleted successfully'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Delete group error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to delete group'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Add members to group
  async addMembers(request) {
    const { env, user } = request;
    const groupId = request.params.id;
    const { userIds } = await request.json();
    
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User IDs are required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      for (const userId of userIds) {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO user_groups (user_id, group_id, assigned_by)
          VALUES (?, ?, ?)
        `).bind(userId, groupId, user.id).run();
      }
      
      // Log the action
      await logAuditEvent(env.DB, {
        user_id: user.id,
        action: 'group.add_members',
        resource_type: 'group',
        resource_id: groupId,
        details: { userIds },
        ip_address: request.headers.get('CF-Connecting-IP'),
        user_agent: request.headers.get('User-Agent')
      });
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Members added successfully'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Add members error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to add members'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  // Remove members from group
  async removeMembers(request) {
    const { env, user } = request;
    const groupId = request.params.id;
    const { userIds } = await request.json();
    
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'User IDs are required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      for (const userId of userIds) {
        await env.DB.prepare(`
          DELETE FROM user_groups 
          WHERE user_id = ? AND group_id = ?
        `).bind(userId, groupId).run();
      }
      
      // Log the action
      await logAuditEvent(env.DB, {
        user_id: user.id,
        action: 'group.remove_members',
        resource_type: 'group',
        resource_id: groupId,
        details: { userIds },
        ip_address: request.headers.get('CF-Connecting-IP'),
        user_agent: request.headers.get('User-Agent')
      });
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Members removed successfully'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Remove members error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Failed to remove members'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};