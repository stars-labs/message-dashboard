<script lang="ts">
  import type { ApiMessage } from '../../shared/api/messages.js';
  import MessageComposer from '../lib/MessageComposer.svelte';
  import type { ViewPhone } from './types.js';

  interface Props {
    selectedPhone: ViewPhone | null;
    phoneNumbers: readonly ViewPhone[];
    messages: readonly ApiMessage[];
    onSend: (message: {
      phone_iccid: string;
      recipient: string;
      content: string;
    }) => Promise<unknown>;
    onClose: () => void;
  }

  let { selectedPhone, phoneNumbers, messages, onSend, onClose }: Props = $props();
</script>

<div
  class="hidden lg:block 2xl:hidden fixed inset-0 z-30 bg-stone-900/28"
  onclick={onClose}
  role="presentation"
></div>
<div
  class="hidden lg:flex 2xl:hidden fixed top-0 right-0 bottom-0 z-40 w-[400px] flex-col
        bg-white border-l border-stone-200"
  style="box-shadow: -16px 0 40px rgba(28,25,23,.16);"
>
  <div class="flex items-center justify-between px-5 py-4 border-b border-stone-200 flex-shrink-0">
    <h3 class="text-sm font-semibold text-stone-900">发送短信</h3>
    <button
      onclick={onClose}
      aria-label="关闭发送短信"
      class="p-1.5 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-lg transition-colors"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M6 18L18 6M6 6l12 12"
        />
      </svg>
    </button>
  </div>
  <div class="flex-1 min-h-0 overflow-y-auto">
    <MessageComposer {selectedPhone} {phoneNumbers} {messages} onmessagesent={onSend} />
  </div>
</div>
