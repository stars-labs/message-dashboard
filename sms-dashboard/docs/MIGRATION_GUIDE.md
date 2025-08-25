# Handler Migration Guide

This guide explains how to migrate remaining JavaScript handlers to the new TypeScript/Hono/Drizzle stack.

## Migration Checklist

### ✅ Completed Migrations
- [x] `phones.js` → `src/handlers/phones.ts`
- [x] `messages.js` → `src/handlers/messages.ts` 
- [x] `health.js` → `src/handlers/health.ts`
- [x] Authentication middleware → `src/middleware/auth.ts`

### 🚧 Pending Migrations
- [ ] `control.js` - Daemon control endpoints
- [ ] `ai.js` - AI/ML endpoints
- [ ] `chatbot.js` - Chat functionality
- [ ] `chatbot-stream.js` - Streaming chat
- [ ] `stats.js` - Statistics endpoints
- [ ] `iccid-mappings.js` - ICCID management
- [ ] `updates.js` - Polling updates
- [ ] `auth0.js` - Auth0 handlers
- [ ] `keywords.js` - Keyword management

## Step-by-Step Migration Process

### 1. Create TypeScript Handler File

Create a new file in `src/handlers/[name].ts`:

```typescript
import { Context } from 'hono';
import { eq, sql, and, or, desc } from 'drizzle-orm';
import { createDb } from '../db/client';
import { /* import relevant tables */ } from '../db/schema';

// Define context type
type AppContext = Context<{
  Bindings: {
    DB: D1Database;
    // Add other bindings as needed
  };
  Variables: {
    db: ReturnType<typeof createDb>;
    user?: any;
    userPermissions?: string[];
  };
}>;

export const handlerName = {
  // Handler methods here
};
```

### 2. Convert SQL Queries to Drizzle

#### Before (Raw SQL):
```javascript
const result = await env.DB.prepare(`
  SELECT * FROM users 
  WHERE status = ? 
  ORDER BY created_at DESC
`).bind('active').all();
```

#### After (Drizzle ORM):
```typescript
const result = await db
  .select()
  .from(users)
  .where(eq(users.status, 'active'))
  .orderBy(desc(users.created_at));
```

### 3. Update Method Signatures

#### Before (Request object):
```javascript
async list(request) {
  const { env } = request;
  const url = new URL(request.url);
  // ...
}
```

#### After (Hono context):
```typescript
async list(c: AppContext) {
  const db = c.get('db');
  const url = new URL(c.req.url);
  // ...
}
```

### 4. Handle Request/Response

#### Before:
```javascript
// Get JSON body
const body = await request.json();

// Return response
return new Response(JSON.stringify(data), {
  headers: { 'Content-Type': 'application/json' }
});
```

#### After:
```typescript
// Get JSON body
const body = await c.req.json();

// Return response
return c.json(data);
```

### 5. Update Route Registration

#### Before (in server/index.js):
```javascript
router.get('/api/endpoint', authMiddleware, handler);
```

#### After (in src/index.ts):
```typescript
app.get('/api/endpoint',
  authMiddleware,
  enrichUserPermissions,
  requirePermission('resource.read'),
  (c) => handler.method(c)
);
```

## Common Patterns

### Database Queries

#### Simple Select
```typescript
// Get all records
const records = await db.select().from(table);

// With conditions
const filtered = await db
  .select()
  .from(table)
  .where(eq(table.column, value));
```

#### Joins
```typescript
const joined = await db
  .select({
    id: table1.id,
    name: table1.name,
    related: table2.field
  })
  .from(table1)
  .leftJoin(table2, eq(table1.foreign_id, table2.id));
```

#### Insert
```typescript
await db.insert(table).values({
  id: nanoid(),
  field1: value1,
  field2: value2
});
```

#### Update
```typescript
await db
  .update(table)
  .set({ 
    field: newValue,
    updated_at: sql`CURRENT_TIMESTAMP`
  })
  .where(eq(table.id, id));
```

#### Delete
```typescript
await db
  .delete(table)
  .where(eq(table.id, id));
```

