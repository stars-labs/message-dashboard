<script>
  import { onMount } from "svelte";
  import { api } from "./api";
  import { COUNTRIES, getCountryFlag, getCountryName, getCarrierColor } from "./countries.js";
  import { getStatusMeta, hasOperationalIssue, isAnomalous } from "./device-status.js";
  import { formatCardNumber } from "./card-number.js";

  let { initialStatusFilter = "all" } = $props();

  let allMappingsCache = $state([]);
  let mappings = $state([]);
  let loading = $state(false);
  let error = $state(null);
  let searchQuery = $state("");
  let statusFilter = $state(initialStatusFilter);
  let successMessage = $state(null);

  // Apply a new deep-link filter once. The previous effect also depended on
  // statusFilter, so every manual chip click was immediately reset to "error".
  let lastInitialStatusFilter = initialStatusFilter;
  $effect(() => {
    if (initialStatusFilter !== lastInitialStatusFilter) {
      lastInitialStatusFilter = initialStatusFilter;
      statusFilter = initialStatusFilter;
    }
  });

  // ── Unified panel ─────────────────────────────────────────────────────────
  // Single state object for add / edit. mode = 'add' | 'edit'.
  // Previously this component had two completely separate form blocks with
  // create-* and edit-* ids — 7 fields each, same structure. Gone.
  let panel = $state(null); // null = closed
  // { mode: 'add', formData } | { mode: 'edit', mapping, formData }

  function emptyForm() {
    return { iccid: '', phone_number: '', carrier: '', country: '', description: '', sim_index: '', imei: '' };
  }

  function openAdd() {
    panel = { mode: 'add', formData: emptyForm() };
  }

  function openEdit(mapping) {
    panel = {
      mode: 'edit',
      mapping,
      formData: {
        iccid: mapping.iccid,
        phone_number: mapping.phone_number,
        carrier: mapping.carrier || '',
        country: mapping.country || '',
        description: mapping.notes || mapping.description || '',
        sim_index: mapping.sim_index || '',
        imei: mapping.equipment_id || '',
      },
    };
  }

  function closePanel() { panel = null; error = null; }

  // Collision warning: is the entered sim_index already taken by a different card?
  let simIndexConflict = $derived(
    panel && panel.formData.sim_index
      ? allMappingsCache.find(m =>
          String(m.sim_index) === String(panel.formData.sim_index) &&
          m.iccid !== panel.formData.iccid
        )
      : null
  );

  // ── Stats (for filter chips) ───────────────────────────────────────────────
  let activeCount   = $derived(allMappingsCache.filter(m => m.is_active === 'active').length);
  let errorCount    = $derived(allMappingsCache.filter(m => hasOperationalIssue(m.is_active)).length);
  let inactiveCount = $derived(allMappingsCache.filter(m => ['no_modem', 'unassigned'].includes(m.is_active) || !m.is_active).length);
  let totalCount    = $derived(allMappingsCache.length);

  // ── Data loading ──────────────────────────────────────────────────────────
  async function loadMappings() {
    loading = true; error = null;
    try {
      const response = await api.iccidMappings.list({ page: 1, limit: 10000 });
      if (response?.success) {
        allMappingsCache = response.data?.results || response.data || [];
        filterMappings();
      } else {
        error = response?.error || "加载映射失败";
      }
    } catch (err) {
      error = err.message || "加载映射失败";
    } finally {
      loading = false;
    }
  }

  function filterMappings() {
    let filtered = allMappingsCache;
    if (statusFilter === 'active')   filtered = filtered.filter(m => m.is_active === 'active');
    else if (statusFilter === 'error') filtered = filtered.filter(m => hasOperationalIssue(m.is_active));
    else if (statusFilter === 'inactive') filtered = filtered.filter(m => ['no_modem','unassigned'].includes(m.is_active) || !m.is_active);

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter(m =>
        String(m.sim_index ?? '').includes(q) ||
        (m.iccid || '').toLowerCase().includes(q) ||
        (m.phone_number || '').toLowerCase().includes(q) ||
        (m.carrier || '').toLowerCase().includes(q) ||
        (m.equipment_id || '').toLowerCase().includes(q) ||
        (m.notes || m.description || '').toLowerCase().includes(q)
      );
    }

    // Rows needing action sort first.
    mappings = filtered.sort((a, b) => {
      const ao = getStatusMeta(a.is_active).sortOrder;
      const bo = getStatusMeta(b.is_active).sortOrder;
      return ao !== bo ? ao - bo : (a.sim_index ?? 999) - (b.sim_index ?? 999);
    });
  }

  $effect(() => { if (searchQuery !== undefined || statusFilter !== undefined) filterMappings(); });

  onMount(loadMappings);

  // ── Mutations ─────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!panel) return;
    error = null;
    try {
      const fd = panel.formData;
      if (panel.mode === 'add') {
        const r = await api.iccidMappings.create(fd);
        if (r.success) { closePanel(); await loadMappings(); }
        else error = r.error || "添加失败";
      } else {
        const r = await api.iccidMappings.update(panel.mapping.id, {
          phone_number: fd.phone_number, carrier: fd.carrier,
          country: fd.country, description: fd.description,
          sim_index: fd.sim_index, imei: fd.imei,
        });
        if (r.success) { closePanel(); await loadMappings(); }
        else error = r.error || "保存失败";
      }
    } catch (err) {
      error = err.message;
    }
  }

  async function handleDelete(id) {
    if (!confirm("确认删除此映射？\n\n卡还在槽里，但收到的短信将不再归属号码。已收到的历史短信保留。")) return;
    try {
      const r = await api.iccidMappings.delete(id);
      if (r.success) { closePanel(); await loadMappings(); }
      else error = r.error || "删除失败";
    } catch (err) {
      error = err.message;
    }
  }

  // Modem position string — absorbs 设备ID + USB位置 + UP/DOWN into one column.
  function modemPosition(m) {
    if (!m.equipment_id) return null;
    const parts = [];
    if (m.usb_path)   parts.push(m.usb_path);
    if (m.modem_index != null) parts.push(`M${m.modem_index}`);
    return parts.join(' / ') || m.equipment_id.slice(-8);
  }
