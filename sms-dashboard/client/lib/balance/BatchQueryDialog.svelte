<script lang="ts">
  import type { BalanceQueryPreviewResponse } from '../../../shared/api/balance-checks.js';
  import { overlay } from '../overlay.js';
  import type { BatchMethod } from './types.js';

  interface Props {
    preview: BalanceQueryPreviewResponse;
    scopeLabel: string | undefined;
    methods: Record<BatchMethod, boolean>;
    selectedCount: number;
    submitting: boolean;
    onClose: () => void;
    onDismiss: () => void;
    onSubmit: () => void;
  }

  let {
    preview,
    scopeLabel,
    methods = $bindable(),
    selectedCount,
    submitting,
    onClose,
    onDismiss,
    onSubmit,
  }: Props = $props();
</script>

<div
  class="fixed inset-0 z-50 bg-stone-900/35 flex items-end sm:items-center justify-center sm:p-4"
>
  <div
    class="w-full sm:max-w-[520px] bg-white border border-stone-200 rounded-t-xl sm:rounded-xl shadow-modal overflow-hidden"
    role="dialog"
    aria-modal="true"
    aria-label="批量余额查询预览"
    use:overlay={{ onClose: onDismiss }}
  >
    <header class="px-4 py-4 border-b border-stone-100 flex items-center justify-between">
      <div>
        <h3 class="font-semibold text-stone-900">批量查询确认</h3>
        <p class="mt-0.5 text-xs text-stone-400">只查询已验证且满足 24 小时间隔的在线卡</p>
      </div>
      <button
        type="button"
        onclick={onClose}
        aria-label="关闭"
        class="w-8 h-8 text-stone-400 hover:bg-stone-100 rounded-lg">&times;</button
      >
    </header>
    <div class="px-4 py-2.5 border-b border-stone-100 bg-stone-50 text-xs text-stone-600">
      查询范围：<strong class="font-medium text-stone-800">{scopeLabel}</strong>
    </div>
    <div class="grid grid-cols-3 border-b border-stone-100">
      <div class="px-4 py-4 border-r border-stone-100">
        <p class="text-xs text-stone-400">将查询</p>
        <strong class="block mt-1 text-2xl tabular-nums">{preview.summary.eligible}</strong>
      </div>
      <div class="px-4 py-4 border-r border-stone-100">
        <p class="text-xs text-stone-400">24h 内已查</p>
        <strong class="block mt-1 text-2xl tabular-nums">{preview.summary.cooldown}</strong>
      </div>
      <div class="px-4 py-4">
        <p class="text-xs text-stone-400">离线</p>
        <strong class="block mt-1 text-2xl tabular-nums">{preview.summary.offline}</strong>
      </div>
    </div>
    {#if preview.method_summary}
      <div class="divide-y divide-stone-100 border-b border-stone-100">
        <label class="px-4 py-3 flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            bind:checked={methods.direct_sms}
            disabled={!preview.method_summary.direct_sms}
            class="rounded border-stone-300 text-orange-500 focus:ring-orange-400"
          />
          <span class="flex-1 text-stone-600">直接短信</span>
          <strong class="font-mono tabular-nums text-stone-800"
            >{preview.method_summary.direct_sms}</strong
          >
        </label>
        <label class="px-4 py-3 flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            bind:checked={methods.sms_ai}
            disabled={!preview.method_summary.sms_ai ||
              !preview.runner_capabilities.sms_ai.available}
            class="rounded border-stone-300 text-orange-500 focus:ring-orange-400"
          />
          <span class="flex-1 text-stone-600">
            AI 短信
            {#if preview.method_summary.sms_ai && !preview.runner_capabilities.sms_ai.available}
              <small class="ml-1 text-amber-600">助手未就绪</small>
            {/if}
          </span>
          <strong class="font-mono tabular-nums text-stone-800"
            >{preview.method_summary.sms_ai}</strong
          >
        </label>
        <label class="px-4 py-3 flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            bind:checked={methods.browser}
            disabled={!preview.method_summary.browser ||
              !preview.runner_capabilities.carrier_browser.available}
            class="rounded border-stone-300 text-orange-500 focus:ring-orange-400"
          />
          <span class="flex-1 text-stone-600">
            浏览器登录（逐张处理）
            {#if preview.method_summary.browser && !preview.runner_capabilities.carrier_browser.available}
              <small class="ml-1 text-amber-600">助手未就绪</small>
            {/if}
          </span>
          <strong class="font-mono tabular-nums text-stone-800"
            >{preview.method_summary.browser}</strong
          >
        </label>
        {#if methods.browser}
          <div class="px-4 py-2.5 text-xs bg-orange-50 text-orange-700 space-y-1">
            <p>浏览器任务串行执行，每张卡都可能需要人工验证，并按运营商 profile 的限流间隔处理。</p>
            {#if preview.method_summary.browser > 5}
              <p class="font-medium text-red-600">
                ⚠️ 当前选中 {preview.method_summary.browser} 张浏览器查询卡，运营商登录接口可能限流，建议分批处理。
              </p>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    <dl class="px-4 py-4 grid grid-cols-[1fr_auto] gap-y-2 text-sm">
      <dt class="text-stone-500">未支持运营商</dt>
      <dd class="font-mono tabular-nums text-stone-700">{preview.summary.unsupported}</dd>
      <dt class="text-stone-500">尚未完成单卡验证</dt>
      <dd class="font-mono tabular-nums text-stone-700">{preview.summary.unverified}</dd>
      {#if preview.summary.secondary}
        <dt class="text-stone-500">副卡（余额随主卡）</dt>
        <dd class="font-mono tabular-nums text-stone-700">{preview.summary.secondary}</dd>
      {/if}
      <dt class="text-stone-500">范围内卡数</dt>
      <dd class="font-mono tabular-nums text-stone-700">{preview.summary.total}</dd>
    </dl>
    <footer class="px-4 py-4 border-t border-stone-100 flex gap-2 justify-end">
      <button
        type="button"
        onclick={onClose}
        class="px-4 py-2 text-sm text-stone-600 hover:bg-stone-100 rounded-lg">取消</button
      >
      <button
        type="button"
        onclick={onSubmit}
        disabled={!selectedCount || submitting}
        class="px-4 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg disabled:bg-stone-300"
      >
        {submitting ? '正在加入队列…' : `确认查询 ${selectedCount} 张卡`}
      </button>
    </footer>
  </div>
</div>
