import type { Permission } from '../config/auth0-roles.js';

/** In navigation order. */
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
