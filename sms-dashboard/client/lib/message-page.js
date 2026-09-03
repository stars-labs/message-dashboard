export const MESSAGE_PAGE_SIZE = 100;

function timestampOf(message) {
  const value = message?.timestamp ? new Date(message.timestamp).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}

export function mergeMessagePage(current = [], incoming = [], { replace = false } = {}) {
  const byId = new Map();
  const source = replace ? incoming : [...current, ...incoming];

  for (const message of source) {
    if (!message?.id) continue;
    byId.set(message.id, message);
  }

  return [...byId.values()].sort((left, right) => timestampOf(right) - timestampOf(left));
}

export function nextMessageOffset(messages = []) {
  return new Set(messages.map(({ id }) => id).filter(Boolean)).size;
}

export function hasMoreMessages(pagination = {}) {
  return pagination?.has_more === true;
}
