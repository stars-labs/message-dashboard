import type { Permission } from '../config/auth0-roles.js';

/** The dashboard's hash routes, in navigation order, and the permission each requires. */
export const VIEW_PERMISSION = {
  dashboard: 'messages.read',
  send: 'messages.send',
  'iccid-mappings': 'phones.write',
  balances: 'messages.read',
  keywords: 'keywords.read',
  filters: 'filters.read',
  users: 'users.read',
} as const satisfies Record<string, Permission>;

export type View = keyof typeof VIEW_PERMISSION;

export function isView(name: string): name is View {
  return Object.hasOwn(VIEW_PERMISSION, name);
}
