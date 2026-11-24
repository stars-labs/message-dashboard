import type { FilterRule } from '../../shared/api/filters.js';
import type { ApiMessage } from '../../shared/api/messages.js';
import { textOr } from '../../shared/text.js';
import { api, contractApi, errorMessage } from '../lib/api.js';
import {
  MESSAGE_PAGE_SIZE,
  hasMoreMessages,
  mergeMessagePage,
  nextMessageOffset,
} from '../lib/message-page.js';
import { SvelteSet } from 'svelte/reactivity';
import { isoFromMs } from '../lib/iso-time.js';
import { buildSentMessage } from './sent-message.js';
import type { ToastType } from './toasts.svelte.js';

type FirstPage = Awaited<ReturnType<typeof api.getMessages>>;

interface FeedContext {
  isSignedIn: () => boolean;
  selectedIccid: () => string | null;
  senderNumber: (iccid: string) => string | undefined;
  notify: (message: string, type: ToastType) => void;
}

function messageTime(message: ApiMessage) {
  const stamp = textOr(message.timestamp, null);
  return stamp === null ? 0 : Date.parse(stamp);
}

export class MessageFeed {
  messages = $state<ApiMessage[]>([]);
  hasMore = $state(false);
  loadingOlder = $state(false);
  readonly newMessageIds = new SvelteSet<string>();
  showFiltered = $state(false);
  filterRules = $state<FilterRule[]>([]);
  // A failed fetch must never look like a healthy, quiet fleet.
  loadError = $state<string | null>(null);
  fromCache = $state(false);
  private lastKnownTimestamp = $state<string | null>(null);
  private requestId = 0;
  private readonly context: FeedContext;

  constructor(context: FeedContext) {
    this.context = context;
  }

  clear() {
    this.messages = [];
    this.hasMore = false;
  }

  applyFirstPage(response: FirstPage) {
    this.loadError = null;
    if (!('failed' in response)) {
      this.messages = mergeMessagePage([], response.data, { replace: true });
      this.hasMore = hasMoreMessages(response.pagination);
      const newest = this.messages.reduce((max, m) => {
        const t = messageTime(m);
        return t > max ? t : max;
      }, 0);
      if (newest > 0) this.lastKnownTimestamp = isoFromMs(newest);
    } else {
      console.error('[App] Messages API failed');
      this.messages = [];
      this.hasMore = false;
      this.loadError = '短信列表加载失败';
    }
    this.fromCache = !('failed' in response) && response.sync.is_offline === true;
  }

  toggleFiltered = async () => {
    this.showFiltered = !this.showFiltered;
    if (this.showFiltered && this.filterRules.length === 0) {
      try {
        const response = await contractApi.filters.list();
        this.filterRules = response.filters;
      } catch (error) {
        console.warn('[App] Could not load filter rules for labels:', error);
      }
    }
    await this.load(this.context.selectedIccid(), { resetSync: true });
  };

  async load(
    phoneIccid: string | null,
    { replace = true, resetSync = false }: { replace?: boolean; resetSync?: boolean } = {},
  ) {
    if (!this.context.isSignedIn()) return;

    const requestId = ++this.requestId;

    try {
      const response = await api.getMessages({
        ...(phoneIccid ? { phone_iccid: phoneIccid } : {}),
        limit: MESSAGE_PAGE_SIZE,
        ...(this.showFiltered ? { include_filtered: 1 } : {}),
        ...(resetSync ? { reset_sync: 1 } : {}),
      });

      // Stale response: the user switched phones while loading.
      if (requestId !== this.requestId) return;

      if (replace || hasMoreMessages(response.pagination)) {
        this.hasMore = hasMoreMessages(response.pagination);
      }
      if (this.lastKnownTimestamp && this.messages.length > 0) {
        const cutoff = Date.parse(this.lastKnownTimestamp);
        console.log('[New Message Detection] lastKnownTimestamp:', this.lastKnownTimestamp);
        const freshIds = response.data.filter((m) => messageTime(m) > cutoff).map((m) => m.id);
        console.log('[New Message Detection] Found', freshIds.length, 'new messages:', freshIds);
        if (freshIds.length > 0) {
          freshIds.forEach((id) => this.newMessageIds.add(id));
          console.log(
            '[New Message Detection] Added new message IDs, newMessageIds size:',
            this.newMessageIds.size,
          );
          setTimeout(() => {
            freshIds.forEach((id) => this.newMessageIds.delete(id));
            console.log('[New Message Detection] Auto-cleared badges after 10s');
          }, 10000);
        }
      } else {
        console.log(
          '[New Message Detection] Skipped - lastKnownTimestamp:',
          this.lastKnownTimestamp,
          'messages.length:',
          this.messages.length,
        );
      }
      const newest = response.data.reduce(
        (max, m) => {
          const t = messageTime(m);
          return t > max ? t : max;
        },
        this.lastKnownTimestamp ? Date.parse(this.lastKnownTimestamp) : 0,
      );
      if (newest > 0) this.lastKnownTimestamp = isoFromMs(newest);
      // Polls merge into loaded history and preserve it on an empty incremental
      // response. Scope/filter changes replace the list, including with empty.
      if (response.data.length > 0) {
        this.messages = mergeMessagePage(this.messages, response.data, { replace });
      } else if (replace) {
        this.messages = [];
      }
    } catch (error) {
      if (requestId !== this.requestId) return;
      console.error('[App] Failed to load messages:', error);
      // Keep the loaded messages: a transient error must not blank valid data.
    }
  }

  loadOlder = async () => {
    if (!this.context.isSignedIn() || this.loadingOlder || !this.hasMore) return;

    this.loadingOlder = true;
    try {
      const selectedIccid = this.context.selectedIccid();
      const response = await api.getMessages({
        ...(selectedIccid ? { phone_iccid: selectedIccid } : {}),
        ...(this.showFiltered ? { include_filtered: 1 } : {}),
        limit: MESSAGE_PAGE_SIZE,
        offset: nextMessageOffset(this.messages),
        force_refresh: true,
      });

      if (response.data.length > 0) {
        this.messages = mergeMessagePage(this.messages, response.data);
      }
      this.hasMore = hasMoreMessages(response.pagination);
    } catch (error) {
      console.error('[App] Failed to load older messages:', error);
    } finally {
      this.loadingOlder = false;
    }
  };

  send = async (newMessage: { phone_iccid: string; recipient: string; content: string }) => {
    try {
      const response = await api.sendMessage({
        phone_iccid: newMessage.phone_iccid,
        recipient: newMessage.recipient,
        content: newMessage.content,
      });

      const senderNumber = textOr(
        this.context.senderNumber(newMessage.phone_iccid),
        newMessage.phone_iccid,
      );

      this.messages = [
        buildSentMessage(response.messageId, newMessage, senderNumber),
        ...this.messages,
      ];
      return response;
    } catch (error) {
      console.error('Failed to send message:', error);
      this.context.notify('发送失败: ' + errorMessage(error, '未知错误'), 'error');
      throw error;
    }
  };
}
