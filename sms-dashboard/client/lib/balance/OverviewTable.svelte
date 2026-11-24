<script lang="ts">
  import { textOr } from '../../../shared/text.js';
  import type { SummaryStatus } from '../../../shared/prepaid-health.js';
  import { BALANCE_HEALTH_META, isSummaryStatus } from '../balance-overview.js';
  import { formatBalanceMetric, getBalanceStatusMeta } from '../balance-query.js';
  import { formatCardNumber } from '../card-number.js';
  import { getCountryFlag } from '../countries.js';
  import { getSimServiceTypeLabel } from '../sim-service-type.js';
  import { formatThreshold, formatTime } from './presentation.js';
  import type { BalanceRow, GroupedBalanceRow, OverviewSortKey, SortDirection } from './types.js';

  interface Props {
    rows: readonly GroupedBalanceRow[];
    canQueryBalances: boolean;
    selectedIccidSet: ReadonlySet<string>;
    allFilteredSelected: boolean;
    someFilteredSelected: boolean;
    queryingIccid: string | null;
    sortKey: OverviewSortKey | null;
    sortDirection: SortDirection;
    primaryOf: (row: BalanceRow) => BalanceRow | null;
    postpaidPaymentCount: (row: BalanceRow) => number;
    hasBillingAccount: (iccid: string) => boolean;
    onToggleCard: (iccid: string, checked: boolean) => void;
    onToggleAll: (checked: boolean) => void;
    onOpenRow: (row: BalanceRow) => void;
    onOpenBill: (row: BalanceRow) => void;
    onQuery: (row: BalanceRow, event: Event) => void;
    onClearFilters: () => void;
  }

  let {
    rows,
    canQueryBalances,
    selectedIccidSet,
    allFilteredSelected,
    someFilteredSelected,
    queryingIccid,
    sortKey = $bindable(),
    sortDirection = $bindable(),
    primaryOf,
    postpaidPaymentCount,
    hasBillingAccount,
    onToggleCard,
    onToggleAll,
    onOpenRow,
    onOpenBill,
    onQuery,
    onClearFilters,
  }: Props = $props();

  const overviewColumns: readonly { key: OverviewSortKey | null; label: string }[] = [
    { key: 'sim', label: '卡号' },
    { key: 'carrier', label: '运营商' },
    { key: 'sim_role', label: '主副卡' },
    { key: 'service_type', label: '计费类型' },
    { key: 'balance', label: '当前余额' },
    { key: 'expiry', label: '有效期' },
    { key: 'health', label: '状态' },
    { key: 'threshold', label: '阈值' },
    { key: 'updated', label: '最近更新' },
    { key: 'query', label: '最近查询' },
    { key: null, label: '操作' },
  ];

  function extraHealthReasons(row: BalanceRow): SummaryStatus[] {
    return row.healthReasons.filter(isSummaryStatus).filter((reason) => reason !== row.health);
  }

  function toggleOverviewSort(key: OverviewSortKey) {
    if (sortKey === key) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    else {
      sortKey = key;
      sortDirection = 'asc';
    }
  }
</script>

