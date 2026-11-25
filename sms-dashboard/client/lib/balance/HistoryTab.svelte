<script lang="ts">
  import type { BalanceCheck } from '../../../shared/api/balance-checks.js';
  import { textOr } from '../../../shared/text.js';
  import {
    formatBalanceMetric,
    getBalanceStatusMeta,
    getBalanceTimestamp,
    getCashBalance,
  } from '../balance-query.js';
  import { formatCardNumber } from '../../../shared/card-number.js';
  import { carrierKey } from '../carrier.js';
  import { checkCarrier, formatTime } from './presentation.js';
  import { compareHistoryChecks } from './sort.js';
  import type { HistorySortKey, SortDirection } from './types.js';

  interface Props {
    balanceChecks: readonly BalanceCheck[];
    carrierOptions: readonly { key: string; label: string }[];
    carrierFilter: string;
    sortKey: HistorySortKey;
    sortDirection: SortDirection;
    onOpenBalance: ((check: BalanceCheck) => void) | null;
  }

  let {
    balanceChecks,
    carrierOptions,
    carrierFilter = $bindable(),
    sortKey = $bindable(),
    sortDirection = $bindable(),
    onOpenBalance,
  }: Props = $props();

  const historyColumns: readonly { key: HistorySortKey | null; label: string }[] = [
    { key: 'time', label: '时间' },
    { key: 'sim', label: '卡号' },
    { key: 'carrier', label: '运营商' },
    { key: 'method', label: '查询方式' },
    { key: 'status', label: '结果' },
    { key: 'balance', label: '当前余额' },
    { key: null, label: '操作' },
  ];

  let sortedChecks = $derived(
    balanceChecks
      .filter(
        (check) => carrierFilter === 'all' || carrierKey(checkCarrier(check)) === carrierFilter,
      )
      .slice()
      .sort((left, right) => compareHistoryChecks(left, right, sortKey, sortDirection)),
  );

  function toggleHistorySort(key: HistorySortKey) {
    if (sortKey === key) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    else {
      sortKey = key;
      sortDirection = key === 'time' ? 'desc' : 'asc';
    }
  }
</script>

<div class="px-4 py-3 lg:px-5 border-b border-stone-100 flex justify-end lg:flex-none">
  <label class="sr-only" for="balance-history-carrier-filter">运营商筛选</label>
  <select
    id="balance-history-carrier-filter"
    value={carrierFilter}
    onchange={(event) => {
      carrierFilter = event.currentTarget.value;
    }}
    aria-label="运营商筛选"
    class="w-full sm:w-[145px] px-2.5 py-2 text-sm bg-stone-50 border border-stone-200 rounded-lg
            focus:outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
  >
    <option value="all">全部运营商</option>
    {#each carrierOptions as carrier (carrier.key)}
      <option value={carrier.key}>{carrier.label}</option>
    {/each}
  </select>
</div>
{#if sortedChecks.length === 0}
  <div class="py-16 text-center text-sm text-stone-400">没有匹配的余额查询记录</div>
{:else}
  <div class="hidden lg:block lg:flex-1 lg:min-h-0 lg:overflow-auto" data-desktop-balance-scroll>
    <table class="w-full text-sm">
      <thead class="sticky top-0 z-10 bg-stone-50"
        ><tr class="bg-stone-50 border-b border-stone-200">
          {#each historyColumns as column, index (column.label)}
            <th
              class="px-4 py-2.5 text-left text-[11px] font-semibold text-stone-400 tracking-widest uppercase {index ===
              historyColumns.length - 1
                ? 'text-right'
                : ''}"
            >
              {#if column.key}
                {@const columnKey = column.key}
                <button
                  type="button"
                  onclick={() => {
                    toggleHistorySort(columnKey);
                  }}
                  class="inline-flex items-center gap-1 hover:text-stone-700 transition-colors"
                  aria-label={`按${column.label}${sortKey === column.key && sortDirection === 'asc' ? '降序' : '升序'}排列`}
                >
                  {column.label}
                  <span
                    class="text-[9px] {sortKey === column.key
                      ? 'text-orange-500'
                      : 'text-stone-300'}"
                    aria-hidden="true"
                  >
                    {sortKey === column.key ? (sortDirection === 'asc' ? '▲' : '▼') : '↕'}
                  </span>
                </button>
              {:else}{column.label}{/if}
            </th>
          {/each}
        </tr></thead
      >
      <tbody class="divide-y divide-stone-50">
        {#each sortedChecks as check (check.id)}
          {@const queryMeta = getBalanceStatusMeta(check.display_status)}
          <tr class="hover:bg-stone-50">
            <td class="px-4 py-3 font-mono text-xs text-stone-500 whitespace-nowrap"
              >{formatTime(getBalanceTimestamp(check))}</td
            >
            <td class="px-4 py-3 font-mono font-semibold text-stone-800 whitespace-nowrap"
              >{formatCardNumber(check.sim_index)}
              <span class="ml-1 text-xs font-normal text-stone-500"
                >{textOr(check.sim_number, check.sim_iccid)}</span
              ></td
            >
            <td class="px-4 py-3 text-stone-600 whitespace-nowrap"
              >{textOr(check.profile_carrier, textOr(check.sim_carrier, '—'))}</td
            >
            <td class="px-4 py-3 text-xs uppercase text-stone-500">{check.method}</td>
            <td class="px-4 py-3"
              ><span
                class="inline-flex px-2 py-0.5 rounded-md border text-[11px] font-medium {queryMeta.className}"
                >{queryMeta.label}</span
              ></td
            >
            <td class="px-4 py-3 font-semibold tabular-nums text-stone-800"
              >{formatBalanceMetric(getCashBalance(check))}</td
            >
            <td class="px-4 py-3 text-right"
              ><button
                type="button"
                onclick={() => onOpenBalance?.(check)}
                class="text-xs font-medium text-action-text hover:underline">详情</button
              ></td
            >
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <div class="lg:hidden divide-y divide-stone-100" data-mobile-balance-history>
    {#each sortedChecks as check (check.id)}
      {@const queryMeta = getBalanceStatusMeta(check.display_status)}
      <button
        type="button"
        onclick={() => onOpenBalance?.(check)}
        class="w-full px-4 py-2.5 text-left active:bg-stone-50"
      >
        <span class="flex items-center gap-2">
          <span class="font-mono font-bold text-stone-800">{formatCardNumber(check.sim_index)}</span
          >
          <span class="font-mono text-xs text-stone-500 truncate"
            >{textOr(check.sim_number, check.sim_iccid)}</span
          >
          <span
            class="ml-auto inline-flex px-2 py-0.5 rounded-md border text-[10px] font-medium {queryMeta.className}"
            >{queryMeta.label}</span
          >
        </span>
        <span class="mt-1.5 flex items-center gap-2 text-xs text-stone-500">
          <strong class="text-sm text-stone-800 tabular-nums"
            >{formatBalanceMetric(getCashBalance(check))}</strong
          >
          <span>{textOr(check.profile_carrier, textOr(check.sim_carrier, '—'))}</span>
          <span class="ml-auto font-mono text-[10px] text-stone-400"
            >{formatTime(getBalanceTimestamp(check))}</span
          >
        </span>
      </button>
    {/each}
  </div>
{/if}
