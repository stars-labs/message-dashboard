<script>
  import { formatTaskAge, getDaemonStatusMeta } from './daemon-status.js';
  import { formatTimeAgo } from './time.js';

  let {
    status,
    refreshing = false,
    onRefresh = null,
    onClose = null,
  } = $props();

  const taskRows = [
    ['modem_reader', '短信扫描'],
    ['device_sync', '设备同步'],
    ['outbound_poll', '发送轮询'],
    ['message_uploader', '消息上传'],
  ];

  let meta = $derived(getDaemonStatusMeta(status?.status));
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

  {#if !status?.tasks}
    <div class="px-4 py-3 border-b border-stone-100 bg-stone-50">
      <p class="text-xs text-stone-600">暂无有效的任务健康报告。</p>
    </div>
  {:else}
    <div class="divide-y divide-stone-100">
      {#each taskRows as [key, label]}
        {@const task = status?.tasks?.[key]}
        <div class="flex items-center justify-between gap-3 px-4 py-2.5">
          <div>
            <p class="text-xs font-medium text-stone-700">{label}</p>
            {#if task?.last_error}
              <p class="text-[10px] text-red-500 mt-0.5 truncate max-w-[230px]" title={task.last_error}>{task.last_error}</p>
            {/if}
          </div>
          <span class="text-[11px] font-mono tabular-nums {task?.consecutive_failures > 0 ? 'text-red-600' : 'text-stone-400'}">
            {formatTaskAge(task?.last_success_age_seconds)}
          </span>
        </div>
      {/each}
    </div>
  {/if}

  <footer class="grid grid-cols-3 border-t border-stone-200 bg-stone-50 rounded-b-lg">
    <div class="px-3 py-2.5 border-r border-stone-200">
      <p class="text-[10px] text-stone-400" title="可重试 / 已耗尽 / 卡住">队列</p>
      <p class="text-xs font-mono text-stone-700 mt-0.5" title="可重试 / 已耗尽 / 卡住">
        {status?.queue ? `${status.queue.retryable} / ${status.queue.attempts_exhausted} / ${status.queue.stuck_uploading}` : '—'}
      </p>
    </div>
    <div class="px-3 py-2.5 border-r border-stone-200">
      <p class="text-[10px] text-stone-400">Modem</p>
      <p class="text-xs font-mono text-stone-700 mt-0.5">{status?.modems?.responsive ?? status?.modem_count ?? '—'} / {status?.modems?.discovered ?? status?.modem_count ?? '—'}</p>
    </div>
    <div class="px-3 py-2.5 min-w-0">
      <p class="text-[10px] text-stone-400">版本</p>
      <p class="text-xs font-mono text-stone-700 mt-0.5 truncate" title={status?.version}>{status?.version || '—'}</p>
    </div>
  </footer>
</div>
