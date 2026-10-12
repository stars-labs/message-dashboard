import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // Auth0 sub claim
  email: text('email').unique().notNull(),
  name: text('name'),
  nickname: text('nickname'),
  picture: text('picture'),
  provider: text('provider').notNull(),
  auth0_id: text('auth0_id').unique(),
  email_verified: integer('email_verified', { mode: 'boolean' }).default(false),
  phone_number: text('phone_number'),
  phone_verified: integer('phone_verified', { mode: 'boolean' }).default(false),
  is_active: integer('is_active', { mode: 'boolean' }).default(true),
  is_admin: integer('is_admin', { mode: 'boolean' }).default(false),
  metadata: text('metadata', { mode: 'json' }),
  app_metadata: text('app_metadata', { mode: 'json' }),
  last_login: text('last_login'),
  login_count: integer('login_count').default(0),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export const groups = sqliteTable('groups', {
  id: text('id').primaryKey(),
  name: text('name').unique().notNull(),
  description: text('description'),
  metadata: text('metadata', { mode: 'json' }),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export const permissions = sqliteTable('permissions', {
  id: text('id').primaryKey(),
  name: text('name').unique().notNull(),
  description: text('description'),
  resource: text('resource'),
  action: text('action'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`)
});

export const user_groups = sqliteTable('user_groups', {
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  group_id: text('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`)
});

export const group_permissions = sqliteTable('group_permissions', {
  group_id: text('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  permission_id: text('permission_id').notNull().references(() => permissions.id, { onDelete: 'cascade' }),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`)
});

export const user_permissions = sqliteTable('user_permissions', {
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  permission_id: text('permission_id').notNull().references(() => permissions.id, { onDelete: 'cascade' }),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`)
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').unique().notNull(),
  expires_at: text('expires_at').notNull(),
  ip_address: text('ip_address'),
  user_agent: text('user_agent'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`)
});

export const audit_logs = sqliteTable('audit_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  user_id: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  resource: text('resource'),
  resource_id: text('resource_id'),
  details: text('details', { mode: 'json' }),
  ip_address: text('ip_address'),
  user_agent: text('user_agent'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`)
});

export const user_settings = sqliteTable('user_settings', {
  user_id: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  theme: text('theme').default('light'),
  notifications_enabled: integer('notifications_enabled', { mode: 'boolean' }).default(true),
  email_notifications: integer('email_notifications', { mode: 'boolean' }).default(true),
  sms_notifications: integer('sms_notifications', { mode: 'boolean' }).default(false),
  language: text('language').default('en'),
  timezone: text('timezone').default('UTC'),
  preferences: text('preferences', { mode: 'json' }),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});