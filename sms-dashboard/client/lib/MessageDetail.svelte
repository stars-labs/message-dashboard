<script>
  // Full SMS body, unabridged.
  //
  // The list rows clamp the body to two lines (a design requirement — see
  // docs/design_handoff_sms_dashboard/README.md), but a third of real messages
  // exceed 70 characters and the longest in production is 776, so the clamped row
  // alone left no way to read a long SMS at all. This drawer is that way.
  //
  // Layout mirrors BalanceQueryDetail.svelte deliberately: same fixed positioning,
  // same 480px desktop panel, same full-screen-above-the-tab-bar treatment on
  // mobile. Two detail surfaces opening from the same list should not feel like
  // two different apps.
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import MessageHighlight from './MessageHighlight.svelte';
  import { formatCardNumber } from './card-number.js';
  import { getCountryFlag } from './countries.js';
  import { getOutboundStatusMeta } from './message-status.js';
  import { copyCode } from './clipboard.js';

  let {
    message,
    selectedPhone = null,
    keywords = [],
    /** Filter rules, so a hidden message can name the rule that hid it. */
    filterRules = [],
    onClose = null,
  } = $props();

  let isSent = $derived(message?.type === 'sent');
  let isFiltered = $derived(message?.filter_status === 'filtered');
  let hasCode = $derived(!!message?.verification_code);

  let counterpartyNumber = $derived(isSent
    ? message?.recipient || message?.phone_number || '—'
    : message?.phone_number || '—');

  let sendStatus = $derived(isSent
    ? getOutboundStatusMeta(message?.status, message?.error_message)
    : null);

  let cardIndex = $derived(message?.phone_sim_index ?? selectedPhone?.sim_index);
  let cardNumber = $derived(
    message?.display_phone_number || selectedPhone?.number || message?.phone_iccid?.slice(-8) || '—'
  );
  let cardFlag = $derived(message?.phone_country
    ? getCountryFlag(message.phone_country)
    : selectedPhone?.flag || '');

  // Which rule hid this message, by name where one is available.
  let ruleLabel = $derived.by(() => {
    if (!isFiltered) return null;
    const rule = (filterRules || []).find((r) => r.id === message?.filter_rule_id);
    return rule ? rule.note || rule.pattern : null;
  });

  // Copy feedback, shared by the code chip and the copy-whole-body button.
  // Mirrors SimpleMessageView's 2-second pattern so the interaction feels identical.
  let copied = $state(null);
  let copyTimer = null;

  async function copyText(text, kind) {
    if (!text) return;
    const ok = await copyCode(text);
    if (!ok) return;
    if (copyTimer) clearTimeout(copyTimer);
    copied = kind;
    copyTimer = setTimeout(() => { copied = null; }, 2000);
  }

  function formatFullTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  onMount(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      if (copyTimer) clearTimeout(copyTimer);
    };
  });
</script>

