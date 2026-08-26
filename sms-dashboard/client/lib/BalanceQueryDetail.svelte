<script>
  import { onMount } from 'svelte';
  import { formatCardNumber } from './card-number.js';
  import {
    formatBalanceMetric,
    getBalanceMetricLabel,
    getBalanceConversation,
    getBalanceStatusMeta,
    getBalanceTimestamp,
    getCashBalance,
    normalizeUtcTimestamp,
  } from './balance-query.js';

  let { check, onClose = null } = $props();
  let statusMeta = $derived(getBalanceStatusMeta(check?.display_status || check?.status));
  let cashBalance = $derived(getCashBalance(check));
  let conversation = $derived(getBalanceConversation(check));

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(normalizeUtcTimestamp(value));
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
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
    return () => window.removeEventListener('keydown', closeOnEscape);
  });
</script>

{#if check}
  <div class="fixed inset-x-0 top-0 bottom-[var(--mobile-tab-bar-height)] lg:inset-0 z-50 lg:flex lg:justify-end">
    <button
      type="button"
      onclick={() => onClose?.()}
      class="hidden lg:block absolute inset-0 bg-stone-900/30"
      aria-label="关闭余额查询详情"
    ></button>

    <section
      aria-label="余额查询详情"
      class="relative w-full h-full lg:w-[480px] bg-white lg:border-l lg:border-stone-200
        flex flex-col"
      style="box-shadow: -16px 0 40px rgba(28,25,23,.16);"
    >
      <header class="h-[64px] px-4 lg:px-5 border-b border-stone-200 flex items-center gap-3 shrink-0">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 min-w-0">
            <h2 class="text-base font-semibold text-stone-900">余额查询</h2>
            <span class="inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-medium {statusMeta.className}">
              {statusMeta.label}
            </span>
          </div>
          <p class="mt-0.5 text-xs text-stone-400 font-mono truncate">
            {formatCardNumber(check.sim_index)} · {check.sim_number || check.sim_iccid}
          </p>
        </div>
        <button
          type="button"
          onclick={() => onClose?.()}
          class="w-9 h-9 flex items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          aria-label="关闭"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </header>

      <div class="flex-1 min-h-0 overflow-y-auto">
        <div class="grid grid-cols-2 border-b border-stone-100 bg-stone-50/70">
          <div class="px-4 py-3 border-r border-stone-100">
            <p class="text-[11px] text-stone-400">余额</p>
            <p class="mt-1 text-lg font-semibold text-stone-900 tabular-nums">
              {formatBalanceMetric(cashBalance)}
            </p>
          </div>
          <div class="px-4 py-3">
            <p class="text-[11px] text-stone-400">最近更新</p>
            <p class="mt-1 text-sm font-medium text-stone-700 tabular-nums">
              {formatDate(getBalanceTimestamp(check))}
            </p>
          </div>
        </div>

        <section class="px-4 lg:px-5 py-5 border-b border-stone-100">
          <h3 class="text-xs font-semibold text-stone-500">{check.method === 'browser' ? '查询记录' : '短信记录'}</h3>
          {#if check.method === 'browser' && conversation.length === 0}
            <p class="mt-3 text-sm text-stone-500">
              {check.web_human_reason || statusMeta.label}
            </p>
          {/if}
          <div class="mt-4 relative pl-5 space-y-5 before:absolute before:left-[5px] before:top-2 before:bottom-2 before:w-px before:bg-stone-200">
            {#each conversation as message (message.id)}
              <div class="relative">
                <span class="absolute -left-5 top-1.5 w-[11px] h-[11px] rounded-full {message.type === 'sent' ? 'bg-orange-500' : 'bg-sky-500'} ring-4 ring-white"></span>
                <div class="flex items-baseline justify-between gap-3">
                  <p class="text-xs font-semibold text-stone-700">
                    {message.type === 'sent'
                      ? `发送至 ${message.recipient || check.destination || '—'}`
                      : `${message.phone_number || check.response_sender || '运营商'} 回复`}
                  </p>
                  <time class="text-[11px] text-stone-400 font-mono shrink-0">{formatDate(message.timestamp)}</time>
                </div>
                <p class="mt-1.5 text-sm leading-relaxed text-stone-700 whitespace-pre-wrap break-words">{message.content || '—'}</p>
              </div>
            {/each}

            {#if check.error}
              <div class="relative">
                <span class="absolute -left-5 top-1.5 w-[11px] h-[11px] rounded-full bg-red-500 ring-4 ring-white"></span>
                <p class="text-xs font-semibold text-red-700">发送失败</p>
                <p class="mt-1.5 text-sm text-red-700 break-words">{check.error}</p>
              </div>
            {/if}
          </div>
        </section>

        {#if check.metrics?.length}
          <section class="px-4 lg:px-5 py-5 border-b border-stone-100">
            <h3 class="text-xs font-semibold text-stone-500">解析结果</h3>
            <dl class="mt-3 divide-y divide-stone-100">
              {#each check.metrics as metric}
                <div class="py-2.5 flex items-center justify-between gap-4">
                  <dt class="text-sm text-stone-500">{getBalanceMetricLabel(metric.metric_type)}</dt>
                  <dd class="text-sm font-semibold text-stone-800 tabular-nums">{formatBalanceMetric(metric)}</dd>
                </div>
              {/each}
            </dl>
          </section>
        {/if}

        <section class="px-4 lg:px-5 py-5">
          <h3 class="text-xs font-semibold text-stone-500">审计信息</h3>
          <dl class="mt-3 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
            <dt class="text-stone-400">查询编号</dt>
            <dd class="font-mono text-stone-600 break-all">{check.id}</dd>
            <dt class="text-stone-400">运营商</dt>
            <dd class="text-stone-600">{check.profile_carrier || check.sim_carrier || '—'}</dd>
            <dt class="text-stone-400">查询方式</dt>
            <dd class="text-stone-600 uppercase">{check.method || '—'}</dd>
            <dt class="text-stone-400">解析版本</dt>
            <dd class="font-mono text-stone-600 break-all">{check.parser_version || '—'}</dd>
            <dt class="text-stone-400">发起时间</dt>
            <dd class="text-stone-600 tabular-nums">{formatDate(check.requested_at)}</dd>
          </dl>
        </section>
      </div>
    </section>
  </div>
{/if}
