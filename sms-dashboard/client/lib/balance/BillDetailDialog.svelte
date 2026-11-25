<script lang="ts">
  import { textOr } from '../../../shared/text.js';
  import { formatCardNumber } from '../../../shared/card-number.js';
  import { overlay } from '../overlay.js';
  import {
    billActionLabel,
    billEventLabel,
    billUrgencyMeta,
    formatBillAmount,
    formatTime,
  } from './presentation.js';
  import type { BillAction, BillDetail } from './types.js';

  interface Props {
    bill: BillDetail;
    canWriteBills: boolean;
    actionBusy: boolean;
    onClose: () => void;
    onAction: (action: BillAction, label: string) => void;
  }

  let { bill, canWriteBills, actionBusy, onClose, onAction }: Props = $props();
  let urgency = $derived(billUrgencyMeta(bill));
</script>

<div
  class="fixed inset-0 z-50 bg-stone-900/35 flex items-end sm:items-center justify-center sm:p-4"
>
  <div
    class="w-full sm:max-w-[640px] max-h-[92vh] bg-white border border-stone-200 rounded-t-xl sm:rounded-xl shadow-modal overflow-hidden flex flex-col"
    role="dialog"
    aria-modal="true"
    aria-label="后付费账单详情"
    use:overlay={{ onClose }}
  >
    <header class="px-5 py-4 border-b border-stone-100 flex items-start justify-between gap-4">
      <div>
        <h3 class="font-mono font-semibold text-stone-900">
          {formatCardNumber(bill.notification_sim.sim_index ?? bill.linked_sims[0]?.sim_index)}
        </h3>
        <p class="mt-0.5 text-xs text-stone-400">
          {bill.carrier} · 由该卡收到的账单短信自动识别
        </p>
      </div>
      <button
        type="button"
        onclick={onClose}
        aria-label="关闭账单详情"
        class="w-8 h-8 text-stone-400 hover:bg-stone-100 rounded-lg">&times;</button
      >
    </header>
    <div class="overflow-y-auto">
      <div class="grid grid-cols-2 sm:grid-cols-4 border-b border-stone-100">
        <div class="px-4 py-3 border-r border-stone-100">
          <p class="text-[11px] text-stone-400">金额</p>
          <strong class="block mt-1 text-stone-900 tabular-nums">{formatBillAmount(bill)}</strong>
        </div>
        <div class="px-4 py-3 border-r border-stone-100">
          <p class="text-[11px] text-stone-400">到期日</p>
          <strong class="block mt-1 font-mono text-sm text-stone-800">{bill.due_date}</strong>
        </div>
        <div class="px-4 py-3 border-r border-stone-100">
          <p class="text-[11px] text-stone-400">紧急程度</p>
          <span
            class="mt-1 inline-flex px-2 py-0.5 rounded-md border text-[10px] font-medium {urgency.className}"
            >{urgency.label}</span
          >
        </div>
        <div class="px-4 py-3">
          <p class="text-[11px] text-stone-400">处理状态</p>
          <strong class="block mt-1 text-sm text-stone-800"
            >{billActionLabel(bill.action_status)}</strong
          >
        </div>
      </div>
      <section class="px-5 py-4 border-b border-stone-100" aria-label="账单短信接收卡">
        <h4 class="text-xs font-semibold text-stone-700">账单短信接收卡</h4>
        <p class="mt-2 text-sm font-mono text-stone-600">
          {formatCardNumber(bill.notification_sim.sim_index ?? bill.linked_sims[0]?.sim_index)}
        </p>
      </section>
      <section class="px-5 py-4 border-b border-stone-100" aria-label="账单短信证据">
        <h4 class="text-xs font-semibold text-stone-700">账单短信证据</h4>
        {#if bill.source_message}
          <p class="mt-2 text-[11px] text-stone-400">
            来自 {textOr(bill.source_message.sender, '运营商')}
          </p>
          <blockquote
            class="mt-2 p-3 bg-stone-50 border border-stone-100 rounded-lg text-sm leading-6 text-stone-600 whitespace-pre-wrap break-words"
          >
            {bill.source_message.content}
          </blockquote>
        {:else}
          <p class="mt-2 text-sm text-stone-400">
            原始短信已按保留策略清理，规范化账单和审计记录仍保留。
          </p>
        {/if}
      </section>
      <section class="px-5 py-4" aria-label="账单审计记录">
        <h4 class="text-xs font-semibold text-stone-700">审计记录</h4>
        <ol class="mt-2 space-y-2">
          {#each bill.events as event (event.id)}
            <li class="flex items-start gap-3 text-xs">
              <span class="mt-1.5 w-1.5 h-1.5 rounded-full bg-stone-300 shrink-0"></span>
              <span class="flex-1 text-stone-600">{billEventLabel(event.event_type)}</span>
              <span class="font-mono text-[10px] text-stone-400"
                >{formatTime(event.created_at)}</span
              >
            </li>
          {/each}
        </ol>
      </section>
    </div>
    {#if canWriteBills}
      <footer class="px-5 py-4 border-t border-stone-100 flex flex-wrap justify-end gap-2">
        {#if !['paid', 'waived'].includes(bill.action_status)}
          <button
            type="button"
            onclick={() => {
              onAction('paymentPlanned', '计划付款');
            }}
            disabled={actionBusy}
            class="px-3 py-2 text-sm text-stone-600 bg-stone-100 hover:bg-stone-200 rounded-lg disabled:opacity-50"
            >计划付款</button
          >
          <button
            type="button"
            onclick={() => {
              onAction('waive', '豁免');
            }}
            disabled={actionBusy}
            class="px-3 py-2 text-sm text-stone-600 bg-stone-100 hover:bg-stone-200 rounded-lg disabled:opacity-50"
            >标记豁免</button
          >
          <button
            type="button"
            onclick={() => {
              onAction('markPaid', '标记为已付款');
            }}
            disabled={actionBusy}
            class="px-3 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg disabled:opacity-50"
            >标记已付款</button
          >
        {:else}
          <button
            type="button"
            onclick={() => {
              onAction('reopen', '重新打开');
            }}
            disabled={actionBusy}
            class="px-3 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg disabled:opacity-50"
            >重新打开</button
          >
        {/if}
      </footer>
    {/if}
  </div>
</div>
