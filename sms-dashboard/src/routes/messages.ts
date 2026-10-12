import { Elysia, t } from 'elysia';
import { eq, sql, desc, like, and, or } from 'drizzle-orm';
import { messages, phones, iccid_mappings } from '../db/schema';
import { nanoid } from 'nanoid';
import { requirePermission } from '../middleware/auth';

export const messagesRoutes = new Elysia({ prefix: '/messages' })
  // Get messages with filters
  .get('/', async ({ db, query }) => {
    const { phone_iccid, search, type, limit = '100', offset = '0' } = query;
    
    // Build base query
    let baseQuery = db
      .select({
        id: messages.id,
        phone_iccid: messages.phone_iccid,
        phone_number: sql<string>`COALESCE(${iccid_mappings.phone_number}, ${phones.number}, ${messages.phone_number})`,
        content: messages.content,
        timestamp: messages.timestamp,
        type: messages.type,
        status: messages.status,
        recipient: messages.recipient,
        verification_code: messages.verification_code,
        error_message: messages.error_message,
        phone_carrier: phones.carrier,
        phone_status: phones.status,
        mapped_number: iccid_mappings.phone_number
      })
      .from(messages)
      .leftJoin(phones, eq(messages.phone_iccid, phones.iccid))
      .leftJoin(iccid_mappings, and(
        eq(messages.phone_iccid, iccid_mappings.iccid),
        eq(iccid_mappings.is_active, true)
      ));
    
    // Apply filters
    const conditions = [];
    
    if (phone_iccid) {
      conditions.push(eq(messages.phone_iccid, phone_iccid));
    }
    
    if (type) {
      conditions.push(eq(messages.type, type as 'received' | 'sent'));
    }
    
    if (search) {
      conditions.push(or(
        like(messages.content, `%${search}%`),
        like(messages.phone_number, `%${search}%`),
        like(messages.recipient, `%${search}%`)
      ));
    }
    
    if (conditions.length > 0) {
      baseQuery = baseQuery.where(and(...conditions));
    }
    
    // Execute query with ordering and pagination
    const results = await baseQuery
      .orderBy(desc(messages.timestamp))
      .limit(parseInt(limit))
      .offset(parseInt(offset));
    
    return results;
  }, {
    query: t.Object({
      phone_iccid: t.Optional(t.String()),
      search: t.Optional(t.String()),
      type: t.Optional(t.Union([t.Literal('received'), t.Literal('sent')])),
      limit: t.Optional(t.String()),
      offset: t.Optional(t.String())
    })
  })
  
  // Get single message
  .get('/:id', async ({ db, params }) => {
    const { id } = params;
    
    const result = await db
      .select({
        id: messages.id,
        phone_iccid: messages.phone_iccid,
        phone_number: sql<string>`COALESCE(${iccid_mappings.phone_number}, ${phones.number}, ${messages.phone_number})`,
        content: messages.content,
        timestamp: messages.timestamp,
        type: messages.type,
        status: messages.status,
        recipient: messages.recipient,
        verification_code: messages.verification_code,
        error_message: messages.error_message,
        phone_carrier: phones.carrier,
        phone_status: phones.status,
        mapped_number: iccid_mappings.phone_number
      })
      .from(messages)
      .leftJoin(phones, eq(messages.phone_iccid, phones.iccid))
      .leftJoin(iccid_mappings, and(
        eq(messages.phone_iccid, iccid_mappings.iccid),
        eq(iccid_mappings.is_active, true)
      ))
      .where(eq(messages.id, id))
      .limit(1);
    
    if (result.length === 0) {
      throw new Error('Message not found');
    }
    
    return result[0];
  }, {
    params: t.Object({
      id: t.String()
    })
  })
  
  // Send message (requires permission)
  .use(requirePermission('messages.send'))
  .post('/', async ({ db, body }) => {
    const { phone_iccid, recipient, content } = body;
    
    const id = nanoid();
    
    // Insert message with pending status
    await db.insert(messages).values({
      id,
      phone_iccid,
      content,
      recipient,
      type: 'sent',
      status: 'pending',
      timestamp: sql`CURRENT_TIMESTAMP`
    });
    
    return {
      id,
      status: 'pending',
      message: 'Message queued for sending'
    };
  }, {
    body: t.Object({
      phone_iccid: t.String(),
      recipient: t.String(),
      content: t.String()
    })
  })
  
  // Delete message (requires permission)
  .use(requirePermission('messages.write'))
  .delete('/:id', async ({ db, params }) => {
    const { id } = params;
    
    await db.delete(messages)
      .where(eq(messages.id, id));
    
    return { success: true };
  }, {
    params: t.Object({
      id: t.String()
    })
  })
  
  // Get verification codes
  .get('/verification-codes', async ({ db, query }) => {
    const { limit = '50' } = query;
    
    const results = await db
      .select({
        id: messages.id,
        phone_iccid: messages.phone_iccid,
        phone_number: messages.phone_number,
        content: messages.content,
        verification_code: messages.verification_code,
        timestamp: messages.timestamp
      })
      .from(messages)
      .where(sql`${messages.verification_code} IS NOT NULL`)
      .orderBy(desc(messages.timestamp))
      .limit(parseInt(limit));
    
    return results;
  }, {
    query: t.Object({
      limit: t.Optional(t.String())
    })
  });