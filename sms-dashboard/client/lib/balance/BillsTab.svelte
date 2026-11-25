<script lang="ts">
  import type { CarrierBill } from '../../../shared/api/carrier-bills.js';
  import { formatCardNumber } from '../../../shared/card-number.js';
  import { billActionLabel, billUrgencyMeta, formatBillAmount } from './presentation.js';

  interface Props {
    bills: CarrierBill[];
    billsLoading: boolean;
    billsLoaded: boolean;
    billError: string | null;
    billDetailLoading: boolean;
    onRefresh: () => void;
    onOpenBill: (bill: CarrierBill) => void;
  }

  let {
    bills,
    billsLoading,
    billsLoaded,
    billError,
    billDetailLoading,
    onRefresh,
    onOpenBill,
  }: Props = $props();
</script>

<div class="px-4 py-3 lg:px-5 border-b border-stone-100 flex items-center gap-3 lg:flex-none">
  <div>
    <p class="text-sm font-semibold text-stone-800">按接收卡归集的付款队列</p>
    <p class="text-[11px] text-stone-400">当前 SIM 收到运营商账单短信后自动生成，无需配置账户号</p>
  </div>
  <button
    type="button"
    onclick={onRefresh}
    disabled={billsLoading}
    class="ml-auto px-3 py-1.5 text-xs font-medium text-stone-600 bg-stone-100 hover:bg-stone-200 rounded-lg disabled:opacity-50"
  >
    {billsLoading ? '刷新中…' : '刷新'}
  </button>
</div>
{#if billsLoading && !billsLoaded}
  <div class="py-16 text-center text-sm text-stone-400">正在加载后付费账单…</div>
{:else if billError}
  <div class="py-16 text-center">
    <p class="text-sm text-red-600">{billError}</p>
    <button type="button" onclick={onRefresh} class="mt-2 text-xs text-action-text hover:underline"
      >重试</button
    >
  </div>
{:else if bills.length === 0}
  <div class="py-16 px-6 text-center">
    <p class="text-sm font-medium text-stone-600">目前没有后付费账单</p>
    <p class="mt-1 text-xs text-stone-400">当前 SIM 收到运营商账单短信后，系统会自动生成待办。</p>
  </div>
{:else}
  <div class="hidden lg:block lg:flex-1 lg:min-h-0 lg:overflow-auto" data-desktop-bill-scroll>
    <table class="w-full text-sm">
      <thead class="sticky top-0 z-10 bg-stone-50">
        <tr
          class="border-b border-stone-200 text-[11px] font-semibold text-stone-400 tracking-widest uppercase"
        >
          <th class="px-4 py-2.5 text-left">接收卡</th>
          <th class="px-4 py-2.5 text-left">运营商</th>
          <th class="px-4 py-2.5 text-left">金额</th>
          <th class="px-4 py-2.5 text-left">到期日</th>
          <th class="px-4 py-2.5 text-left">处理状态</th>
          <th class="px-4 py-2.5 text-right">操作</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-stone-50">
        {#each bills as bill (bill.id)}
          {@const urgency = billUrgencyMeta(bill)}
          <tr class="hover:bg-stone-50">
            <td class="px-4 py-3">
              <strong class="block font-mono text-stone-800"
                >{formatCardNumber(bill.notification_sim.sim_index)}</strong
              >
              <span class="text-[11px] text-stone-400">账单短信接收卡</span>
            </td>
            <td class="px-4 py-3 text-stone-600">{bill.carrier}</td>
            <td class="px-4 py-3 font-semibold tabular-nums text-stone-900"
              >{formatBillAmount(bill)}</td
            >
            <td class="px-4 py-3">
              <span class="block font-mono text-xs text-stone-600">{bill.due_date}</span>
              <span
                class="mt-0.5 inline-flex px-2 py-0.5 rounded-md border text-[10px] font-medium {urgency.className}"
                >{urgency.label}</span
              >
            </td>
            <td class="px-4 py-3 text-xs text-stone-600">{billActionLabel(bill.action_status)}</td>
            <td class="px-4 py-3 text-right">
              <button
                type="button"
                aria-label="查看账单"
                onclick={() => {
                  onOpenBill(bill);
                }}
                disabled={billDetailLoading}
                class="text-xs font-medium text-action-text hover:underline disabled:text-stone-300"
                >查看</button
              >
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <div class="lg:hidden divide-y divide-stone-100" data-mobile-bill-list>
    {#each bills as bill (bill.id)}
      {@const urgency = billUrgencyMeta(bill)}
      <button
        type="button"
        aria-label="查看账单"
        onclick={() => {
          onOpenBill(bill);
        }}
        class="w-full px-4 py-3 text-left active:bg-stone-50"
      >
        <span class="flex items-start gap-3">
          <span class="min-w-0 flex-1">
            <strong class="block font-mono text-sm text-stone-900"
              >{formatCardNumber(bill.notification_sim.sim_index)}</strong
            >
            <span class="mt-0.5 block text-xs text-stone-400 truncate"
              >{bill.carrier} · 账单短信接收卡</span
            >
          </span>
          <strong class="text-sm tabular-nums text-stone-900">{formatBillAmount(bill)}</strong>
        </span>
        <span class="mt-2 flex items-center gap-2">
          <span class="font-mono text-xs text-stone-500">{bill.due_date}</span>
          <span
            class="inline-flex px-2 py-0.5 rounded-md border text-[10px] font-medium {urgency.className}"
            >{urgency.label}</span
          >
          <span class="ml-auto text-[10px] text-stone-400">自动识别</span>
        </span>
      </button>
    {/each}
  </div>
{/if}
