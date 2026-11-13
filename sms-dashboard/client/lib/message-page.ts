export const MESSAGE_PAGE_SIZE = 100;

/** The fields paging reads off a message. */
export interface PagedMessage {
  id: string;
  timestamp?: string | null;
  [column: string]: unknown;
}

export interface MessagePagination {
  has_more?: boolean;
  [column: string]: unknown;
}

function timestampOf(message: PagedMessage): number {
  const value = message?.timestamp ? new Date(message.timestamp).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}

export function mergeMessagePage(
  current: PagedMessage[] = [],
  incoming: PagedMessage[] = [],
  { replace = false }: { replace?: boolean } = {},
): PagedMessage[] {
  const byId = new Map<string, PagedMessage>();
  const source = replace ? incoming : [...current, ...incoming];

  for (const message of source) {
    if (!message?.id) continue;
    byId.set(message.id, message);
  }

  return [...byId.values()].sort((left, right) => timestampOf(right) - timestampOf(left));
}

export function nextMessageOffset(messages: PagedMessage[] = []): number {
  return new Set(messages.map(({ id }) => id).filter(Boolean)).size;
}

export function hasMoreMessages(pagination: MessagePagination | null | undefined = {}): boolean {
  return pagination?.has_more === true;
}
