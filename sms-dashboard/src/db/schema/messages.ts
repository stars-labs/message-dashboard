import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { sims, phones } from './sims';

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  phone_iccid: text('phone_iccid').notNull().references(() => phones.iccid, { onDelete: 'cascade' }),
  phone_number: text('phone_number'),
  content: text('content').notNull(),
  timestamp: text('timestamp').default(sql`CURRENT_TIMESTAMP`),
  type: text('type', { enum: ['received', 'sent'] }).notNull(),
  recipient: text('recipient'),
  status: text('status').default('received'),
  verification_code: text('verification_code'),
  error_message: text('error_message'),
  sms_id: text('sms_id'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});