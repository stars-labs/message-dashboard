<script lang="ts">
  import type { FilterTab, StatusFilter } from './types.js';

  interface Props {
    searchQuery: string;
    statusFilter: StatusFilter;
    carrierFilter: string;
    filterTabs: readonly FilterTab[];
    carrierOptions: readonly { key: string; label: string }[];
    selectedCount: number;
    onClearSelection: () => void;
  }

  let {
    searchQuery = $bindable(),
    statusFilter = $bindable(),
    carrierFilter = $bindable(),
    filterTabs,
    carrierOptions,
    selectedCount,
    onClearSelection,
  }: Props = $props();
</script>

<!-- The search input wraps onto its own row on a phone; inside the horizontally scrolling chip strip it would be off-screen. -->
<div
  class="px-4 py-2.5 lg:px-5 border-b border-stone-100 flex flex-wrap items-center gap-2 lg:flex-nowrap lg:flex-none"
>
  <div class="relative w-full order-first lg:order-last lg:w-64 shrink-0">
    <svg
      class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" stroke-width="2" /><path
        d="m20 20-3.5-3.5"
        stroke-width="2"
        stroke-linecap="round"
      />
    </svg>
    <input
      bind:value={searchQuery}
      type="search"
      aria-label="搜索 SIM"
      placeholder="卡号 / 号码 / 运营商 / ICCID"
      class="w-full h-10 lg:h-auto pl-9 pr-3 lg:py-1.5 text-sm bg-stone-50 border border-stone-200 rounded-lg
              focus:outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
    />
  </div>
  <div class="flex items-center gap-2 min-w-0 flex-1 overflow-x-auto">
    {#each filterTabs as [value, label, count] (value)}
      <button
        type="button"
        onclick={() => {
          statusFilter = value;
        }}
        class="shrink-0 whitespace-nowrap px-2.5 py-1.5 text-sm rounded-lg font-medium transition-colors tabular-nums
                {statusFilter === value
          ? value === 'payment' || value === 'query_failed' || value === 'expiry'
            ? 'bg-red-600 text-white'
            : 'bg-stone-800 text-white'
          : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}">{label} {count}</button
      >
    {/each}
    <span class="w-px h-5 bg-stone-200 mx-1 shrink-0"></span>
    <label class="sr-only" for="balance-carrier-filter">运营商筛选</label>
    <select
      id="balance-carrier-filter"
      value={carrierFilter}
      onchange={(event) => {
        carrierFilter = event.currentTarget.value;
      }}
      aria-label="运营商筛选"
      class="shrink-0 w-[130px] px-2.5 py-1.5 text-sm bg-stone-50 border border-stone-200 rounded-lg
              focus:outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
    >
      <option value="all">全部运营商</option>
      {#each carrierOptions as carrier (carrier.key)}
        <option value={carrier.key}>{carrier.label}</option>
      {/each}
    </select>
  </div>
</div>

{#if selectedCount}
  <div
    class="px-4 py-2 lg:px-5 border-b border-orange-100 bg-orange-50 flex items-center gap-3 text-xs lg:flex-none"
  >
    <strong class="text-orange-800">已选 {selectedCount} 张</strong>
    <span class="text-orange-600">批量查询将仅处理已选卡</span>
    <button
      type="button"
      onclick={onClearSelection}
      class="ml-auto font-medium text-orange-700 hover:underline">清空选择</button
    >
  </div>
{/if}
