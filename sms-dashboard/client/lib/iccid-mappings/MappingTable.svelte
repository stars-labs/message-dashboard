<script lang="ts">
  import { getModemPosition } from '../modem-position.js';
  import { getCountryFlag, getCarrierColor } from '../countries.js';
  import { getStatusMeta, isAnomalous } from '../device-status.js';
  import { formatCardNumber } from '../../../shared/card-number.js';
  import { getSimServiceTypeLabel } from '../sim-service-type.js';
  import { getSimRoleLabel } from '../sim-role.js';
  import { getBalanceThreshold } from '../balance-overview.js';
  import type { IccidMapping } from '../../../shared/api/iccid-mappings.js';
  import { textOr } from '../../../shared/text.js';
  import type { SortKey } from './model.js';
  import { tableColumns } from './sort.js';

  interface Props {
    mappings: readonly IccidMapping[];
    sortKey: SortKey | null;
    sortDirection: 'asc' | 'desc';
    onsort: (key: SortKey | null) => void;
    onedit: (mapping: IccidMapping) => void;
  }

  let { mappings, sortKey, sortDirection, onsort, onedit }: Props = $props();
</script>

<div
  class="hidden sm:block overflow-x-auto lg:flex-1 lg:min-h-0 lg:overflow-auto"
  data-desktop-table-scroll
