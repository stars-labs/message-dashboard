<script>
  import { formatTaskAge, getDaemonStatusMeta } from './daemon-status.js';
  import { formatTimeAgo } from './time.js';

  let {
    status,
    refreshing = false,
    onRefresh = null,
    onClose = null,
  } = $props();

  let meta = $derived(getDaemonStatusMeta(status?.status));
  let snapshot = $derived(status?.snapshot ?? null);

  function formatBacklogAge(seconds) {
    return seconds === null || seconds === undefined ? '无积压' : formatTaskAge(seconds);
  }
</script>

<div class="fixed inset-0 z-[59] bg-stone-900/10 lg:bg-transparent" onclick={onClose} role="presentation"></div>
<div
  role="dialog"
  aria-modal="true"
  aria-label="采集服务状态"
  class="fixed z-[60] bg-white border border-stone-200 shadow-[0_16px_40px_rgba(28,25,23,.18)]
    left-3 right-3 bottom-[78px] rounded-lg lg:left-auto lg:right-5 lg:top-[58px] lg:bottom-auto lg:w-[360px]"
>
  <header class="flex items-center gap-2 px-4 py-3 border-b border-stone-200">
    <span class="w-2 h-2 rounded-full {meta.dotClass}"></span>
    <div class="flex-1 min-w-0">
      <h2 class="text-sm font-semibold text-stone-900">采集服务{meta.label}</h2>
      <p class="text-[11px] text-stone-400 mt-0.5">
        心跳 {formatTimeAgo(status?.last_heartbeat)}
      </p>
    </div>
    <button
      onclick={onRefresh}
      disabled={refreshing}
      title="刷新状态"
      aria-label="刷新状态"
      class="w-8 h-8 flex items-center justify-center rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-700 disabled:opacity-50"
    >
      <svg class="w-4 h-4 {refreshing ? 'animate-spin' : ''}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M20 11a8 8 0 10-2.34 5.66M20 4v7h-7"/>
      </svg>
    </button>
    <button
      onclick={onClose}
      title="关闭"
      aria-label="关闭"
      class="w-8 h-8 flex items-center justify-center rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-700"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/>
      </svg>
    </button>
  </header>

  {#if status?.reasons?.length}
    <div class="px-4 py-2.5 border-b border-stone-100 {status.status === 'offline' || status.status === 'error' ? 'bg-red-50' : 'bg-amber-50'}">
      {#each status.reasons as reason}
        <p class="text-xs leading-relaxed {status.status === 'offline' || status.status === 'error' ? 'text-red-700' : 'text-amber-800'}">{reason}</p>
      {/each}
    </div>
  {/if}

  {#if !snapshot}
    <div class="px-4 py-3 border-b border-stone-100 bg-stone-50">
      <p class="text-xs text-stone-600">暂无有效的采集服务健康报告。</p>
    </div>
  {:else}
    <div class="divide-y divide-stone-100">
      <div class="flex items-center justify-between gap-3 px-4 py-2.5">
        <p class="text-xs font-medium text-stone-700">短信读取</p>
        <span class="text-[11px] font-mono tabular-nums text-stone-500">
          {formatTaskAge(snapshot.last_message_read_success_age_seconds)}
        </span>
      </div>
      <div class="flex items-center justify-between gap-3 px-4 py-2.5">
        <p class="text-xs font-medium text-stone-700">消息上传</p>
        <span class="text-[11px] font-mono tabular-nums text-stone-500">
          {formatTaskAge(snapshot.last_upload_success_age_seconds)}
        </span>
      </div>
      <div class="flex items-center justify-between gap-3 px-4 py-2.5">
        <p class="text-xs font-medium text-stone-700">最老积压</p>
        <span class="text-[11px] font-mono tabular-nums text-stone-500">
          {formatBacklogAge(snapshot.queue?.oldest_unacknowledged_age_seconds)}
        </span>
      </div>
    </div>
  {/if}

  <footer class="grid grid-cols-4 border-t border-stone-200 bg-stone-50 rounded-b-lg">
    <div class="px-3 py-2.5 border-r border-stone-200">
      <p class="text-[10px] text-stone-400">待处理</p>
      <p class="text-xs font-mono text-stone-700 mt-0.5">{snapshot?.queue?.pending ?? '—'}</p>
    </div>
    <div class="px-3 py-2.5 border-r border-stone-200">
      <p class="text-[10px] text-stone-400">上传中</p>
      <p class="text-xs font-mono text-stone-700 mt-0.5">{snapshot?.queue?.in_flight ?? '—'}</p>
    </div>
    <div class="px-3 py-2.5 border-r border-stone-200">
      <p class="text-[10px] text-stone-400">人工处理</p>
      <p class="text-xs font-mono text-stone-700 mt-0.5">{snapshot?.queue?.dead_letter ?? '—'}</p>
    </div>
    <div class="px-3 py-2.5 min-w-0">
      <p class="text-[10px] text-stone-400">版本</p>
      <p class="text-xs font-mono text-stone-700 mt-0.5 truncate" title={snapshot?.version}>{snapshot?.version || '—'}</p>
    </div>
  </footer>
</div>
