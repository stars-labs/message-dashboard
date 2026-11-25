<script lang="ts">
  import type { BalanceQueryPreflightResponse } from '../../../shared/api/balance-checks.js';
  import { formatCardNumber } from '../../../shared/card-number.js';
  import { overlay } from '../overlay.js';
  import { capabilityLabels } from './presentation.js';
  import type { BalanceRow } from './types.js';

  interface Props {
    row: BalanceRow;
    preflight: BalanceQueryPreflightResponse;
    querying: boolean;
    onClose: () => void;
    onSubmit: () => void;
  }

  let { row, preflight, querying, onClose, onSubmit }: Props = $props();
  let runnerUnavailable = $derived(preflight.runner.required && !preflight.runner.available);
</script>

<div
  class="fixed inset-0 z-50 bg-stone-900/35 flex items-end sm:items-center justify-center sm:p-4"
>
  <div
    class="w-full sm:max-w-[460px] bg-white border border-stone-200 rounded-t-xl sm:rounded-xl shadow-modal overflow-hidden"
    role="dialog"
    aria-modal="true"
    aria-label="单卡余额查询确认"
    use:overlay={{ onClose }}
  >
    <header class="px-5 py-4 border-b border-stone-100 flex items-start justify-between gap-4">
      <div>
        <h3 class="font-semibold text-stone-900">
          {runnerUnavailable ? '查询助手未就绪' : '浏览器查询确认'}
        </h3>
        <p class="mt-1 text-xs text-stone-400">
          {formatCardNumber(row.phone.sim_index)}
          <span class="mx-1">·</span>{row.phone.number}
        </p>
      </div>
      <button
        type="button"
        onclick={onClose}
        aria-label="关闭"
        class="w-8 h-8 text-stone-400 hover:bg-stone-100 rounded-lg">&times;</button
      >
    </header>
    <div class="px-5 py-5 text-sm text-stone-600 leading-6">
      {#if runnerUnavailable}
        <p>
          此查询需要 {preflight.method.capability === null
            ? '查询助手'
            : capabilityLabels[preflight.method.capability]}，当前没有可用实例。
        </p>
        <p class="mt-2 text-xs text-stone-400">
          在电脑上启动并登录查询助手（Balance Agent）后再查询，可立即处理任务。
        </p>
      {:else}
        <p>联通官方网站将在运行查询助手的电脑上打开，并逐张处理。</p>
        <p class="mt-2 text-xs text-stone-400">登录过程中可能需要完成滑块或图片验证。</p>
      {/if}
    </div>
    <footer class="px-5 py-4 border-t border-stone-100 flex items-center justify-end gap-2">
      <button
        type="button"
        onclick={onClose}
        class="px-4 py-2 text-sm text-stone-600 hover:bg-stone-100 rounded-lg">取消</button
      >
      {#if runnerUnavailable}
        <button
          type="button"
          onclick={onSubmit}
          disabled={querying}
          class="px-4 py-2 text-sm text-stone-500 hover:bg-stone-100 rounded-lg disabled:opacity-50"
        >
          {querying ? '排队中…' : '仍然排队'}
        </button>
        <a
          href="message-dashboard-runner://open"
          class="px-4 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg"
        >
          打开查询助手
        </a>
      {:else}
        <button
          type="button"
          onclick={onSubmit}
          disabled={querying}
          class="px-4 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg disabled:opacity-50"
        >
          {querying ? '排队中…' : '开始查询'}
        </button>
      {/if}
    </footer>
  </div>
</div>