>
  <table class="w-full text-sm">
    <thead class="lg:sticky lg:top-0 lg:z-10 bg-stone-50">
      <tr class="bg-stone-50 border-b border-stone-200">
        {#each tableColumns as column, i (column.label)}
          <th
            class="px-3 py-2.5 text-left text-[11px] font-semibold text-stone-400 tracking-widest uppercase
                {i === tableColumns.length - 1 ? 'text-right' : ''}"
          >
            {#if column.key}
              <button
                type="button"
                onclick={() => {
                  onsort(column.key);
                }}
                class="inline-flex items-center gap-1 hover:text-stone-700 transition-colors"
                aria-label={`按${column.label}${sortKey === column.key && sortDirection === 'asc' ? '降序' : '升序'}排列`}
              >
                {column.label}
                <span
                  class="text-[9px] {sortKey === column.key ? 'text-orange-500' : 'text-stone-300'}"
                  aria-hidden="true"
                >
                  {sortKey === column.key ? (sortDirection === 'asc' ? '▲' : '▼') : '↕'}
                </span>
              </button>
            {:else}
              {column.label}
            {/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody class="divide-y divide-stone-50">
      {#each mappings as m (m.iccid)}
        {@const meta = getStatusMeta(m.is_active)}
        {@const anomalous = isAnomalous(m.is_active)}
        {@const pos = getModemPosition(m)}
        {@const isSecondary = m.sim_role === 'secondary'}
        <tr
          class="hover:bg-stone-50 transition-colors {anomalous ? meta.rowClass : ''} {isSecondary
            ? 'bg-stone-50/60'
            : ''}"
        >
          <td class="py-2.5 {isSecondary ? 'pl-7 pr-3' : 'px-3'}">
            {#if isSecondary}
              <div class="flex items-center gap-1.5">
                <span class="text-stone-300 text-xs shrink-0">└</span>
                <span class="font-mono font-semibold tabular-nums text-sm text-stone-700">
                  {formatCardNumber(m.sim_index)}
                </span>
              </div>
            {:else}
              <span class="font-mono font-semibold tabular-nums text-sm text-stone-900">
                {formatCardNumber(m.sim_index)}
              </span>
            {/if}
          </td>
          <td class="px-3 py-2.5 font-mono text-sm text-stone-800 whitespace-nowrap">
            {#if m.phone_number}{m.phone_number}{:else}<span class="text-stone-300">—</span>{/if}
          </td>
          <td class="px-3 py-2.5 font-mono text-xs text-stone-500 whitespace-nowrap">
            {textOr(m.iccid, '—')}
          </td>
          <td class="px-3 py-2.5">
            {#if m.carrier}
              <div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span
                  class="inline-flex px-2 py-0.5 text-xs rounded-full font-medium {getCarrierColor(
                    m.carrier,
                  )}"
                >
                  <span class="mr-1" aria-hidden="true">{getCountryFlag(m.country)}</span
                  >{m.carrier}
                </span>
                {#if m.operator && m.operator !== m.carrier}
                  <span class="text-[11px] text-stone-400 whitespace-nowrap"
                    >serving: {m.operator}</span
                  >
                {/if}
              </div>
            {:else}
              <span class="text-stone-300">—</span>
            {/if}
          </td>
          <td class="px-3 py-2.5 whitespace-nowrap">
            <span
              class="inline-flex px-2 py-0.5 text-[11px] rounded-md border
                  {m.service_type === 'prepaid' || m.service_type === 'postpaid'
                ? 'bg-stone-50 text-stone-700 border-stone-200'
                : m.service_type === 'balance_managed'
                  ? 'bg-stone-50 text-stone-400 border-stone-200'
                  : 'bg-amber-50 text-amber-700 border-amber-200'}"
            >
              {getSimServiceTypeLabel(m.service_type)}
            </span>
          </td>
          <td class="px-3 py-2.5 whitespace-nowrap">
            <span
              class="inline-flex px-2 py-0.5 text-[11px] rounded-md border
                  {m.sim_role === 'primary'
                ? 'bg-blue-50 text-blue-700 border-blue-200'
                : m.sim_role === 'secondary'
                  ? 'bg-violet-50 text-violet-700 border-violet-200'
                  : 'bg-stone-50 text-stone-400 border-stone-200'}"
              title={m.sim_role === 'secondary' ? `副卡 → ${textOr(m.primary_iccid, '主卡')}` : ''}
            >
              {getSimRoleLabel(m.sim_role)}
            </span>
          </td>
          <td class="px-3 py-2.5 font-mono text-xs text-stone-500 whitespace-nowrap">
            {#if pos}
              {pos.path}
              {#if pos.isLastKnown}
                <span
                  class="ml-1 font-sans text-[10px] text-stone-400"
                  title="模块离线时最后确认的位置">上次</span
                >
              {/if}
            {:else}
              <span class="text-stone-300">—</span>
            {/if}
          </td>
          <td class="px-3 py-2.5 font-mono text-xs">
            {#if m.signal_quality != null}
              <span
                class={m.signal_quality >= 60
                  ? 'text-emerald-600'
                  : m.signal_quality >= 30
                    ? 'text-amber-600'
                    : 'text-red-600'}
              >
                {m.signal_quality}%
              </span>
            {:else}
              <span class="text-stone-300">—</span>
            {/if}
          </td>
          <td class="px-3 py-2.5">
            <span
              class="inline-flex px-2 py-0.5 text-[11px] rounded-md font-medium border {meta.badgeClass}"
            >
              {meta.label}
            </span>
          </td>
          <td class="px-3 py-2.5 font-mono text-xs whitespace-nowrap">
            {#if m.sim_role === 'secondary'}
              <span class="text-stone-300">—</span>
            {:else}
              {@const t = getBalanceThreshold(m)}
              {#if t}
                {#if m.balance_threshold != null}
                  <span class="text-stone-800">{t.value} {t.currency}</span>
                {:else}
                  <span class="text-stone-400">{t.value} {t.currency}</span>
                {/if}
              {:else}
                <span class="text-stone-300">—</span>
              {/if}
            {/if}
          </td>
          <td class="px-3 py-2.5 text-xs text-stone-500 max-w-[180px]">
            {#if anomalous && textOr(m.notes, null) === null}
              <span class="text-stone-400 italic">{meta.label}</span>
            {:else}
              {textOr(m.notes, '')}
            {/if}
          </td>
          <td class="px-3 py-2.5 text-right whitespace-nowrap">
            {#if m.is_active === 'unassigned' || !m.phone_number}
              <button
                onclick={() => {
                  onedit(m);
                }}
                class="text-xs font-semibold text-action-text hover:underline"
              >
                设置映射
              </button>
            {:else}
              <button
                onclick={() => {
                  onedit(m);
                }}
                class="text-xs text-stone-500 hover:text-stone-800 transition-colors"
              >
                编辑
              </button>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<div class="sm:hidden -mx-4 border-t border-stone-100">
  {#each mappings as m (m.iccid)}
    {@const meta = getStatusMeta(m.is_active)}
    {@const anomalous = isAnomalous(m.is_active)}
    {@const pos = getModemPosition(m)}
    <div
      class="relative bg-white border-b border-stone-100 p-3 pl-4 overflow-hidden
          {anomalous ? meta.rowClass : ''}"
    >
      <span class="absolute left-0 top-0 bottom-0 w-[3px] {meta.dotClass}" aria-hidden="true"
      ></span>
      <div class="flex items-center gap-2">
        <span
          class="font-mono font-bold text-sm tabular-nums text-stone-700 shrink-0 w-8 text-right"
        >
          {formatCardNumber(m.sim_index)}
        </span>
        <span class="font-mono text-sm text-stone-900 truncate"
          >{textOr(m.phone_number, '无号码')}</span
        >
        <div class="ml-auto flex items-center gap-0.5 shrink-0 -my-1">
          <button
            onclick={() => {
              onedit(m);
            }}
            aria-label="编辑"
            class="p-1.5 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-lg transition-colors"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </button>
        </div>
      </div>
      <div class="mt-1 flex items-center gap-2 text-[11px] text-stone-400 font-mono">
        <span
          class={meta.badgeClass.includes('red')
            ? 'text-red-600'
            : meta.badgeClass.includes('amber')
              ? 'text-amber-600'
              : ''}>{meta.label}</span
        >
        {#if m.carrier}<span>{getCountryFlag(m.country)} {m.carrier}</span>{/if}
        <span>· {getSimServiceTypeLabel(m.service_type)}</span>
        {#if m.sim_role && m.sim_role !== 'standalone'}
          <span
            class="inline-flex px-1 py-0.5 text-[9px] rounded border
                {m.sim_role === 'primary'
              ? 'bg-blue-50 text-blue-700 border-blue-200'
              : 'bg-violet-50 text-violet-700 border-violet-200'}"
          >
            {m.sim_role === 'primary' ? '主卡' : '副卡'}
          </span>
        {/if}
        {#if m.signal_quality != null}<span>· {m.signal_quality}%</span>{/if}
        {#if pos}<span>· {pos.path}{pos.isLastKnown ? '（上次）' : ''}</span>{/if}
      </div>
    </div>
  {/each}
</div>
