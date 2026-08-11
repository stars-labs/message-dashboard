<script>
  import { onMount } from "svelte";
  import { fly } from "svelte/transition";
  import MessageHighlight from "./MessageHighlight.svelte";
  import { tagActions, keywords as keywordsStore } from "./tag-store.js";
  import { copyCode } from "./clipboard.js";
  import { formatCardNumber } from "./card-number.js";
  import { getCountryFlag } from "./countries.js";

  let {
    messages = [],
    selectedPhone = null,
    isLoading = false,
    newMessageIds = new Set(),
    onClearPhone = null,
    /** Whether spam/marketing messages are currently being shown. */
    showFiltered = false,
    /** How many messages the filter is hiding, from pagination.filtered_count. */
    filteredCount = 0,
    /** Called when the user flips the toggle; the parent refetches. */
    onToggleFiltered = null,
    /** Filter rules, used to name the rule that hid a message. */
    filterRules = [],
  } = $props();

  let activeKeywords = $state([]);

  // id -> readable label, so a hidden message can say WHY it was hidden.
  let ruleLabels = $derived(
    Object.fromEntries((filterRules || []).map(r => [r.id, r.note || r.pattern]))
  );

  // Subscribe to keywords store
  const unsubscribe = keywordsStore.subscribe(value => { activeKeywords = value; });
  onMount(() => { tagActions.loadKeywords(); return unsubscribe; });

  // Copy feedback: stores the message.id of the last-copied code for 2 s.
  let copiedId = $state(null);
  let copiedCode = $state(null);
  let copyTimer = null;

  async function handleCopy(message) {
    const ok = await copyCode(message.verification_code);
    if (!ok) return;
    if (copyTimer) clearTimeout(copyTimer);
    copiedId = message.id;
    copiedCode = message.verification_code;
    copyTimer = setTimeout(() => {
      copiedId = null;
      copiedCode = null;
    }, 2000);
  }

  // Content filter: 'code' = only messages with a parsed verification_code,
  // 'all' = everything that isn't rule-hidden.
  let contentFilter = $state('code');

  // Messages shown in the list, after both dimensions of filtering.
  let displayMessages = $derived.by(() => {
    let base = messages || [];
    // Narrow to the selected card if one is chosen.
    if (selectedPhone) {
      base = base.filter(m => m.phone_iccid === selectedPhone.iccid);
    }
    // Content filter
    if (contentFilter === 'code') {
      base = base.filter(m => m.verification_code);
    }
    // Spam toggle — when showFiltered=false keep filtered messages hidden.
    if (!showFiltered) {
      base = base.filter(m => m.filter_status !== 'filtered');
    }
    return base;
  });

  // Count of messages that would appear if spam filter were lifted
  // (only meaningful in 'all' mode; in 'code' mode verified messages are never filtered).
  let hiddenSpamCount = $derived(
    contentFilter === 'all' ? filteredCount : 0
  );

  // Format a timestamp for the 接收卡 column: HH:MM:SS today, MM/DD HH:MM otherwise.
  function formatTime(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return '';
      const now = new Date();
      const opts = { timeZone: 'Asia/Shanghai' };
      const isToday = d.toLocaleDateString('zh-CN', opts) === now.toLocaleDateString('zh-CN', opts);
      if (isToday) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', ...opts });
      return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...opts });
    } catch { return ''; }
  }
</script>

