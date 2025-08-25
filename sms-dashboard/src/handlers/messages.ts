import { eq, sql, and, or, desc, like, inArray } from 'drizzle-orm';
import { createDb } from '../db/client';
import { messages, sims, iccid_mappings, message_tags, keyword_tags } from '../db/schema';
import type { Context } from 'hono';
import { nanoid } from 'nanoid';

// Custom type for our context with bindings
type AppContext = Context<{
  Bindings: {
    DB: D1Database;
    [key: string]: any;
  };
  Variables: {
    db: ReturnType<typeof createDb>;
    user?: any;
    userPermissions?: string[];
  };
}>;

export const messagesHandler = {
  // List messages with optional filtering
  async list(c: AppContext) {
    const db = c.get('db');
    const url = new URL(c.req.url);
    // Support both phone_id and phone_iccid parameters for backward compatibility
    const phoneId = url.searchParams.get('phone_iccid') || url.searchParams.get('phone_id');
    const direction = url.searchParams.get('direction');
    const search = url.searchParams.get('search');
    const limit = parseInt(url.searchParams.get('limit') || '100');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    
    try {
      let query = db
        .select({
          id: messages.id,
          phone_iccid: sql<string>`COALESCE(${messages.phone_iccid}, ${messages.phone_id})`, // Use phone_iccid as primary, phone_id for backward compatibility
          content: messages.content,
          direction: messages.direction,
          sender: messages.sender,
          timestamp: messages.timestamp,
          status: messages.status,
          metadata: messages.metadata,
          created_at: messages.created_at,
          type: messages.type,
          recipient: messages.recipient,
          // Phone details
          phone_number: sql<string>`COALESCE(${iccid_mappings.phone_number}, ${sims.phone_number}, ${messages.phone_number})`,
          carrier: sql<string>`COALESCE(${iccid_mappings.carrier}, ${sims.carrier})`,
          country: sql<string>`COALESCE(${iccid_mappings.country}, 'Unknown')`
        })
        .from(messages)
        .leftJoin(sims, sql`${sims.iccid} = COALESCE(${messages.phone_iccid}, ${messages.phone_id})`)
        .leftJoin(
          iccid_mappings,
          and(
            eq(sims.iccid, iccid_mappings.iccid),
            eq(iccid_mappings.is_active, true)
          )
        );

      // Build WHERE conditions
      const conditions = [];
      
      if (phoneId) {
        conditions.push(or(
          eq(messages.phone_iccid, phoneId),
          eq(messages.phone_id, phoneId)
        ));
      }
      
      if (direction) {
        conditions.push(eq(messages.direction, direction));
      }
      
      if (search) {
        conditions.push(like(messages.content, `%${search}%`));
      }
      
      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }
      
      // Apply ordering and pagination
      const results = await query
        .orderBy(desc(messages.timestamp))
        .limit(limit)
        .offset(offset);

      // Get tags for messages
      const messageIds = results.map(m => m.id);
      const tags = messageIds.length > 0 ? await db
        .select({
          message_id: message_tags.message_id,
          keyword: keyword_tags.keyword,
          tag: keyword_tags.tag,
          color: keyword_tags.color,
          matched_text: message_tags.matched_text,
          position: message_tags.position
        })
        .from(message_tags)
        .innerJoin(keyword_tags, eq(message_tags.keyword_tag_id, keyword_tags.id))
        .where(inArray(message_tags.message_id, messageIds)) : [];

      // Group tags by message
      const tagsByMessage = tags.reduce((acc: any, tag) => {
        if (!acc[tag.message_id]) {
          acc[tag.message_id] = [];
        }
        acc[tag.message_id].push(tag);
        return acc;
      }, {});

      // Add tags to messages
      const messagesWithTags = results.map(msg => ({
        ...msg,
        tags: tagsByMessage[msg.id] || []
      }));

      return c.json({
        success: true,
        data: messagesWithTags,
        pagination: {
          limit,
          offset,
          total: results.length
        }
      });
    } catch (error: any) {
      console.error('[Messages] List error:', error);
      return c.json({
        success: false,
        error: 'Failed to fetch messages'
      }, 500);
    }
  },

  // Get specific message
  async get(c: AppContext) {
    const db = c.get('db');
    const messageId = c.req.param('id');
    
    try {
      const results = await db
        .select({
          id: messages.id,
          phone_iccid: sql<string>`COALESCE(${messages.phone_iccid}, ${messages.phone_id})`,
          content: messages.content,
          direction: messages.direction,
          sender: messages.sender,
          timestamp: messages.timestamp,
          status: messages.status,
          metadata: messages.metadata,
          created_at: messages.created_at,
          type: messages.type,
          recipient: messages.recipient,
          // Phone details
          phone_number: sql<string>`COALESCE(${iccid_mappings.phone_number}, ${sims.phone_number}, ${messages.phone_number})`,
          carrier: sql<string>`COALESCE(${iccid_mappings.carrier}, ${sims.carrier})`,
          country: sql<string>`COALESCE(${iccid_mappings.country}, 'Unknown')`
        })
        .from(messages)
        .leftJoin(sims, sql`${sims.iccid} = COALESCE(${messages.phone_iccid}, ${messages.phone_id})`)
        .leftJoin(
          iccid_mappings,
          and(
            eq(sims.iccid, iccid_mappings.iccid),
            eq(iccid_mappings.is_active, true)
          )
        )
        .where(eq(messages.id, messageId))
        .limit(1);

      if (results.length === 0) {
        return c.json({
          success: false,
          error: 'Message not found'
        }, 404);
      }

      // Get tags for this message
      const tags = await db
        .select({
          keyword: keyword_tags.keyword,
          tag: keyword_tags.tag,
          color: keyword_tags.color,
          matched_text: message_tags.matched_text,
          position: message_tags.position
        })
        .from(message_tags)
        .innerJoin(keyword_tags, eq(message_tags.keyword_tag_id, keyword_tags.id))
        .where(eq(message_tags.message_id, messageId));

      return c.json({
        success: true,
        data: {
          ...results[0],
          tags
        }
      });
    } catch (error: any) {
      console.error('[Messages] Get error:', error);
      return c.json({
        success: false,
        error: 'Failed to fetch message'
      }, 500);
    }
  },

  // Send a new message
  async send(c: AppContext) {
    const db = c.get('db');
    const body = await c.req.json();
    const user = c.get('user');
    
    try {
      const { phone_id, phone_iccid, content, recipient } = body;
      
      // Accept both phone_id and phone_iccid for backward compatibility
      const phoneIccid = phone_iccid || phone_id;
      
      if (!phoneIccid || !content || !recipient) {
        return c.json({
          success: false,
          error: 'Missing required fields: phone_iccid (or phone_id), content, recipient'
        }, 400);
      }

      // Verify the phone exists
      const phone = await db
        .select({ iccid: sims.iccid })
        .from(sims)
        .where(eq(sims.iccid, phoneIccid))
        .limit(1);

      if (phone.length === 0) {
        return c.json({
          success: false,
          error: 'Phone not found'
        }, 404);
      }

      // Create the message
      const messageId = nanoid();
      const timestamp = new Date().toISOString();
      
      await db.insert(messages).values({
        id: messageId,
        phone_iccid: phoneIccid, // Use phone_iccid as the primary field
        phone_id: phoneIccid, // Also populate phone_id for backward compatibility
        content,
        type: 'outgoing',
        direction: 'outgoing',
        sender: recipient,
        timestamp,
        status: 'pending',
        recipient,
        metadata: JSON.stringify({
          sent_by: user?.email || 'unknown',
          sent_at: timestamp,
          recipient
        })
      });

      return c.json({
        success: true,
        data: {
          id: messageId,
          status: 'pending'
        }
      });
    } catch (error: any) {
      console.error('[Messages] Send error:', error);
      return c.json({
        success: false,
        error: 'Failed to send message'
      }, 500);
    }
  },

  // Delete message
  async deleteMessage(c: AppContext) {
    const db = c.get('db');
    const messageId = c.req.param('id');
    
    try {
      // Delete message (cascades to message_tags due to foreign key)
      const result = await db
        .delete(messages)
        .where(eq(messages.id, messageId));

      return c.json({
        success: true,
        message: 'Message deleted successfully'
      });
    } catch (error: any) {
      console.error('[Messages] Delete error:', error);
      return c.json({
        success: false,
        error: 'Failed to delete message'
      }, 500);
    }
  },

  // Get message statistics
  async stats(c: AppContext) {
    const db = c.get('db');
    const url = new URL(c.req.url);
    const phoneId = url.searchParams.get('phone_iccid') || url.searchParams.get('phone_id');
    
    try {
      let baseQuery = db
        .select({
          total: sql<number>`COUNT(*)`,
          incoming: sql<number>`SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END)`,
          outgoing: sql<number>`SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END)`,
          pending: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
          sent: sql<number>`SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END)`,
          failed: sql<number>`SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)`
        })
        .from(messages);

      if (phoneId) {
        baseQuery = baseQuery.where(or(
          eq(messages.phone_iccid, phoneId),
          eq(messages.phone_id, phoneId)
        ));
      }

      const results = await baseQuery;

      return c.json({
        success: true,
        data: results[0] || {
          total: 0,
          incoming: 0,
          outgoing: 0,
          pending: 0,
          sent: 0,
          failed: 0
        }
      });
    } catch (error: any) {
      console.error('[Messages] Stats error:', error);
      return c.json({
        success: false,
        error: 'Failed to fetch message statistics'
      }, 500);
    }
  }
};