{#if rows.length === 0}
  <div class="py-16 text-center">
    <p class="text-sm text-stone-400">没有匹配的 SIM</p>
    <button
      type="button"
      onclick={onClearFilters}
      class="mt-2 text-xs text-action-text hover:underline">清除筛选</button
    >
  </div>
{:else}
  <div class="hidden lg:block lg:flex-1 lg:min-h-0 lg:overflow-auto" data-desktop-balance-scroll>
    <table class="w-full text-sm">
      <thead class="sticky top-0 z-10 bg-stone-50">
        <tr class="bg-stone-50 border-b border-stone-200">
          {#if canQueryBalances}
            <th class="w-12 px-4 py-2.5 text-left">
              <input
                type="checkbox"
                checked={allFilteredSelected}
                aria-checked={someFilteredSelected && !allFilteredSelected
                  ? 'mixed'
                  : allFilteredSelected}
                aria-label="选择当前筛选结果"
                onchange={(event) => {
                  onToggleAll(event.currentTarget.checked);
                }}
                class="rounded border-stone-300 text-orange-500 focus:ring-orange-400"
              />
            </th>
          {/if}
          {#each overviewColumns as column, index (column.label)}
            <th
              class="px-4 py-2.5 text-left text-[11px] font-semibold text-stone-400 tracking-widest uppercase {index ===
              overviewColumns.length - 1
                ? 'text-right'
                : ''}"
            >
              {#if column.key}
                {@const columnKey = column.key}
                <button
                  type="button"
                  onclick={() => {
                    toggleOverviewSort(columnKey);
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
        </tr>
      </thead>
      <tbody class="divide-y divide-stone-50">
        {#each rows as row (row.phone.iccid)}
          <tr
            class="hover:bg-stone-50 transition-colors {row.__isSecondary ? 'bg-stone-50/60' : ''}"
          >
            {#if canQueryBalances}
              <td class="w-12 px-4 py-3" style="padding-left: {row.__depth * 1.25 + 1}rem">
                <input
                  type="checkbox"
                  checked={selectedIccidSet.has(row.phone.iccid)}
                  disabled={row.phone.sim_role === 'secondary' ||
                    row.phone.service_type === 'postpaid'}
                  aria-label={`选择 ${formatCardNumber(row.phone.sim_index)}`}
                  onchange={(event) => {
                    onToggleCard(row.phone.iccid, event.currentTarget.checked);
                  }}
                  class="rounded border-stone-300 text-orange-500 focus:ring-orange-400 disabled:opacity-40"
                />
              </td>
            {/if}
            <td class="px-4 py-3 min-w-[180px]">
              <div class="flex items-baseline gap-2">
                <span class="font-mono font-bold text-stone-900"
                  >{formatCardNumber(row.phone.sim_index)}</span
                >
                <span class="font-mono text-xs text-stone-600"
                  >{textOr(row.phone.number, '未设置号码')}</span
                >
              </div>
              <div class="mt-0.5 font-mono text-[10px] text-stone-400">{row.phone.iccid}</div>
            </td>
            <td class="px-4 py-3 whitespace-nowrap text-stone-600">
              <span class="mr-1">{textOr(row.phone.flag, getCountryFlag(row.phone.country))}</span
              >{textOr(row.phone.carrier, '—')}
            </td>
            <td class="px-4 py-3 whitespace-nowrap">
              {#if row.phone.sim_role === 'secondary'}
                {@const primary = primaryOf(row)}
                <span
                  class="inline-flex px-1.5 py-0.5 rounded border text-[10px] bg-violet-50 text-violet-700 border-violet-200"
                  title={primary
                    ? `余额随主卡 → ${formatCardNumber(primary.phone.sim_index)}`
                    : '副卡'}
                >
                  副卡{primary ? ` → ${formatCardNumber(primary.phone.sim_index)}` : ''}
                </span>
              {:else if row.phone.sim_role === 'primary'}
                <span
                  class="inline-flex px-1.5 py-0.5 rounded border text-[10px] bg-blue-50 text-blue-700 border-blue-200"
                  >主卡</span
                >
              {:else}
                <span class="text-stone-300">—</span>
              {/if}
            </td>
            <td class="px-4 py-3 whitespace-nowrap">
              <span
                class="inline-flex px-2 py-0.5 rounded-md border text-[11px]
                      {row.phone.service_type === 'prepaid' || row.phone.service_type === 'postpaid'
                  ? 'bg-stone-50 text-stone-700 border-stone-200'
                  : row.phone.service_type === 'balance_managed'
                    ? 'bg-stone-50 text-stone-400 border-stone-200'
                    : 'bg-amber-50 text-amber-700 border-amber-200'}"
              >
                {getSimServiceTypeLabel(row.phone.service_type)}
              </span>
            </td>
            <td
              class="px-4 py-3 whitespace-nowrap font-semibold tabular-nums {[
                'low_balance',
                'zero_or_negative_balance',
              ].includes(row.health)
                ? 'text-red-700'
                : 'text-stone-900'}"
            >
              {#if row.__isSecondary}
                <span class="text-xs font-normal text-stone-400">余额随主卡</span>
              {:else if row.phone.service_type === 'postpaid'}
                {@const paymentCount = postpaidPaymentCount(row)}
                <span class="flex flex-col gap-0.5 text-xs font-normal">
                  <span class="text-stone-400">不按余额管理</span>
                  <span
                    class={paymentCount > 0
                      ? 'text-red-700 font-medium'
                      : hasBillingAccount(row.phone.iccid)
                        ? 'text-emerald-700'
                        : 'text-amber-700'}
                  >
                    {paymentCount > 0
                      ? `待付款 ${paymentCount} 笔`
                      : hasBillingAccount(row.phone.iccid)
                        ? '已收到过账单短信'
                        : '等待账单短信'}
                  </span>
                </span>
              {:else}
                {formatBalanceMetric(row.balanceMetric)}
              {/if}
            </td>
            <td class="px-4 py-3 whitespace-nowrap font-mono text-xs text-stone-500">
              {row.__isSecondary ? '—' : textOr(row.expiryDate, '—')}
            </td>
            <td class="px-4 py-3 whitespace-nowrap">
              {#if row.__isSecondary}
                <span class="text-stone-300">—</span>
              {:else}
                <span class="flex flex-wrap items-center gap-1 max-w-[190px]">
                  <span
                    class="inline-flex px-2 py-0.5 rounded-md border text-[11px] font-medium {row
                      .healthMeta.className}">{row.healthMeta.label}</span
                  >
                  {#each extraHealthReasons(row) as reason (reason)}
                    <span
                      class="inline-flex px-1.5 py-0.5 rounded border text-[10px] font-medium {BALANCE_HEALTH_META[
                        reason
                      ].className}">{BALANCE_HEALTH_META[reason].label}</span
                    >
                  {/each}
                </span>
              {/if}
            </td>
            <td class="px-4 py-3 whitespace-nowrap font-mono text-xs text-stone-500">
              {row.__isSecondary ? '—' : formatThreshold(row.threshold)}
            </td>
            <td class="px-4 py-3 whitespace-nowrap font-mono text-xs text-stone-500">
              {row.__isSecondary ? '—' : formatTime(row.balanceTimestamp)}
            </td>
            <td class="px-4 py-3 whitespace-nowrap">
              {#if row.__isSecondary}
                <span class="text-stone-300">—</span>
              {:else if row.latestCheck}
                {@const queryMeta = getBalanceStatusMeta(row.latestCheck.display_status)}
                <span class="text-xs text-stone-600">{queryMeta.label}</span>
                <span class="ml-1 text-[10px] uppercase text-stone-400"
                  >{row.latestCheck.method}</span
                >
              {:else}
                <span class="text-stone-300">—</span>
              {/if}
            </td>
            <td class="px-4 py-3 text-right">
              <div class="flex items-center justify-end gap-3">
                {#if hasBillingAccount(row.phone.iccid)}
                  <button
                    type="button"
                    onclick={() => {
                      onOpenBill(row);
                    }}
                    class="text-xs font-semibold text-action-text hover:underline">查看账单</button
                  >
                {:else if row.latestCheck ?? row.balanceCheck}
                  <button
                    type="button"
                    onclick={() => {
                      onOpenRow(row);
                    }}
                    class="text-xs font-medium text-stone-500 hover:text-stone-800">查看</button
                  >
                {/if}
                {#if canQueryBalances && row.phone.service_type !== 'postpaid'}
                  <button
                    type="button"
                    onclick={(event) => {
                      onQuery(row, event);
                    }}
                    disabled={!!queryingIccid || row.phone.sim_role === 'secondary'}
                    title={row.phone.sim_role === 'secondary' ? '副卡，余额随主卡查询' : ''}
                    class="text-xs font-semibold text-action-text hover:underline disabled:text-stone-300 disabled:no-underline"
                  >
                    {queryingIccid === row.phone.iccid ? '排队中…' : '查询'}
                  </button>
                {:else if !hasBillingAccount(row.phone.iccid) && !row.latestCheck && !row.balanceCheck}
                  <span class="text-stone-300">—</span>
                {/if}
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="lg:hidden divide-y divide-stone-100" data-mobile-balance-list>
    {#each rows as row (row.phone.iccid)}
      <div
        class="w-full px-4 py-2.5 text-left bg-white {row.__isSecondary ? 'bg-stone-50/60' : ''}"
        style="padding-left: {row.__depth * 1 + 1}rem"
        data-mobile-balance-row
      >
        <div class="flex items-center gap-2 min-w-0">
          {#if canQueryBalances}
            <input
              type="checkbox"
              checked={selectedIccidSet.has(row.phone.iccid)}
              disabled={row.phone.sim_role === 'secondary' || row.phone.service_type === 'postpaid'}
              aria-label={`选择 ${formatCardNumber(row.phone.sim_index)}（移动端）`}
              onchange={(event) => {
                onToggleCard(row.phone.iccid, event.currentTarget.checked);
              }}
              class="rounded border-stone-300 text-orange-500 focus:ring-orange-400 shrink-0 disabled:opacity-40"
            />
          {/if}
          <button
            type="button"
            onclick={() => {
              onOpenRow(row);
            }}
            disabled={!row.latestCheck && !row.balanceCheck}
            class="flex items-center gap-2 min-w-0 text-left disabled:cursor-default"
          >
            <span class="font-mono font-bold text-sm text-stone-900 shrink-0"
              >{formatCardNumber(row.phone.sim_index)}</span
            >
            <span class="font-mono text-xs text-stone-600 truncate"
              >{textOr(row.phone.number, '未设置号码')}</span
            >
          </button>
          {#if row.__isSecondary}
            <span
              class="ml-auto inline-flex px-1.5 py-0.5 rounded border text-[10px] font-medium shrink-0 bg-violet-50 text-violet-700 border-violet-200"
              >副卡</span
            >
          {:else}
            <span class="ml-auto flex items-center gap-1 shrink-0">
              <span
                class="inline-flex px-2 py-0.5 rounded-md border text-[10px] font-medium {row
                  .healthMeta.className}">{row.healthMeta.label}</span
              >
              {#each extraHealthReasons(row) as reason (reason)}
                <span
                  class="inline-flex px-1.5 py-0.5 rounded border text-[9px] font-medium {BALANCE_HEALTH_META[
                    reason
                  ].className}">{BALANCE_HEALTH_META[reason].label}</span
                >
              {/each}
            </span>
          {/if}
        </div>
        <div class="mt-1.5 flex items-center gap-2 min-w-0">
          <div class="min-w-0 flex-1 flex items-baseline gap-2">
            {#if row.__isSecondary}
              {@const primary = primaryOf(row)}
              <span class="text-sm text-stone-400">
                {primary
                  ? `余额随主卡 → ${formatCardNumber(primary.phone.sim_index)}`
                  : '余额随主卡'}
              </span>
            {:else}
              {#if row.phone.service_type === 'postpaid'}
                {@const paymentCount = postpaidPaymentCount(row)}
                <span class="flex flex-col">
                  <strong class="text-sm leading-tight font-medium text-stone-400"
                    >不按余额管理</strong
                  >
                  <small
                    class={paymentCount > 0
                      ? 'text-red-700 font-medium'
                      : hasBillingAccount(row.phone.iccid)
                        ? 'text-emerald-700'
                        : 'text-amber-700'}
                  >
                    {paymentCount > 0
                      ? `待付款 ${paymentCount} 笔`
                      : hasBillingAccount(row.phone.iccid)
                        ? '已收到过账单短信'
                        : '等待账单短信'}
                  </small>
                </span>
              {:else}
                <strong
                  class="text-base leading-tight font-semibold tabular-nums truncate {[
                    'low_balance',
                    'zero_or_negative_balance',
                  ].includes(row.health)
                    ? 'text-red-700'
                    : 'text-stone-900'}">{formatBalanceMetric(row.balanceMetric)}</strong
                >
              {/if}
              <span class="text-[11px] text-stone-400 truncate shrink"
                >{textOr(row.phone.flag, getCountryFlag(row.phone.country))}
                {textOr(row.phone.carrier, '—')}</span
              >
              <span class="text-[10px] text-stone-400 shrink-0"
                >· {getSimServiceTypeLabel(row.phone.service_type)}</span
              >
              {#if row.expiryDate}
                <span class="font-mono text-[10px] text-stone-400 shrink-0">· {row.expiryDate}</span
                >
              {/if}
              {#if row.balanceTimestamp}
                <span
                  class="hidden min-[390px]:inline ml-auto font-mono text-[10px] text-stone-400 shrink-0"
                  >{formatTime(row.balanceTimestamp)}</span
                >
              {/if}
            {/if}
          </div>
          {#if hasBillingAccount(row.phone.iccid)}
            <button
              type="button"
              onclick={() => {
                onOpenBill(row);
              }}
              class="h-8 px-2.5 shrink-0 text-xs font-semibold text-action-text bg-orange-50 rounded-lg active:bg-orange-100"
            >
              查看账单
            </button>
          {:else if canQueryBalances && row.phone.service_type !== 'postpaid'}
            <button
              type="button"
              onclick={(event) => {
                onQuery(row, event);
              }}
              disabled={!!queryingIccid || row.phone.sim_role === 'secondary'}
              aria-label={`查询 ${formatCardNumber(row.phone.sim_index)} 余额`}
              class="h-8 px-2.5 shrink-0 text-xs font-semibold text-action-text bg-orange-50 rounded-lg active:bg-orange-100 disabled:text-stone-300 disabled:bg-stone-50"
            >
              {queryingIccid === row.phone.iccid ? '排队中…' : '查询'}
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}
