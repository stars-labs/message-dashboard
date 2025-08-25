import { sql } from 'drizzle-orm';
import { text, integer, sqliteTable, primaryKey, index, real } from 'drizzle-orm/sqlite-core';

// Modems table
export const modems = sqliteTable('modems', {
  equipment_id: text('equipment_id').primaryKey(),
  manufacturer: text('manufacturer'),
  model: text('model'),
  firmware_revision: text('firmware_revision'),
  hardware_revision: text('hardware_revision'),
  device_path: text('device_path'),
  usb_port: integer('usb_port'),
  modem_index: integer('modem_index'),
  status: text('status').default('disconnected'),
  last_seen: text('last_seen').default(sql`CURRENT_TIMESTAMP`),
  first_seen: text('first_seen').default(sql`CURRENT_TIMESTAMP`),
  error_count: integer('error_count').default(0),
  last_error: text('last_error'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => {
  return {
    statusIdx: index('idx_modems_status').on(table.status),
    modemIndexIdx: index('idx_modems_modem_index').on(table.modem_index)
  }
});

// SIMs table
export const sims = sqliteTable('sims', {
  iccid: text('iccid').primaryKey(),
  phone_number: text('phone_number'),
  country_code: text('country_code'),
  carrier: text('carrier'),
  operator_name: text('operator_name'),
  operator_id: text('operator_id'),
  current_modem_id: text('current_modem_id').references(() => modems.equipment_id),
  status: text('status').default('inactive'),
  activation_date: text('activation_date'),
  deactivation_date: text('deactivation_date'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  sim_index: integer('sim_index')
}, (table) => {
  return {
    statusIdx: index('idx_sims_status').on(table.status),
    currentModemIdx: index('idx_sims_current_modem').on(table.current_modem_id),
    simIndexIdx: index('idx_sims_sim_index').on(table.sim_index)
  }
});

// Modem State table
export const modem_state = sqliteTable('modem_state', {
  modem_id: text('modem_id').primaryKey().references(() => modems.equipment_id),
  connection_status: text('connection_status'),
  signal_percent: integer('signal_percent'),
  rssi: integer('rssi'),
  rsrq: integer('rsrq'),
  rsrp: integer('rsrp'),
  snr: integer('snr'),
  network_type: text('network_type'),
  access_tech: text('access_tech'),
  band_info: text('band_info'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => {
  return {
    connectionStatusIdx: index('idx_modem_state_status').on(table.connection_status)
  }
});

// Daemon Health table
export const daemon_health = sqliteTable('daemon_health', {
  daemon_id: text('daemon_id').primaryKey(),
  last_heartbeat: text('last_heartbeat').notNull(),
  status: text('status').default('online'),
  last_ip: text('last_ip'),
  version: text('version'),
  modem_count: integer('modem_count').default(0),
  error_count: integer('error_count').default(0),
  last_error: text('last_error'),
  metadata: text('metadata'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

// Messages table
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  phone_iccid: text('phone_iccid').notNull(),
  phone_number: text('phone_number'),
  content: text('content').notNull(),
  timestamp: text('timestamp').default(sql`CURRENT_TIMESTAMP`),
  type: text('type').notNull(),
  recipient: text('recipient'),
  status: text('status').default('received'),
  verification_code: text('verification_code'),
  sms_id: text('sms_id'),
  error_message: text('error_message'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`),
  ai_verification_code: text('ai_verification_code'),
  ai_confidence: real('ai_confidence'),
  ai_classification: text('ai_classification'),
  sim_iccid: text('sim_iccid'),
  modem_id: text('modem_id'),
  phone_id: text('phone_id'), // For backward compatibility
  direction: text('direction'),
  sender: text('sender'),
  metadata: text('metadata')
}, (table) => {
  return {
    phoneIccidIdx: index('idx_messages_phone_iccid').on(table.phone_iccid),
    phoneIdIdx: index('idx_messages_phone_id').on(table.phone_id),
    timestampIdx: index('idx_messages_timestamp').on(table.timestamp),
    typeIdx: index('idx_messages_type').on(table.type),
    directionIdx: index('idx_messages_direction').on(table.direction)
  }
});

// ICCID Mappings table
export const iccid_mappings = sqliteTable('iccid_mappings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  iccid: text('iccid').notNull().unique(),
  phone_number: text('phone_number'),
  carrier: text('carrier'),
  country: text('country'),
  notes: text('notes'),
  is_active: integer('is_active', { mode: 'boolean' }).default(true),
  created_by: text('created_by'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => {
  return {
    iccidIdx: index('idx_iccid_mappings_iccid').on(table.iccid),
    activeIdx: index('idx_iccid_mappings_active').on(table.is_active)
  }
});

// Keyword Tags table
export const keyword_tags = sqliteTable('keyword_tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  keyword: text('keyword').notNull(),
  tag: text('tag').notNull(),
  color: text('color').default('#3B82F6'),
  priority: integer('priority').default(0),
  is_active: integer('is_active', { mode: 'boolean' }).default(true),
  case_sensitive: integer('case_sensitive', { mode: 'boolean' }).default(false),
  whole_word: integer('whole_word', { mode: 'boolean' }).default(false),
  created_by: text('created_by'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => {
  return {
    keywordIdx: index('idx_keyword_tags_keyword').on(table.keyword),
    activeIdx: index('idx_keyword_tags_active').on(table.is_active)
  }
});

// Message Tags table
export const message_tags = sqliteTable('message_tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  message_id: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  keyword_tag_id: integer('keyword_tag_id').notNull().references(() => keyword_tags.id, { onDelete: 'cascade' }),
  matched_text: text('matched_text').notNull(),
  position: integer('position').notNull(),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => {
  return {
    messageIdx: index('idx_message_tags_message').on(table.message_id),
    uniqueCombo: index('idx_message_tags_unique').on(table.message_id, table.keyword_tag_id, table.position)
  }
});

// AI Insights table
export const ai_insights = sqliteTable('ai_insights', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  phone_id: text('phone_id').notNull(),
  insight_type: text('insight_type').notNull(),
  content: text('content'),
  metadata: text('metadata'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => {
  return {
    phoneIdIdx: index('idx_ai_insights_phone_id').on(table.phone_id),
    typeIdx: index('idx_ai_insights_type').on(table.insight_type)
  }
});

// Chat Conversations table
export const chat_conversations = sqliteTable('chat_conversations', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  title: text('title'),
  last_message_at: text('last_message_at'),
  metadata: text('metadata'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => {
  return {
    userIdIdx: index('idx_chat_conversations_user_id').on(table.user_id),
    lastMessageIdx: index('idx_chat_conversations_last_message').on(table.last_message_at)
  }
});

// Chat Messages table
export const chat_messages = sqliteTable('chat_messages', {
  id: text('id').primaryKey(),
  conversation_id: text('conversation_id').notNull().references(() => chat_conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  metadata: text('metadata'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => {
  return {
    conversationIdx: index('idx_chat_messages_conversation').on(table.conversation_id),
    createdAtIdx: index('idx_chat_messages_created_at').on(table.created_at)
  }
});

// AI Function Calls table
export const ai_function_calls = sqliteTable('ai_function_calls', {
  id: text('id').primaryKey(),
  conversation_id: text('conversation_id'),
  function_name: text('function_name').notNull(),
  arguments: text('arguments'),
  result: text('result'),
  duration_ms: integer('duration_ms'),
  error: text('error'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => {
  return {
    conversationIdx: index('idx_ai_function_calls_conversation').on(table.conversation_id),
    functionNameIdx: index('idx_ai_function_calls_function').on(table.function_name)
  }
});

// Message Embeddings table (for Vectorize integration)
export const message_embeddings = sqliteTable('message_embeddings', {
  id: text('id').primaryKey(),
  message_id: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  embedding: text('embedding'),
  model: text('model'),
  dimensions: integer('dimensions'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => {
  return {
    messageIdx: index('idx_message_embeddings_message').on(table.message_id)
  }
});

// Audit Logs table
export const audit_logs = sqliteTable('audit_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  user_id: text('user_id'),
  action: text('action').notNull(),
  resource_type: text('resource_type'),
  resource_id: text('resource_id'),
  details: text('details'),
  ip_address: text('ip_address'),
  user_agent: text('user_agent'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`)
}, (table) => {
  return {
    userIdIdx: index('idx_audit_logs_user_id').on(table.user_id),
    actionIdx: index('idx_audit_logs_action').on(table.action),
    createdAtIdx: index('idx_audit_logs_created_at').on(table.created_at)
  }
});

// Export all tables as a single object for easy access
export const db = {
  modems,
  sims,
  modem_state,
  daemon_health,
  messages,
  iccid_mappings,
  keyword_tags,
  message_tags,
  ai_insights,
  chat_conversations,
  chat_messages,
  ai_function_calls,
  message_embeddings,
  audit_logs
};

// Type exports for use in application code
export type Modem = typeof modems.$inferSelect;
export type NewModem = typeof modems.$inferInsert;
export type Sim = typeof sims.$inferSelect;
export type NewSim = typeof sims.$inferInsert;
export type ModemState = typeof modem_state.$inferSelect;
export type NewModemState = typeof modem_state.$inferInsert;
export type DaemonHealth = typeof daemon_health.$inferSelect;
export type NewDaemonHealth = typeof daemon_health.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type IccidMapping = typeof iccid_mappings.$inferSelect;
export type NewIccidMapping = typeof iccid_mappings.$inferInsert;
export type KeywordTag = typeof keyword_tags.$inferSelect;
export type NewKeywordTag = typeof keyword_tags.$inferInsert;
export type MessageTag = typeof message_tags.$inferSelect;
export type NewMessageTag = typeof message_tags.$inferInsert;
export type AiInsight = typeof ai_insights.$inferSelect;
export type NewAiInsight = typeof ai_insights.$inferInsert;
export type ChatConversation = typeof chat_conversations.$inferSelect;
export type NewChatConversation = typeof chat_conversations.$inferInsert;
export type ChatMessage = typeof chat_messages.$inferSelect;
export type NewChatMessage = typeof chat_messages.$inferInsert;
export type AiFunctionCall = typeof ai_function_calls.$inferSelect;
export type NewAiFunctionCall = typeof ai_function_calls.$inferInsert;
export type MessageEmbedding = typeof message_embeddings.$inferSelect;
export type NewMessageEmbedding = typeof message_embeddings.$inferInsert;
export type AuditLog = typeof audit_logs.$inferSelect;
export type NewAuditLog = typeof audit_logs.$inferInsert;