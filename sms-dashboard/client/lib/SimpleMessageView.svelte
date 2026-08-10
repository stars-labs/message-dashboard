<script>
  import { onMount } from "svelte";
  import MessageHighlight from "./MessageHighlight.svelte";
  import { tagActions, keywords as keywordsStore } from "./tag-store.js";
  import { copyCode } from "./clipboard.js";
  import { formatCardNumber, cardLabel } from "./card-number.js";

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
  let copyTimer = null;

  async function handleCopy(message) {
    const ok = await copyCode(message.verification_code);
    if (!ok) return;
    if (copyTimer) clearTimeout(copyTimer);
    copiedId = message.id;
    copyTimer = setTimeout(() => { copiedId = null; }, 2000);
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

<div class="bg-white border border-stone-200 rounded-xl shadow-raised flex flex-col h-full min-h-0">

  <!-- ── Header ───────────────────────────────────────────────────────────── -->
  <div class="px-4 py-3 border-b border-stone-100 flex-shrink-0">
    <div class="flex items-center justify-between gap-3">

      <!-- Left: title + card indicator -->
      <div class="flex items-center gap-2 min-w-0">
        {#if selectedPhone}
          <span class="font-mono font-bold text-sm text-stone-900 tabular-nums shrink-0">
            {cardLabel(selectedPhone.sim_index)}
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

        <!-- Vertical divider -->
        <div class="w-px h-4 bg-stone-200 mx-0.5"></div>

        <!-- Spam toggle — disabled (shows 0) in code mode since verified messages are never hidden -->
        <button
          onclick={contentFilter === 'all' ? onToggleFiltered : null}
          disabled={contentFilter === 'code'}
          class="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border transition-colors
            {contentFilter === 'code'
              ? 'border-stone-100 bg-stone-50 text-stone-300 cursor-default'
              : showFiltered
                ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                : 'border-stone-200 bg-stone-50 text-stone-500 hover:bg-stone-100'}"
          title={contentFilter === 'code' ? '验证码视图下垃圾短信已全部屏蔽' : showFiltered ? '点击隐藏垃圾短信' : '点击查看被规则隐藏的短信'}
        >
          <!-- Eye-slash icon -->
          <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            {#if showFiltered || contentFilter === 'code'}
              <path stroke-linecap="round" stroke-linejoin="round"
                d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
            {:else}
              <path stroke-linecap="round" stroke-linejoin="round"
                d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            {/if}
          </svg>
          <span class="font-mono font-semibold tabular-nums">
            {contentFilter === 'code' ? 0 : filteredCount}
          </span>
        </button>
      </div>
    </div>
  </div>

  <!-- ── Column headers (desktop only) ────────────────────────────────────── -->
  <div class="hidden lg:grid px-3 py-1.5 border-b border-stone-50 flex-shrink-0"
    style="grid-template-columns: 3px 150px 118px 1fr {selectedPhone ? '84px' : '196px'}; gap: 0 16px;">
    <div></div><!-- accent rail -->
    <div class="text-[11px] font-semibold text-stone-400 tracking-widest uppercase">发送方</div>
    <div class="text-[11px] font-semibold text-stone-400 tracking-widest uppercase">验证码</div>
    <div class="text-[11px] font-semibold text-stone-400 tracking-widest uppercase">短信内容</div>
    <div class="text-[11px] font-semibold text-stone-400 tracking-widest uppercase text-right">
      {selectedPhone ? '时间' : '接收卡'}
    </div>
  </div>

  <!-- ── Message list ──────────────────────────────────────────────────────── -->
  <div class="flex-1 min-h-0 overflow-y-auto">

    {#if isLoading}
      <!-- Loading skeleton: 4 rows with the same column layout -->
      {#each Array(4) as _, i}
        <div class="px-3 py-3 border-b border-stone-50 animate-pulse
          hidden lg:grid items-center"
          style="grid-template-columns: 3px 150px 118px 1fr 196px; gap: 0 16px;">
          <div class="h-8 w-0.5 bg-stone-100 rounded"></div>
          <div class="h-3 bg-stone-100 rounded w-24"></div>
          <div class="h-7 bg-stone-100 rounded w-20"></div>
          <div class="space-y-1.5">
            <div class="h-3 bg-stone-100 rounded w-full"></div>
            <div class="h-3 bg-stone-100 rounded w-2/3"></div>
          </div>
          <div class="space-y-1 text-right">
            <div class="h-3 bg-stone-100 rounded w-24 ml-auto"></div>
            <div class="h-2.5 bg-stone-100 rounded w-16 ml-auto"></div>
          </div>
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

        <!-- ── Desktop row ──────────────────────────────────────────────── -->
        <div
          class="hidden lg:grid items-center px-3 py-2.5 border-b transition-colors duration-500
            {isFiltered
              ? 'border-stone-100 opacity-60'
              : isNew
                ? 'bg-[#fffbf5] border-stone-100'
                : idx % 2 === 0 ? 'bg-white border-stone-50' : 'bg-[#fafaf9] border-stone-50'}"
          style="grid-template-columns: 3px 150px 118px 1fr {selectedPhone ? '84px' : '196px'}; gap: 0 16px;"
        >
          <!-- Accent rail: orange for newest, transparent otherwise -->
          <div class="self-stretch rounded-sm {isNew ? 'bg-orange-400' : 'bg-transparent'}"></div>

          <!-- 发送方 -->
          <div class="font-mono text-sm font-semibold text-stone-800 truncate"
            title={message.phone_number}>
            {message.phone_number || '—'}
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

          <!-- 接收卡 / 时间 -->
          <div class="text-right">
            {#if selectedPhone}
              <!-- Single-card view: just show the time -->
              <span class="font-mono text-xs text-stone-400">{formatTime(message.timestamp)}</span>
            {:else}
              <!-- All-cards view: flag + number, then card + time -->
              <div class="font-mono text-xs text-stone-700">
                {message.display_phone_number
                  ? message.display_phone_number
                  : message.phone_iccid?.slice(-8) || '—'}
              </div>
              <div class="font-mono text-[11px] text-stone-400 mt-0.5">
                {#if message.phone_sim_index != null}
                  {cardLabel(message.phone_sim_index)} ·
                {/if}
                {formatTime(message.timestamp)}
              </div>
            {/if}
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

          <!-- Body -->
          <p class="text-sm text-stone-600 leading-snug line-clamp-2 mt-1.5">
            {message.content}
          </p>

          <!-- Footer: card label + receiving number -->
          <div class="mt-1.5 font-mono text-[11px] text-stone-400">
            {#if message.phone_sim_index != null}
              <span class="font-semibold text-stone-500">{cardLabel(message.phone_sim_index)}</span>
              ·
            {/if}
            {#if message.display_phone_number}
              {message.display_phone_number}
            {/if}
            {#if isFiltered}
              <span class="ml-1 px-1 py-0.5 rounded bg-stone-100 text-stone-400 text-[10px]">
                已过滤
              </span>
            {/if}
          </div>
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
