// Role-Based Access Control middleware

export function requirePermission(permission) {
  return async function(request) {
    const { env, user } = request;
    
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Check if user is active
    const userRecord = await env.DB.prepare(`
      SELECT is_active, is_admin FROM users WHERE id = ?
    `).bind(user.id).first();
    
    if (!userRecord || !userRecord.is_active) {
      return new Response(JSON.stringify({ error: 'Account disabled' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Admins have all permissions
    if (userRecord.is_admin) {
      return;
    }
    
    // Check user permissions
    const hasPermission = await checkUserPermission(env.DB, user.id, permission);
    
    if (!hasPermission) {
      // Log unauthorized access attempt
      await logAuditEvent(env.DB, {
        user_id: user.id,
        action: 'permission.denied',
        resource_type: 'permission',
        resource_id: permission,
        details: { requested_permission: permission },
        ip_address: request.headers.get('CF-Connecting-IP'),
        user_agent: request.headers.get('User-Agent')
      });
      
      return new Response(JSON.stringify({ 
        error: 'Forbidden',
        message: `Missing required permission: ${permission}`
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  };
}

export async function checkUserPermission(db, userId, permissionId) {
  // Check using the view that calculates effective permissions
  const result = await db.prepare(`
    SELECT granted 
    FROM user_effective_permissions 
    WHERE user_id = ? AND permission_id = ? AND granted = 1
  `).bind(userId, permissionId).first();
  
  return !!result;
}

export async function getUserPermissions(db, userId) {
  const permissions = await db.prepare(`
    SELECT permission_id, resource, action, granted
    FROM user_effective_permissions
    WHERE user_id = ? AND granted = 1
  `).bind(userId).all();
  
  return permissions.results || [];
}

export async function getUserGroups(db, userId) {
  const groups = await db.prepare(`
    SELECT g.id, g.name, g.description
    FROM user_groups ug
    JOIN groups g ON ug.group_id = g.id
    WHERE ug.user_id = ?
  `).bind(userId).all();
  
  return groups.results || [];
}

export async function checkPhoneAccess(db, userId, phoneId) {
  // Check if user has access to specific phone
  const phone = await db.prepare(`
    SELECT p.*, g.id as owner_group_id
    FROM phones p
    LEFT JOIN groups g ON p.owner_group = g.id
    WHERE p.id = ?
  `).bind(phoneId).first();
  
  if (!phone) {
    return false;
  }
  
  // If phone has no owner group, check general phone read permission
  if (!phone.owner_group_id) {
    return await checkUserPermission(db, userId, 'phones.read');
  }
  
  // Check if user is in the owner group
  const isMember = await db.prepare(`
    SELECT 1 FROM user_groups 
    WHERE user_id = ? AND group_id = ?
  `).bind(userId, phone.owner_group_id).first();
  
  return !!isMember;
}

export async function filterPhonesByAccess(db, userId, phones) {
  // Get user's groups
  const userGroups = await db.prepare(`
    SELECT group_id FROM user_groups WHERE user_id = ?
  `).bind(userId).all();
  
  const groupIds = userGroups.results.map(g => g.group_id);
  
  // Filter phones based on access
  return phones.filter(phone => {
    // No owner group means accessible to all with phones.read permission
    if (!phone.owner_group) return true;
    
    // Check if user's groups include the owner group
    return groupIds.includes(phone.owner_group);
  });
}

export async function logAuditEvent(db, event) {
  const id = `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  await db.prepare(`
    INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, details, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    event.user_id,
    event.action,
    event.resource_type || null,
    event.resource_id || null,
    JSON.stringify(event.details || {}),
    event.ip_address || null,
    event.user_agent || null
  ).run();
}

// Middleware to add user permissions to request
export async function enrichUserPermissions(request) {
  const { env, user } = request;
  
  if (!user) return;
  
  // Get user's permissions and groups
  const [permissions, groups] = await Promise.all([
    getUserPermissions(env.DB, user.id),
    getUserGroups(env.DB, user.id)
  ]);
  
  // Add to request object
  request.userPermissions = permissions.map(p => p.permission_id);
  request.userGroups = groups;
}