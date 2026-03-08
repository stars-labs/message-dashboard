<script>
  import { onMount } from "svelte";
  import MessageHighlight from "./MessageHighlight.svelte";
  import { tagActions, keywords as keywordsStore } from "./tag-store.js";

  export let messages = [];
  export let selectedPhone = null;
  export let isLoading = false;

  let activeKeywords = [];

  // Subscribe to keywords store
  const unsubscribe = keywordsStore.subscribe(value => {
    activeKeywords = value;
  });

  onMount(() => {
    tagActions.loadKeywords();
    return unsubscribe;
  });

  // Format time as fixed timestamp
  function formatTime(timestamp) {
    if (!timestamp) return '未知时间';
    try {
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) return '无效时间';

      const now = new Date();
      const isToday = date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) === now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });

      const sameYear = date.toLocaleDateString('zh-CN', { year: 'numeric', timeZone: 'Asia/Shanghai' }) === now.toLocaleDateString('zh-CN', { year: 'numeric', timeZone: 'Asia/Shanghai' });

      if (isToday) {
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
      }
      if (sameYear) {
        return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
      }
      return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
    } catch (e) {
      return '无效时间';
    }
  }

  // Simple filter
  let displayMessages = [];
  $: {
    if (selectedPhone) {
      displayMessages = (messages || []).filter(msg => msg.phone_iccid === selectedPhone.iccid);
    } else {
      displayMessages = messages || [];
    }
  }
</script>

<div class="bg-white border border-stone-200 rounded-xl shadow-sm flex flex-col h-full min-h-0">
  <div class="p-4 border-b border-stone-200 flex-shrink-0">
    <h2 class="text-lg font-semibold text-stone-900">
      {#if selectedPhone}
        {selectedPhone.flag} {selectedPhone.number}
      {:else}
        最新消息 (所有设备)
      {/if}
    </h2>
  </div>

  <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4">
    {#if isLoading}
      <!-- Loading skeleton -->
      <div class="space-y-3">
        {#each Array(4) as _}
          <div class="bg-stone-50 rounded-lg p-3 border border-stone-200 animate-pulse">
            <div class="flex items-center justify-between mb-2">
              <div class="h-3 bg-stone-200 rounded w-1/3"></div>
              <div class="h-3 bg-stone-200 rounded w-16"></div>
            </div>
            <div class="bg-white rounded p-2 border border-stone-200 space-y-2">
              <div class="h-3 bg-stone-200 rounded w-full"></div>
              <div class="h-3 bg-stone-200 rounded w-2/3"></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if displayMessages.length === 0}
      <div class="text-center py-8">
        {#if !selectedPhone}
          <div class="text-5xl mb-4">📱</div>
          <p class="text-stone-400">选择左侧设备以查看消息</p>
        {:else}
          <div class="text-5xl mb-4">📭</div>
          <p class="text-stone-400">此设备暂无消息</p>
        {/if}
      </div>
    {:else}
      <div class="space-y-3">
        {#each displayMessages as message}
          <div class="bg-stone-50 rounded-lg p-3 border border-stone-200">
            <div class="flex items-center justify-between text-xs text-stone-400 mb-2">
              <div class="flex items-center gap-1 min-w-0">
                <span class="truncate">接收卡: {message.display_phone_number || message.phone_number || message.phone_iccid}</span>
                {#if message.direction === 'outgoing' || message.type === 'outgoing' || message.type === 'sent'}
                  {#if message.recipient}
                    <span class="shrink-0">• 接收方: {message.recipient}</span>
                  {:else if message.phone_number}
                    <span class="shrink-0">• 接收方: {message.phone_number}</span>
                  {/if}
                {:else if message.phone_number}
                  <span class="shrink-0">• 发送方: {message.phone_number}</span>
                {/if}
                {#if message.verificationCode}
                  <span class="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded-full font-mono font-semibold shrink-0">
                    {message.verificationCode}
                  </span>
                {/if}
              </div>
              <span class="ml-2 shrink-0">{formatTime(message.timestamp)}</span>
            </div>
            <div class="bg-white rounded p-2 text-stone-800 border border-stone-200 break-words">
              <MessageHighlight content={message.content} keywords={activeKeywords} />
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