<div class="relative bg-white border-0 rounded-none shadow-none lg:border lg:border-stone-200
  lg:rounded-xl lg:shadow-raised flex flex-col h-full min-h-0">

  <!-- Explicit copy confirmation. Kept outside the scrolling rows so it is
       always visible and never changes the table layout. -->
  <div class="absolute top-[58px] left-1/2 -translate-x-1/2 z-30 pointer-events-none" aria-live="polite">
    {#if copiedCode}
      <div
        role="status"
        transition:fly={{ y: -6, duration: 160 }}
        class="flex items-center gap-2 min-w-max px-3 py-2 rounded-md border border-stone-700
          bg-stone-900 text-white shadow-lg"
      >
        <span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 shrink-0">
          <svg class="w-3 h-3" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2.25 6.1 4.8 8.5 9.8 3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <span class="text-xs font-medium">已复制</span>
        <span class="font-mono text-sm font-semibold tracking-wider tabular-nums text-orange-200">{copiedCode}</span>
      </div>
    {/if}
  </div>

  <!-- ── Header ───────────────────────────────────────────────────────────── -->
  <div class="px-4 py-3 border-b border-stone-100 flex-shrink-0">
    <div class="flex items-center justify-between gap-3">

      <!-- Left: title + card indicator -->
      <div class="flex items-center gap-2 min-w-0">
        {#if selectedPhone}
          <span class="font-mono font-bold text-sm text-stone-900 tabular-nums shrink-0">
            {formatCardNumber(selectedPhone.sim_index)}
          </span>
          <span class="text-sm text-stone-500 font-mono truncate">
            {selectedPhone.flag || ''} {selectedPhone.number || selectedPhone.iccid}
          </span>
          {#if onClearPhone}
            <button
              onclick={onClearPhone}
              class="ml-1 px-1.5 py-0.5 text-[11px] text-stone-400 hover:text-stone-600 hover:bg-stone-100 rounded transition-colors shrink-0"
              title="返回全部设备"
            >✕</button>
          {/if}
        {:else}
          <span class="text-sm font-medium text-stone-700">全部设备</span>
          <span class="flex items-center gap-1 text-xs text-stone-400">
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            实时
          </span>
        {/if}
      </div>

      <!-- Right: hint + content filter + spam toggle -->
      <div class="flex items-center gap-2 shrink-0">
        <span class="hidden lg:block text-[11px] text-stone-400">点击验证码即复制</span>

        <!-- Content filter: segmented control -->
        <div class="flex items-center bg-stone-100 rounded-lg p-0.5 text-xs">
          <button
            onclick={() => { contentFilter = 'code'; }}
            class="px-2.5 py-1 rounded-md transition-all {contentFilter === 'code'
              ? 'bg-white shadow-sm font-semibold text-stone-800'
              : 'text-stone-500 hover:text-stone-700'}"
          >验证码</button>
          <button
            onclick={() => { contentFilter = 'all'; }}
            class="px-2.5 py-1 rounded-md transition-all {contentFilter === 'all'
              ? 'bg-white shadow-sm font-semibold text-stone-800'
              : 'text-stone-500 hover:text-stone-700'}"
          >全部短信</button>
        </div>

        <!-- The spam control has no action in verification-code mode and no
             value when the count is zero, so do not reserve mobile space for it. -->
        {#if contentFilter === 'all' && (filteredCount > 0 || showFiltered)}
          <div class="w-px h-[18px] bg-stone-200 mx-0.5 lg:mx-1"></div>

          <button
            onclick={onToggleFiltered}
            aria-pressed={showFiltered}
            aria-label={!showFiltered ? `显示 ${filteredCount} 条垃圾短信` : '隐藏垃圾短信'}
            class="flex items-center gap-1.5 text-xs text-stone-600 hover:text-stone-900 transition-colors"
            title={!showFiltered ? '点击查看被规则隐藏的短信' : '点击隐藏垃圾短信'}
          >
            <!-- Checkbox: filled when hiding spam (= checked state = hiding enabled) -->
            <span class="inline-flex items-center justify-center w-[13px] h-[13px] rounded-[3px] border transition-colors shrink-0
              {!showFiltered
                ? 'border-stone-500 bg-stone-500'
                : 'border-stone-300 bg-white'}">
              {#if !showFiltered}
                <svg class="w-2.5 h-2.5 text-white" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              {/if}
            </span>
            <span class="lg:hidden">垃圾 <strong class="font-mono tabular-nums">{filteredCount}</strong></span>
            <span class="hidden lg:inline">隐藏垃圾 <strong class="font-mono tabular-nums">{filteredCount}</strong></span>
          </button>
        {/if}
      </div>
    </div>
  </div>

  <!-- ── Column headers (desktop only) ────────────────────────────────────── -->
  <div class="hidden lg:grid px-3 py-1.5 border-b border-stone-50 flex-shrink-0"
    style="grid-template-columns: 3px 250px 118px minmax(0, 1fr) 92px; gap: 0 16px;">
    <div></div><!-- accent rail -->
    <div class="text-[11px] font-semibold text-stone-400 tracking-widest uppercase">发送 / 接收</div>
    <div class="text-[11px] font-semibold text-stone-400 tracking-widest uppercase">验证码</div>
    <div class="text-[11px] font-semibold text-stone-400 tracking-widest uppercase">短信内容</div>
    <div class="text-[11px] font-semibold text-stone-400 tracking-widest uppercase text-right">时间</div>
  </div>

  <!-- ── Message list ──────────────────────────────────────────────────────── -->
  <div class="flex-1 min-h-0 overflow-y-auto">

    {#if isLoading}
      <!-- Loading skeleton: 4 rows with the same column layout -->
      {#each Array(4) as _, i}
        <div class="px-3 py-3 border-b border-stone-50 animate-pulse
          hidden lg:grid items-center"
          style="grid-template-columns: 3px 250px 118px minmax(0, 1fr) 92px; gap: 0 16px;">
          <div class="h-8 w-0.5 bg-stone-100 rounded"></div>
          <div class="space-y-1.5">
            <div class="h-3 bg-stone-100 rounded w-28"></div>
            <div class="h-2.5 bg-stone-100 rounded w-40"></div>
          </div>
          <div class="h-7 bg-stone-100 rounded w-20"></div>
          <div class="space-y-1.5">
            <div class="h-3 bg-stone-100 rounded w-full"></div>
            <div class="h-3 bg-stone-100 rounded w-2/3"></div>
          </div>
          <div class="h-3 bg-stone-100 rounded w-16 ml-auto"></div>
        </div>
      {/each}
      <!-- Mobile skeleton -->
      {#each Array(4) as _}
        <div class="lg:hidden p-3 border-b border-stone-100 animate-pulse space-y-2">
          <div class="flex gap-2">
            <div class="h-6 bg-stone-100 rounded w-16"></div>
            <div class="h-4 bg-stone-100 rounded w-24 mt-1"></div>
          </div>
          <div class="h-3 bg-stone-100 rounded w-full"></div>
        </div>
      {/each}

    {:else if displayMessages.length === 0}
      <div class="flex flex-col items-center justify-center h-full py-16 text-center">
        {#if contentFilter === 'code' && messages.length > 0}
          <div class="text-4xl mb-3">🔍</div>
          <p class="text-sm font-medium text-stone-500">当前时段无验证码短信</p>
          <button onclick={() => { contentFilter = 'all'; }}
            class="mt-2 text-xs text-action-text hover:underline">
            切换到「全部短信」查看
          </button>
        {:else if !selectedPhone}
          <!-- Three breathing dots — "waiting for codes" empty state per §9 -->
          <div class="flex gap-2 mb-4">
            <span class="w-3 h-3 rounded-full bg-emerald-400 animate-pulse"></span>
            <span class="w-3 h-3 rounded-full bg-emerald-200 animate-pulse [animation-delay:.2s]"></span>
            <span class="w-3 h-3 rounded-full bg-emerald-100 animate-pulse [animation-delay:.4s]"></span>
          </div>
          <p class="text-sm font-semibold text-stone-600">正在监听全部设备</p>
          <p class="text-xs text-stone-400 mt-1">新验证码到达后会自动出现在这里</p>
        {:else}
          <div class="text-4xl mb-3">📭</div>
          <p class="text-sm text-stone-400">此设备暂无消息</p>
        {/if}
      </div>

    {:else}
      {#each displayMessages as message, idx}
        {@const isNew = newMessageIds.has(message.id)}
        {@const isFiltered = message.filter_status === 'filtered'}
        {@const isCopied = copiedId === message.id}
        {@const hasCode = !!message.verification_code}
        {@const receiverIndex = message.phone_sim_index ?? selectedPhone?.sim_index}
        {@const receiverNumber = message.display_phone_number || selectedPhone?.number || message.phone_iccid?.slice(-8) || '—'}
        {@const receiverFlag = message.phone_country ? getCountryFlag(message.phone_country) : selectedPhone?.flag || ''}

        <!-- ── Desktop row ──────────────────────────────────────────────── -->
        <div
          class="hidden lg:grid items-center px-3 py-2.5 border-b transition-colors duration-500
            {isFiltered
              ? 'border-stone-100 opacity-60'
              : isNew
                ? 'bg-[#fffbf5] border-stone-100'
                : idx % 2 === 0 ? 'bg-white border-stone-50' : 'bg-[#fafaf9] border-stone-50'}"
          style="grid-template-columns: 3px 250px 118px minmax(0, 1fr) 92px; gap: 0 16px;"
        >
          <!-- Accent rail: orange for newest, transparent otherwise -->
          <div class="self-stretch rounded-sm {isNew ? 'bg-orange-400' : 'bg-transparent'}"></div>

          <!-- 发送方 + 接收卡：一次扫视即可确认消息路径 -->
          <div class="min-w-0 font-mono">
            <div class="text-sm font-semibold text-stone-800 truncate" title={message.phone_number}>
              {message.phone_number || '—'}
            </div>
            <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-stone-400 min-w-0">
              <span class="shrink-0 text-stone-300">接收</span>
              {#if receiverIndex != null}
                <span class="font-semibold text-stone-500 tabular-nums shrink-0">{formatCardNumber(receiverIndex)}</span>
                <span class="text-stone-300 shrink-0">·</span>
              {/if}
              <span class="truncate" title={receiverNumber}>{receiverFlag} {receiverNumber}</span>
            </div>
          </div>

          <!-- 验证码: the headline element -->
          {#if hasCode}
            <button
              onclick={() => handleCopy(message)}
              class="inline-flex items-center justify-center px-2.5 py-1 rounded-lg border
                font-mono text-lg font-semibold tracking-widest tabular-nums cursor-pointer
                transition-colors duration-200
                {isCopied
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                  : 'bg-[#fff7ed] border-[#fed7aa] text-stone-900 hover:border-orange-300 hover:bg-orange-50'}"
              title={isCopied ? '已复制！' : '点击复制'}
            >
              {message.verification_code}
            </button>
          {:else}
            <span class="text-xs text-stone-300 font-mono pl-1">无验证码</span>
          {/if}

          <!-- 正文 -->
          <div class="text-sm text-stone-600 leading-snug line-clamp-2 min-w-0">
            {#if isFiltered}
              <span class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-500 mr-1.5 font-medium">
                已过滤{ruleLabels[message.filter_rule_id] ? `: ${ruleLabels[message.filter_rule_id]}` : ''}
              </span>
            {/if}
            <MessageHighlight content={message.content} keywords={activeKeywords} />
          </div>

          <!-- 时间 -->
          <div class="font-mono text-xs text-stone-400 text-right tabular-nums">
            {formatTime(message.timestamp)}
          </div>
        </div>

        <!-- ── Mobile card ────────────────────────────────────────────────── -->
        <div
          class="lg:hidden p-3 border-b transition-colors duration-500
            {isFiltered
              ? 'border-stone-100 opacity-60'
              : isNew
                ? 'bg-[#fff7ed] border border-[#fdba74] rounded-xl shadow-focus mx-2 my-1.5'
                : 'border-stone-100 bg-white'}"
        >
          <!-- Top row: code + sender + time -->
          <div class="flex items-center gap-2">
            {#if hasCode}
              <button
                onclick={() => handleCopy(message)}
                class="font-mono text-base font-semibold tabular-nums px-2 py-0.5 rounded-md border
                  transition-colors duration-200 shrink-0
                  {isCopied
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                    : isNew
                      ? 'bg-[#fff7ed] border-[#fed7aa] text-stone-900'
                      : 'bg-stone-50 border-stone-200 text-stone-800'}"
              >
                {message.verification_code}
              </button>
            {/if}
            <span class="text-sm font-mono font-semibold text-stone-600 truncate">
              {message.phone_number || '—'}
            </span>
            <span class="ml-auto font-mono text-xs text-stone-400 shrink-0">
              {formatTime(message.timestamp)}
            </span>
          </div>

          <!-- Receiving card stays with the sender, before the message body. -->
          <div class="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-stone-400 min-w-0">
            <span class="text-stone-300 shrink-0">接收</span>
            {#if receiverIndex != null}
              <span class="font-semibold text-stone-500 tabular-nums shrink-0">{formatCardNumber(receiverIndex)}</span>
              <span class="text-stone-300 shrink-0">·</span>
            {/if}
            <span class="truncate">{receiverFlag} {receiverNumber}</span>
          </div>

          <!-- Body -->
          <p class="text-sm text-stone-600 leading-snug line-clamp-2 mt-1.5">
            {message.content}
          </p>

          {#if isFiltered}
            <div class="mt-1.5">
              <span class="px-1 py-0.5 rounded bg-stone-100 text-stone-400 text-[10px]">已过滤</span>
            </div>
          {/if}
        </div>
      {/each}

      <!-- Pinned spam-reveal banner above the scroll area's bottom — shows
           only in 'all' mode when there are hidden messages and they aren't shown yet -->
      {#if contentFilter === 'all' && !showFiltered && filteredCount > 0}
        <div class="sticky bottom-0 flex items-center justify-between
          px-4 py-2.5 bg-stone-50 border-t border-stone-200 text-sm">
          <span class="text-stone-500">另有 <strong class="text-stone-700 font-mono">{filteredCount}</strong> 条被规则隐藏</span>
          <button onclick={onToggleFiltered}
            class="text-action-text text-xs font-medium hover:underline">查看</button>
        </div>
      {/if}
    {/if}

  </div>
</div>
