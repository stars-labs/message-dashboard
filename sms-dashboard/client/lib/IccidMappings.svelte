<script lang="ts">
  import { confirmAction } from './confirm.svelte.js';
  import { onMount } from 'svelte';
  import { api, errorMessage } from './api';
  import { getStatusMeta, hasOperationalIssue } from './device-status.js';
  import { formatCardNumber } from './card-number.js';
  import { buildCarrierOptions, carrierKey } from './carrier.js';
  import { getSimServiceTypeLabel } from './sim-service-type.js';
  import { groupByPrimary } from './group-by-primary.js';
  import type { IccidMapping } from '../../shared/api/iccid-mappings.js';
  import { textOr } from '../../shared/text.js';
  import MappingDialog from './iccid-mappings/MappingDialog.svelte';
  import MappingTable from './iccid-mappings/MappingTable.svelte';
  import {
    editForm,
    emptyForm,
    isInactive,
    type Panel,
    type SortKey,
    type StatusFilter,
  } from './iccid-mappings/model.js';
  import { compareValues, sortValue } from './iccid-mappings/sort.js';

  interface Props {
    initialStatusFilter?: StatusFilter;
  }

  let { initialStatusFilter = 'all' }: Props = $props();

  let allMappingsCache = $state<IccidMapping[]>([]);
  let mappings = $state<IccidMapping[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let searchQuery = $state('');
  // A chip click overrides it; a new deep-link value resets it.
  let statusFilter = $derived<StatusFilter>(initialStatusFilter);
  let carrierFilter = $state('all');
  let successMessage = $state<string | null>(null);
  let sortKey = $state<SortKey | null>(null);
  let sortDirection = $state<'asc' | 'desc'>('asc');

  let panel = $state<Panel | null>(null);

  function openAdd() {
    panel = { mode: 'add', formData: emptyForm() };
  }

  function openEdit(mapping: IccidMapping) {
    panel = {
      mode: 'edit',
      mapping,
      formData: editForm(mapping),
    };
  }

  function closePanel() {
    panel = null;
    error = null;
  }

  let activeCount = $derived(allMappingsCache.filter((m) => m.is_active === 'active').length);
  let errorCount = $derived(
    allMappingsCache.filter((m) => hasOperationalIssue(m.is_active)).length,
  );
  let inactiveCount = $derived(allMappingsCache.filter(isInactive).length);
  let totalCount = $derived(allMappingsCache.length);
  let statusChips = $derived<{ value: StatusFilter; label: string; count: number }[]>([
    { value: 'all', label: '全部', count: totalCount },
    { value: 'active', label: '在线', count: activeCount },
    { value: 'error', label: '异常', count: errorCount },
    { value: 'inactive', label: '待映射', count: inactiveCount },
  ]);
  let carrierOptions = $derived.by(() =>
    buildCarrierOptions(
      allMappingsCache.map((mapping) => ({
        carrier: mapping.carrier,
        country: mapping.country,
      })),
    ),
  );

  function toggleSort(key: SortKey | null) {
    if (key === null) return;
    if (sortKey === key) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    else {
      sortKey = key;
      sortDirection = 'asc';
    }
  }

  async function loadMappings() {
    loading = true;
    error = null;
    try {
      const response = await api.iccidMappings.list({ page: 1, limit: 10000 });
      allMappingsCache = response.data;
      filterMappings();
    } catch (err) {
      error = errorMessage(err, '加载映射失败');
    } finally {
      loading = false;
    }
  }

  function filterMappings() {
    let filtered = allMappingsCache;
    if (statusFilter === 'active') filtered = filtered.filter((m) => m.is_active === 'active');
    else if (statusFilter === 'error')
      filtered = filtered.filter((m) => hasOperationalIssue(m.is_active));
    else if (statusFilter === 'inactive') filtered = filtered.filter(isInactive);

    if (carrierFilter !== 'all') {
      filtered = filtered.filter(
        (mapping) =>
          carrierKey({
            carrier: mapping.carrier,
            country: mapping.country,
          }) === carrierFilter,
      );
    }

    if (searchQuery.trim() !== '') {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter(
        (m) =>
          formatCardNumber(m.sim_index).toLowerCase().includes(q) ||
          m.iccid.toLowerCase().includes(q) ||
          m.phone_number.toLowerCase().includes(q) ||
          textOr(m.carrier, '').toLowerCase().includes(q) ||
          getSimServiceTypeLabel(m.service_type).includes(q) ||
          textOr(m.equipment_id, '').toLowerCase().includes(q) ||
          textOr(m.notes, '').toLowerCase().includes(q),
      );
    }

    const sorted = filtered.slice().sort((a, b) => {
      if (sortKey !== null) {
        const comparison = compareValues(sortValue(a, sortKey), sortValue(b, sortKey));
        if (comparison !== 0) return sortDirection === 'asc' ? comparison : -comparison;
      } else {
        // Until a header is selected, rows that need action come first.
        const ao = getStatusMeta(a.is_active).sortOrder;
        const bo = getStatusMeta(b.is_active).sortOrder;
        if (ao !== bo) return ao - bo;
      }
      return a.sim_index - b.sim_index;
    });

    // An orphan secondary (its primary filtered out) renders at depth 0, not dropped.
    mappings = groupByPrimary(sorted, (row) => row);
  }

  $effect(() => {
    filterMappings();
  });

  onMount(loadMappings);

  async function handleSave() {
    const current = panel;
    if (current === null) return;
    error = null;
    const fd = current.formData;
    if (typeof fd.sim_index !== 'number') {
      error = '请输入卡号';
      return;
    }
    try {
      const payload = {
        iccid: fd.iccid,
        phone_number: fd.phone_number,
        carrier: fd.carrier,
        country_code: fd.country,
        notes: fd.description,
        sim_index: fd.sim_index,
        imei: fd.imei,
        service_type: fd.service_type,
        service_type_source: fd.service_type === 'unknown' ? null : fd.service_type_source,
        sim_role: fd.sim_role,
        primary_iccid: fd.sim_role === 'secondary' ? fd.primary_iccid : null,
        balance_threshold: fd.balance_threshold,
      };
      if (current.mode === 'add') await api.iccidMappings.create(payload);
      else await api.iccidMappings.update(current.mapping.id, payload);
      closePanel();
      await loadMappings();
    } catch (err) {
      error = errorMessage(err, '保存失败');
    }
  }

  async function handleDelete(id: string) {
    if (
      !(await confirmAction({
        message:
          '确认删除此映射？\n\n卡还在槽里，但收到的短信将不再归属号码。已收到的历史短信保留。',
        confirmLabel: '删除',
        danger: true,
      }))
    )
      return;
    try {
      await api.iccidMappings.delete(id);
      closePanel();
      await loadMappings();
    } catch (err) {
      error = errorMessage(err, '删除失败');
    }
  }
</script>

<div
  class="relative overflow-hidden bg-white p-4 sm:p-6 lg:h-full lg:min-h-0 lg:flex lg:flex-col lg:border lg:border-stone-200/80
  lg:rounded-xl lg:shadow-[0_1px_3px_rgba(28,25,23,0.06),0_1px_2px_rgba(28,25,23,0.04)]"
>
  <div
    class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4 lg:flex-none"
  >
    <div>
      <h2 class="text-lg sm:text-xl font-bold text-stone-900">设备与卡 · ICCID 映射</h2>
    </div>
    <button
      onclick={openAdd}
      class="shrink-0 px-4 py-2 bg-stone-800 text-white text-sm font-medium rounded-lg
        hover:bg-stone-700 transition-colors"
    >
      添加映射
    </button>
  </div>

  <div class="flex flex-col sm:flex-row gap-2 mb-4 lg:flex-none">
    <div class="flex flex-wrap gap-1.5">
      <!-- Same labels as the device page and the status badge. -->
      {#each statusChips as chip (chip.value)}
        <button
          onclick={() => {
            statusFilter = chip.value;
          }}
          class="px-3 py-1.5 text-xs rounded-lg font-medium transition-colors tabular-nums
            {statusFilter === chip.value
            ? chip.value === 'error'
              ? 'bg-red-600 text-white'
              : chip.value === 'active'
                ? 'bg-emerald-600 text-white'
                : 'bg-stone-800 text-white'
            : chip.value === 'error'
              ? 'bg-red-50 text-red-700 border border-red-200'
              : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}"
        >
          {chip.label}
          {chip.count}
        </button>
      {/each}
    </div>
    <div class="flex gap-2 min-w-0">
      <label class="sr-only" for="mapping-carrier-filter">运营商筛选</label>
      <select
        id="mapping-carrier-filter"
        value={carrierFilter}
        onchange={(event) => {
          carrierFilter = event.currentTarget.value;
        }}
        aria-label="运营商筛选"
        class="w-[120px] sm:w-[140px] shrink-0 px-2.5 py-1.5 text-sm bg-stone-50 border border-stone-200 rounded-lg
          focus:outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
      >
        <option value="all">全部运营商</option>
        {#each carrierOptions as carrier (carrier.key)}
          <option value={carrier.key}>{carrier.label}</option>
        {/each}
      </select>
      <input
        type="text"
        bind:value={searchQuery}
        placeholder="卡号 / 号码 / 运营商 / ICCID"
        class="w-[220px] px-3 py-1.5 text-sm bg-stone-50 border border-stone-200 rounded-lg
          focus:outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100 transition-colors"
      />
    </div>
  </div>

  {#if successMessage}
    <div
      class="mb-3 px-3 py-2 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-lg text-sm flex items-center justify-between lg:flex-none"
    >
      ✓ {successMessage}
      <button
        onclick={() => {
          successMessage = null;
        }}
        class="text-emerald-400 hover:text-emerald-600 ml-2">&times;</button
      >
    </div>
  {/if}

  {#if error && !panel}
    <div
      class="mb-3 px-3 py-2 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm lg:flex-none"
    >
      {error}
    </div>
  {/if}

  {#if loading}
    <div class="py-12 text-center">
      <div
        class="inline-block w-6 h-6 border-2 border-stone-300 border-t-stone-600 rounded-full animate-spin"
      ></div>
      <p class="text-sm text-stone-400 mt-2">加载中…</p>
    </div>
  {:else if mappings.length === 0}
    <div class="py-16 text-center text-stone-400">
      <p class="text-sm">暂无数据</p>
      <button onclick={openAdd} class="mt-2 text-xs text-action-text hover:underline"
        >添加第一条映射</button
      >
    </div>
  {:else}
    <MappingTable {mappings} {sortKey} {sortDirection} onsort={toggleSort} onedit={openEdit} />
  {/if}
</div>

{#if panel}
  <MappingDialog
    {panel}
    allMappings={allMappingsCache}
    {error}
    onclose={closePanel}
    onsave={handleSave}
    ondelete={handleDelete}
  />
{/if}
