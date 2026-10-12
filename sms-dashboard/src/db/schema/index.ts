// Export all schema tables
export * from './modems';
export * from './sims';
export * from './messages';
export * from './users';
export * from './iccid-mappings';
export * from './keywords';
export * from './daemon';

// Re-export for convenience
import { modems, modem_state } from './modems';
import { sims, phones } from './sims';
import { messages } from './messages';
import { users, groups, permissions, user_groups, group_permissions, user_permissions, sessions, audit_logs, user_settings } from './users';
import { iccid_mappings } from './iccid-mappings';
import { keyword_tags, message_tags } from './keywords';
import { daemon_health } from './daemon';

export const schema = {
  // Core tables
  modems,
  modem_state,
  sims,
  phones, // Legacy support
  messages,
  
  // User management
  users,
  groups,
  permissions,
  user_groups,
  group_permissions,
  user_permissions,
  sessions,
  audit_logs,
  user_settings,
  
  // Additional features
  iccid_mappings,
  keyword_tags,
  message_tags,
  daemon_health
};