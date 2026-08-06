<script>
  import { onMount } from "svelte";
  import MessageHighlight from "./MessageHighlight.svelte";
  import { tagActions, keywords as keywordsStore } from "./tag-store.js";

  export let messages = [];
  export let selectedPhone = null;
  export let isLoading = false;
  export let newMessageIds = new Set();
  export let onClearPhone = null;
  /** Whether spam/marketing messages are currently being shown. */
  export let showFiltered = false;
  /** How many messages the filter is hiding, from pagination.filtered_count. */
  export let filteredCount = 0;
  /** Called when the user flips the toggle; the parent refetches. */
  export let onToggleFiltered = null;
  /** Filter rules, used to name the rule that hid a message. */
  export let filterRules = [];

  let activeKeywords = [];

  // id -> readable label, so a hidden message can say WHY it was hidden.
  let ruleLabels = {};
  $: ruleLabels = Object.fromEntries(
    (filterRules || []).map(r => [r.id, r.note || r.pattern])
  );

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
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-lg font-semibold text-stone-900 truncate">
        {#if selectedPhone}
          <span>{selectedPhone.flag} {selectedPhone.number}</span>
        {:else}
          <span>最新消息 (所有设备)</span>
        {/if}
      </h2>

      <div class="flex items-center gap-2 shrink-0">
        <!-- Spam is hidden by default, but never silently: the count is always
             visible and one click reveals what was hidden and why. -->
        {#if onToggleFiltered && (filteredCount > 0 || showFiltered)}
          <button
            on:click={onToggleFiltered}
            class="px-2 py-1 text-xs rounded-md border transition-colors {showFiltered
              ? 'bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100'
              : 'bg-stone-50 border-stone-200 text-stone-500 hover:bg-stone-100 hover:text-stone-700'}"
            title={showFiltered ? '点击隐藏垃圾短信' : '点击查看被过滤的垃圾短信'}
          >
            {showFiltered ? '隐藏已过滤' : `已过滤 ${filteredCount} 条`}
          </button>
        {/if}

        {#if selectedPhone && onClearPhone}
          <button
            on:click={onClearPhone}
            class="px-2 py-1 text-xs text-stone-400 hover:text-stone-600 hover:bg-stone-100 rounded-md transition-colors"
            title="返回所有设备"
          >✕ 清除筛选</button>
        {/if}
      </div>
    </div>
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
          <div class="rounded-lg p-3 border transition-colors duration-500 {message.filter_status === 'filtered'
            ? 'bg-stone-100/70 border-stone-200 border-dashed opacity-70'
            : newMessageIds.has(message.id)
              ? 'bg-orange-50 border-orange-300 border-l-4 border-l-orange-500'
              : 'bg-stone-50 border-stone-200'}">
            <div class="flex items-center justify-between text-xs text-stone-400 mb-2">
              <div class="flex items-center gap-1 min-w-0">
                {#if newMessageIds.has(message.id)}
                  <span class="px-1.5 py-0.5 bg-orange-500 text-white rounded text-[10px] font-bold shrink-0">新</span>
                {/if}
                {#if message.filter_status === 'filtered'}
                  <!-- Name the rule, so a wrongly hidden message points at its cause. -->
                  <span
                    class="px-1.5 py-0.5 bg-stone-200 text-stone-600 rounded text-[10px] font-medium shrink-0"
                    title={ruleLabels[message.filter_rule_id] ? `匹配规则: ${ruleLabels[message.filter_rule_id]}` : '已被垃圾过滤规则隐藏'}
                  >
                    已过滤{ruleLabels[message.filter_rule_id] ? `: ${ruleLabels[message.filter_rule_id]}` : ''}
                  </span>
                {/if}
                {#if message.type === 'sent'}
                  <!-- For sent messages: show recipient as 接收卡, sender as 发送方 -->
                  <span class="truncate">接收卡: {message.recipient}</span>
                  <span class="shrink-0">• 发送方: {message.display_phone_number || message.phone_number || message.phone_iccid}</span>
                {:else}
                  <!-- For received messages: show our SIM as 接收卡, sender as 发送方 -->
                  <span class="truncate">接收卡: {message.display_phone_number || message.phone_iccid}</span>
                  {#if message.phone_number}
                    <span class="shrink-0">• 发送方: {message.phone_number}</span>
                  {/if}
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