{#if message}
  <div class="fixed inset-x-0 top-0 bottom-[var(--mobile-tab-bar-height)] lg:inset-0 z-50 lg:flex lg:justify-end">
    <button
      type="button"
      onclick={() => onClose?.()}
      class="hidden lg:block absolute inset-0 bg-stone-900/30"
      aria-label="关闭短信详情"
    ></button>

    <section
      aria-label="短信详情"
      class="relative w-full h-full lg:w-[480px] bg-white lg:border-l lg:border-stone-200
        flex flex-col"
      style="box-shadow: -16px 0 40px rgba(28,25,23,.16);"
    >
      <!-- Copy confirmation. Outside the scroll area so it is always visible. -->
      <div class="absolute top-[70px] left-1/2 -translate-x-1/2 z-10 pointer-events-none" aria-live="polite">
        {#if copied}
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
            <span class="text-xs font-medium">{copied === 'body' ? '已复制全文' : '已复制'}</span>
          </div>
        {/if}
      </div>

      <header class="h-[64px] px-4 lg:px-5 border-b border-stone-200 flex items-center gap-3 shrink-0">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 min-w-0">
            <h2 class="text-base font-semibold text-stone-900 shrink-0">短信详情</h2>
            {#if isSent}
              <span class="inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-medium shrink-0 {sendStatus.className}">
                {sendStatus.label}
              </span>
            {:else}
              <span class="inline-flex items-center px-2 py-0.5 rounded-md border border-sky-200 bg-sky-50 text-sky-700 text-xs font-medium shrink-0">
                接收
              </span>
            {/if}
          </div>
          <p class="mt-0.5 text-xs text-stone-400 font-mono truncate">
            {isSent ? '发送至' : '来自'} {counterpartyNumber}
          </p>
        </div>
        <button
          type="button"
          onclick={() => onClose?.()}
          class="w-9 h-9 flex items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-700 shrink-0"
          aria-label="关闭"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </header>

      <div class="flex-1 min-h-0 overflow-y-auto">
        <!-- 本机卡 + 时间 -->
        <div class="grid grid-cols-2 border-b border-stone-100 bg-stone-50/70">
          <div class="px-4 py-3 border-r border-stone-100 min-w-0">
            <p class="text-[11px] text-stone-400">本机卡</p>
            <p class="mt-1 text-sm font-medium text-stone-800 font-mono truncate">
              {#if cardIndex != null}{formatCardNumber(cardIndex)} · {/if}{cardFlag} {cardNumber}
            </p>
          </div>
          <div class="px-4 py-3 min-w-0">
            <p class="text-[11px] text-stone-400">时间</p>
            <p class="mt-1 text-sm font-medium text-stone-700 tabular-nums">
              {formatFullTime(message.timestamp)}
            </p>
          </div>
        </div>

        <!-- 验证码 -->
        {#if hasCode}
          <section class="px-4 lg:px-5 py-5 border-b border-stone-100">
            <h3 class="text-xs font-semibold text-stone-500">验证码</h3>
            <button
              type="button"
              onclick={() => copyText(message.verification_code, 'code')}
              class="mt-3 inline-flex items-center px-3 py-1.5 rounded-lg border font-mono
                text-2xl font-semibold tracking-widest tabular-nums transition-colors duration-200
                {copied === 'code'
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                  : 'bg-[#fff7ed] border-[#fed7aa] text-stone-900 hover:border-orange-300 hover:bg-orange-50'}"
              title="点击复制"
            >
              {message.verification_code}
            </button>
          </section>
        {/if}

        <!-- 正文：完整，不截断。长短信靠父级滚动。 -->
        <section class="px-4 lg:px-5 py-5 border-b border-stone-100">
          <div class="flex items-center justify-between gap-3">
            <h3 class="text-xs font-semibold text-stone-500">短信内容</h3>
            <button
              type="button"
              onclick={() => copyText(message.content, 'body')}
              class="text-xs font-medium text-action-text hover:underline shrink-0"
            >复制全文</button>
          </div>

          {#if isFiltered}
            <p class="mt-3">
              <span class="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-500 font-medium">
                已过滤{ruleLabel ? `: ${ruleLabel}` : ''}
              </span>
            </p>
          {/if}

          <p class="mt-3 text-sm leading-relaxed text-stone-700 whitespace-pre-wrap break-words">
            <MessageHighlight content={message.content || ''} {keywords} />
          </p>

          <p class="mt-3 text-[11px] text-stone-400 tabular-nums">
            {(message.content || '').length} 字符
          </p>
        </section>

        <!-- 发送失败原因 -->
        {#if isSent && message.error_message}
          <section class="px-4 lg:px-5 py-5 border-b border-stone-100">
            <h3 class="text-xs font-semibold text-stone-500">失败原因</h3>
            <p class="mt-2 text-sm text-red-700 break-words">{message.error_message}</p>
          </section>
        {/if}

        <!-- 审计信息 -->
        <section class="px-4 lg:px-5 py-5">
          <h3 class="text-xs font-semibold text-stone-500">审计信息</h3>
          <dl class="mt-3 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
            <dt class="text-stone-400">消息编号</dt>
            <dd class="font-mono text-stone-600 break-all">{message.id}</dd>
            <dt class="text-stone-400">ICCID</dt>
            <dd class="font-mono text-stone-600 break-all">{message.phone_iccid || '—'}</dd>
            <dt class="text-stone-400">运营商</dt>
            <dd class="text-stone-600">{message.phone_carrier || '—'}</dd>
          </dl>
        </section>
      </div>
    </section>
  </div>
{/if}