</script>

<!-- ═══ Page ════════════════════════════════════════════════════════════════ -->
<div class="relative overflow-hidden bg-white p-4 sm:p-6 lg:border lg:border-stone-200/80
  lg:rounded-xl lg:shadow-[0_1px_3px_rgba(28,25,23,0.06),0_1px_2px_rgba(28,25,23,0.04)]">

  <!-- Header -->
  <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
    <div>
      <h2 class="text-lg sm:text-xl font-bold text-stone-900">设备与卡 · ICCID 映射</h2>
      <p class="text-xs text-stone-400 mt-0.5">{totalCount} 张卡 · 搜索：卡号 / 号码 / 运营商 / ICCID</p>
    </div>
    <button onclick={openAdd}
      class="shrink-0 px-4 py-2 bg-stone-800 text-white text-sm font-medium rounded-lg
        hover:bg-stone-700 transition-colors">
      添加映射
    </button>
  </div>

  <!-- Filter chips + search -->
  <div class="flex flex-col sm:flex-row gap-2 mb-4">
    <div class="flex flex-wrap gap-1.5">
      {#each [['all','全部',totalCount],['active','活动',activeCount],['error','异常',errorCount],['inactive','未激活',inactiveCount]] as [v,label,count]}
        <button onclick={() => { statusFilter = v; }}
          class="px-3 py-1.5 text-xs rounded-lg font-medium transition-colors tabular-nums
            {statusFilter === v
              ? v === 'error' ? 'bg-red-600 text-white' : v === 'active' ? 'bg-emerald-600 text-white' : 'bg-stone-800 text-white'
              : v === 'error' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}">
          {label} {count}
        </button>
      {/each}
    </div>
    <input
      type="text"
      bind:value={searchQuery}
      placeholder="搜索 卡号 / 号码 / 运营商 / ICCID…"
      class="flex-1 px-3 py-1.5 text-sm bg-stone-50 border border-stone-200 rounded-lg
        focus:outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100 transition-colors"
    />
  </div>

  {#if successMessage}
    <div class="mb-3 px-3 py-2 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-lg text-sm flex items-center justify-between">
      ✓ {successMessage}
      <button onclick={() => { successMessage = null; }} class="text-emerald-400 hover:text-emerald-600 ml-2">&times;</button>
    </div>
  {/if}

  {#if error && !panel}
    <div class="mb-3 px-3 py-2 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>
  {/if}

  {#if loading}
    <div class="py-12 text-center">
      <div class="inline-block w-6 h-6 border-2 border-stone-300 border-t-stone-600 rounded-full animate-spin"></div>
      <p class="text-sm text-stone-400 mt-2">加载中…</p>
    </div>

  {:else if mappings.length === 0}
    <div class="py-16 text-center text-stone-400">
      <p class="text-sm">暂无数据</p>
      <button onclick={openAdd} class="mt-2 text-xs text-action-text hover:underline">添加第一条映射</button>
    </div>

  {:else}
    <!-- ── Desktop table (9 columns, per spec) ─────────────────────────── -->
    <div class="hidden sm:block overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-stone-50 border-b border-stone-200">
            <!-- 卡号 44 / 号码 150 / ICCID 180 / 运营商 130 / 模块位置 110 / 信号 80 / 状态 110 / 备注 flex / 操作 80 -->
            {#each ['卡号','手机号','ICCID','运营商','模块位置','信号','状态','备注','操作'] as col, i}
              <th class="px-3 py-2.5 text-left text-[11px] font-semibold text-stone-400 tracking-widest uppercase
                {i === 8 ? 'text-right' : ''}">
                {col}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody class="divide-y divide-stone-50">
          {#each mappings as m}
            {@const meta = getStatusMeta(m.is_active)}
            {@const anomalous = isAnomalous(m.is_active)}
            {@const pos = modemPosition(m)}
            <tr class="hover:bg-stone-50 transition-colors {anomalous ? meta.rowClass : ''}">
              <!-- 卡号 -->
              <td class="px-3 py-2.5">
                <span class="font-mono font-semibold tabular-nums text-sm text-stone-900">
                  {formatCardNumber(m.sim_index)}
                </span>
              </td>
              <!-- 号码 -->
              <td class="px-3 py-2.5 font-mono text-sm text-stone-800 whitespace-nowrap">
                {#if m.phone_number}{m.phone_number}{:else}<span class="text-stone-300">—</span>{/if}
              </td>
              <!-- ICCID -->
              <td class="px-3 py-2.5 font-mono text-xs text-stone-500 whitespace-nowrap">
                {m.iccid || '—'}
              </td>
              <!-- 运营商 -->
              <td class="px-3 py-2.5">
                {#if m.carrier}
                  <span class="inline-flex px-2 py-0.5 text-xs rounded-full font-medium {getCarrierColor(m.carrier)}">
                    {m.carrier}
                  </span>
                {:else}
                  <span class="text-stone-300">—</span>
                {/if}
              </td>
              <!-- 模块位置 (absorbs 设备ID + USB位置 + UP/DOWN) -->
              <td class="px-3 py-2.5 font-mono text-xs text-stone-500 whitespace-nowrap">
                {#if pos}
                  {pos}
                  {#if m.modem_status === 'disconnected'}
                    <span class="text-red-500 ml-1">↓</span>
                  {/if}
                {:else}
                  <span class="text-stone-300">—</span>
                {/if}
              </td>
              <!-- 信号 -->
              <td class="px-3 py-2.5 font-mono text-xs">
                {#if m.signal_quality != null}
                  <span class="{m.signal_quality >= 60 ? 'text-emerald-600' : m.signal_quality >= 30 ? 'text-amber-600' : 'text-red-600'}">
                    {m.signal_quality}%
                  </span>
                {:else}
                  <span class="text-stone-300">—</span>
                {/if}
              </td>
              <!-- 状态 -->
              <td class="px-3 py-2.5">
                <span class="inline-flex px-2 py-0.5 text-[11px] rounded-md font-medium border {meta.badgeClass}">
                  {meta.label}
                </span>
              </td>
              <!-- 备注 — shows what's wrong for anomalous rows -->
              <td class="px-3 py-2.5 text-xs text-stone-500 max-w-[180px]">
                {#if anomalous && !m.notes && !m.description}
                  <span class="text-stone-400 italic">{meta.label}</span>
                {:else}
                  {m.notes || m.description || ''}
                {/if}
              </td>
              <!-- 操作 -->
              <td class="px-3 py-2.5 text-right whitespace-nowrap">
                {#if m.is_active === 'unassigned' || !m.phone_number}
                  <button onclick={() => openEdit(m)}
                    class="text-xs font-semibold text-action-text hover:underline">
                    设置映射
                  </button>
                {:else}
                  <button onclick={() => openEdit(m)}
                    class="text-xs text-stone-500 hover:text-stone-800 transition-colors">
                    编辑
                  </button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- ── Mobile cards ────────────────────────────────────────────────── -->
    <div class="sm:hidden -mx-4 border-t border-stone-100">
      {#each mappings as m}
        {@const meta = getStatusMeta(m.is_active)}
        {@const anomalous = isAnomalous(m.is_active)}
        <div class="relative bg-white border-b border-stone-100 p-3 pl-4 overflow-hidden
          {anomalous ? meta.rowClass : ''}">
          <span class="absolute left-0 top-0 bottom-0 w-[3px] {meta.dotClass}" aria-hidden="true"></span>
          <div class="flex items-center gap-2">
            <span class="font-mono font-bold text-sm tabular-nums text-stone-700 shrink-0 w-6 text-right">
              {formatCardNumber(m.sim_index)}
            </span>
            <span class="font-mono text-sm text-stone-900 truncate">{m.phone_number || '无号码'}</span>
            <div class="ml-auto flex items-center gap-0.5 shrink-0 -my-1">
              <button onclick={() => openEdit(m)} aria-label="编辑"
                class="p-1.5 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-lg transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="mt-1 flex items-center gap-2 text-[11px] text-stone-400 font-mono">
            <span class="{meta.badgeClass.includes('red') ? 'text-red-600' : meta.badgeClass.includes('amber') ? 'text-amber-600' : ''}">{meta.label}</span>
            {#if m.carrier}<span>{m.carrier}</span>{/if}
            {#if m.signal_quality != null}<span>· {m.signal_quality}%</span>{/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>


<!-- ═══ Unified add/edit panel ══════════════════════════════════════════════ -->
{#if panel}
  <div class="fixed inset-0 bg-stone-900/40 flex items-center justify-center z-50 p-4"
    onclick={(e) => e.target === e.currentTarget && closePanel()}>
    <div class="bg-white rounded-2xl shadow-modal w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden">

      <!-- Panel header -->
      <div class="px-6 py-4 border-b border-stone-100 flex-shrink-0 flex items-center justify-between">
        <h3 class="font-semibold text-stone-900">
          {panel.mode === 'add' ? '添加映射' : '编辑映射'}
        </h3>
        <button onclick={closePanel} class="text-stone-400 hover:text-stone-700 transition-colors">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <!-- Edit mode: read-only identity bar -->
      {#if panel.mode === 'edit'}
        <div class="px-6 py-3 bg-stone-50 border-b border-stone-100 flex-shrink-0">
          <div class="flex items-center gap-3 text-sm">
            <span class="font-mono font-bold text-lg text-stone-900 tabular-nums">
              {formatCardNumber(panel.mapping.sim_index)}
            </span>
            <span class="text-stone-300">|</span>
            <span class="font-mono text-xs text-stone-500">{panel.mapping.iccid}</span>
            <span class="ml-auto">
              <span class="inline-flex px-2 py-0.5 text-[11px] rounded-md font-medium border
                {getStatusMeta(panel.mapping.is_active).badgeClass}">
                {getStatusMeta(panel.mapping.is_active).label}
              </span>
            </span>
          </div>
          {#if panel.mapping.equipment_id}
            <div class="mt-1 text-xs text-stone-400 font-mono">
              IMEI {panel.mapping.equipment_id}
              {#if panel.mapping.signal_quality != null} · 信号 {panel.mapping.signal_quality}%{/if}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Form body -->
      <div class="px-6 py-4 overflow-y-auto flex-1 min-h-0">
        {#if error && panel}
          <div class="mb-3 px-3 py-2 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>
        {/if}

        <div class="grid grid-cols-2 gap-3">

          <!-- Add mode: ICCID (free-entry, since we don't have unassigned-card list from daemon) -->
          {#if panel.mode === 'add'}
            <div class="col-span-2">
              <label class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase">ICCID *</label>
              <input type="text" bind:value={panel.formData.iccid}
                placeholder="89650…（19位）"
                class="w-full px-3 py-2 text-sm font-mono border border-stone-300 rounded-lg
                  focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100" />
            </div>
          {/if}

          <!-- 卡号 / sim_index — stays editable; collision warning shown -->
          <div class="col-span-2 sm:col-span-1">
            <label class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase">卡号 (sim_index)</label>
            <input type="number" bind:value={panel.formData.sim_index}
              placeholder="1–95" min="1" max="95"
              class="w-full px-3 py-2 text-sm font-mono border rounded-lg
                focus:outline-none focus:ring-2 transition-colors
                {simIndexConflict
                  ? 'border-amber-400 focus:border-amber-500 focus:ring-amber-100 bg-amber-50'
                  : 'border-stone-300 focus:border-orange-400 focus:ring-orange-100'}" />
            {#if simIndexConflict}
              <p class="mt-1 text-xs text-amber-700">
                ⚠ 卡号 {panel.formData.sim_index} 已被 {simIndexConflict.phone_number || simIndexConflict.iccid} 占用
              </p>
            {/if}
          </div>

          <!-- 手机号 -->
          <div class="col-span-2 sm:col-span-1">
            <label class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase">手机号 *</label>
            <input type="tel" bind:value={panel.formData.phone_number}
              placeholder="+65 …"
              class="w-full px-3 py-2 text-sm font-mono border border-stone-300 rounded-lg
                focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100" />
          </div>

          <!-- 国家 -->
          <div>
            <label class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase">国家 *</label>
            <select bind:value={panel.formData.country}
              class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white
                focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100">
              <option value="">选择…</option>
              {#each COUNTRIES as c}
                <option value={c.code}>{c.flag} {c.name}</option>
              {/each}
            </select>
          </div>

          <!-- 运营商 -->
          <div>
            <label class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase">运营商</label>
            <input type="text" bind:value={panel.formData.carrier}
              placeholder="Singtel / 中国移动…"
              class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg
                focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100" />
          </div>

          <!-- IMEI — read-only in edit, editable in add -->
          <div class="col-span-2">
            <label class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase">
              IMEI
              {#if panel.mode === 'edit'}
                <span class="ml-1 text-stone-300 font-normal normal-case">(由守护进程绑定)</span>
              {/if}
            </label>
            <div class="relative">
              <input type="text" bind:value={panel.formData.imei}
                readonly={panel.mode === 'edit'}
                placeholder={panel.mode === 'add' ? '可选' : ''}
                class="w-full px-3 py-2 text-sm font-mono border rounded-lg transition-colors
                  {panel.mode === 'edit'
                    ? 'bg-stone-50 border-stone-200 text-stone-400 cursor-default'
                    : 'border-stone-300 focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100'}" />
              {#if panel.mode === 'edit'}
                <svg class="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                </svg>
              {/if}
            </div>
          </div>

          <!-- 备注 -->
          <div class="col-span-2">
            <label class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase">备注（可选）</label>
            <textarea bind:value={panel.formData.description} rows="2"
              placeholder="用途、标注等"
              class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg resize-none
                focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"></textarea>
          </div>
        </div>
      </div>

      <!-- Panel footer -->
      <div class="px-6 py-4 border-t border-stone-100 flex-shrink-0">

        <!-- Edit mode: delete zone -->
        {#if panel.mode === 'edit'}
          <div class="mb-4 pt-3 border-t border-stone-100">
            <p class="text-xs text-stone-400 mb-2">
              删除此映射后，卡还在槽里，但收到的短信将不再归属号码。已收到的历史短信保留。
            </p>
            <button onclick={() => handleDelete(panel.mapping.id)}
              class="text-sm text-red-600 font-medium border border-red-200 rounded-lg px-3 py-1.5
                hover:bg-red-50 transition-colors">
              删除映射
            </button>
          </div>
        {/if}

        <div class="flex items-center justify-end gap-3">
          <button onclick={closePanel}
            class="px-4 py-2 text-sm text-stone-600 border border-stone-200 rounded-lg
              hover:bg-stone-50 transition-colors">
            取消
          </button>
          <button onclick={handleSave}
            disabled={!panel.formData.phone_number || !panel.formData.sim_index ||
              (panel.mode === 'add' && !panel.formData.iccid)}
            class="px-4 py-2 text-sm font-medium bg-stone-800 text-white rounded-lg
              hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {panel.mode === 'add' ? '添加映射' : '保存'}
          </button>
        </div>
      </div>

    </div>
  </div>
{/if}
