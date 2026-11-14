export const MESSAGE_PAGE_SIZE = 100;

/** The fields paging reads off a message. */
interface PagedMessage {
  id: string;
  timestamp?: string | null;
}

interface MessagePagination {
  has_more?: boolean;
}

function timestampOf(message: PagedMessage): number {
  const value = message.timestamp ? new Date(message.timestamp).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}

export function mergeMessagePage<Message extends PagedMessage>(
  current: readonly Message[] = [],
  incoming: readonly Message[] = [],
  { replace = false }: { replace?: boolean } = {},
): Message[] {
  const byId = new Map<string, Message>();
  const source = replace ? incoming : [...current, ...incoming];

  for (const message of source) {
    if (message.id === '') continue;
    byId.set(message.id, message);
  }

  return [...byId.values()].sort((left, right) => timestampOf(right) - timestampOf(left));
}

export function nextMessageOffset(messages: readonly PagedMessage[] = []): number {
  return new Set(messages.map(({ id }) => id).filter((id) => id !== '')).size;
}

export function hasMoreMessages(pagination: MessagePagination | null | undefined = {}): boolean {
  return pagination?.has_more === true;
}