### Error Handling

```typescript
try {
  // Database operations
  const result = await db.select().from(table);
  return c.json({ success: true, data: result });
} catch (error: any) {
  console.error('[Handler] Error:', error);
  return c.json({ 
    success: false, 
    error: 'Operation failed' 
  }, 500);
}
```

### Authentication Check

```typescript
// Get authenticated user
const user = c.get('user');
if (!user) {
  return c.json({ error: 'Unauthorized' }, 401);
}

// Check permissions
const permissions = c.get('userPermissions');
if (!permissions?.includes('required.permission')) {
  return c.json({ error: 'Forbidden' }, 403);
}
```

### Query Parameters

```typescript
// Get query parameters
const url = new URL(c.req.url);
const page = parseInt(url.searchParams.get('page') || '1');
const limit = parseInt(url.searchParams.get('limit') || '10');
const search = url.searchParams.get('search');
```

### Path Parameters

```typescript
// Route: /api/items/:id
const id = c.req.param('id');
```

## Migration Example: Control Handler

### Original (server/handlers/control.js):
```javascript
export const controlHandler = {
  async updatePhones(request) {
    const { env } = request;
    const body = await request.json();
    
    // Validate API key
    const apiKey = request.headers.get('X-API-Key');
    if (apiKey !== env.API_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Update phones
    const stmt = env.DB.prepare(`
      INSERT OR REPLACE INTO phones (id, number, status)
      VALUES (?, ?, ?)
    `);
    
    for (const phone of body.phones) {
      await stmt.bind(phone.id, phone.number, phone.status).run();
    }
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
```

### Migrated (src/handlers/control.ts):
```typescript
import { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client';
import { sims } from '../db/schema';

type AppContext = Context<{
  Bindings: {
    DB: D1Database;
    API_KEY: string;
  };
  Variables: {
    db: ReturnType<typeof createDb>;
  };
}>;

export const controlHandler = {
  async updatePhones(c: AppContext) {
    const db = c.get('db');
    const body = await c.req.json();
    
    // API key validation handled by middleware
    
    // Update phones using Drizzle
    for (const phone of body.phones) {
      await db
        .insert(sims)
        .values({
          iccid: phone.id,
          phone_number: phone.number,
          status: phone.status
        })
        .onConflictDoUpdate({
          target: sims.iccid,
          set: {
            phone_number: phone.number,
            status: phone.status
          }
        });
    }
    
    return c.json({ success: true });
  }
};
```

## Testing Migrated Handlers

### 1. Type Checking
```bash
bun run typecheck
```

### 2. Local Testing
```bash
# Start local dev server
bun run dev:api

# Test endpoint
curl http://localhost:8787/api/endpoint
```

### 3. Integration Testing
```typescript
import { describe, it, expect } from 'bun:test';
import app from '../src/index';

describe('Handler Tests', () => {
  it('should return data', async () => {
    const res = await app.request('/api/endpoint');
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});
```

## Benefits After Migration

### Type Safety
- Auto-completion in IDEs
- Compile-time error catching
- Inferred types from database schema
- Better refactoring support

### Performance
- Optimized query generation
- Reduced bundle size
- Faster routing with Hono
- Better tree shaking

### Maintainability
- Cleaner code structure
- Consistent patterns
- Better error handling
- Easier testing

## Common Issues & Solutions

### Issue: TypeScript Errors
**Solution**: Check type definitions and ensure all imports are correct.

### Issue: Query Not Working
**Solution**: Use `db.$logs()` to debug generated SQL.

### Issue: Missing Bindings
**Solution**: Add required bindings to the context type definition.

### Issue: Authentication Failing
**Solution**: Ensure middleware is applied in correct order.

## Resources

- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [Hono.js Documentation](https://hono.dev/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Cloudflare Workers Types](https://developers.cloudflare.com/workers/languages/typescript/)

## Support

For questions or issues during migration:
1. Check existing migrated handlers for examples
2. Review the architecture documentation
3. Test thoroughly in local development
4. Use TypeScript's type checking to catch issues early