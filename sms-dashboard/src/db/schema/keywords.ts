import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { messages } from './messages';

export const keyword_tags = sqliteTable('keyword_tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  keyword: text('keyword').notNull(),
  tag: text('tag').notNull(),
  color: text('color').default('#3B82F6'),
  priority: integer('priority').default(0),
  case_sensitive: integer('case_sensitive', { mode: 'boolean' }).default(false),
  whole_word: integer('whole_word', { mode: 'boolean' }).default(false),
  usage_count: integer('usage_count').default(0),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export const message_tags = sqliteTable('message_tags', {
  message_id: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  keyword_tag_id: integer('keyword_tag_id').notNull().references(() => keyword_tags.id, { onDelete: 'cascade' }),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`)
});