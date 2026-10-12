import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const iccid_mappings = sqliteTable('iccid_mappings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  iccid: text('iccid').unique().notNull(),
  phone_number: text('phone_number').notNull(),
  carrier: text('carrier'),
  country: text('country'),
  notes: text('notes'),
  is_active: integer('is_active', { mode: 'boolean' }).default(true),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});