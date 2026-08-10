<script>
  import { onMount } from "svelte";
  import { api } from "./api";
  import { COUNTRIES, getCountryFlag, getCountryName, getCarrierColor } from "./countries.js";

  let allMappingsCache = $state([]);
  let mappings = $state([]);
  let loading = $state(false);
  let error = $state(null);
  let showAddForm = $state(false);
  let showEditForm = $state(false);
  let editingMapping = $state(null);
  let searchQuery = $state("");
  let { initialStatusFilter = "all" } = $props();
  let statusFilter = $state(initialStatusFilter);
  // Re-sync the local status filter when the parent passes a new one. The legacy
  // version used a reactive `$: if (...)` block that also called filterMappings();
  // an $effect tracks the same dependency and runs the same side effect.
  $effect(() => {
    if (initialStatusFilter !== statusFilter && initialStatusFilter !== "all") {
      statusFilter = initialStatusFilter;
      filterMappings();
    }
  });
  let successMessage = $state(null);

  // Single definition of how a mapping's is_active maps to what the user sees.
  // Previously the label and the badge colours were written out twice — once in the
  // desktop table and once in the mobile card — so adding the mobile status bar
  // would have made a third copy to keep in sync.
  //
  // Colours are the exact ones the badges already used, so nothing changes visually.
  //
  // These MUST stay complete literal class names: Tailwind finds classes by scanning
  // source text, so a template like `bg-${c}-500` would compile to nothing.
  // `tone` is the mobile card's text colour and is deliberately NOT the badge colour.
  // A healthy row stays grey: most of the 95 SIMs are fine, so colouring every one of
  // them green makes green meaningless and the list impossible to scan. Only a state
  // that needs attention is tinted, so the eye lands on problems.
  const STATUS_META = {
    active:         { label: '活动',        badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', bar: 'bg-emerald-500', text: 'text-emerald-700', tone: 'text-stone-500' },
    offline:        { label: '离线',        badge: 'bg-stone-100 text-stone-500 border-stone-200',      bar: 'bg-stone-300',   text: 'text-stone-500',   tone: 'text-stone-500' },
    sim_error:      { label: 'SIM错误',     badge: 'bg-red-50 text-red-600 border-red-200',             bar: 'bg-red-500',     text: 'text-red-600',     tone: 'text-red-600'   },
    iccid_mismatch: { label: 'ICCID不匹配', badge: 'bg-amber-50 text-amber-700 border-amber-200',       bar: 'bg-amber-500',   text: 'text-amber-700',   tone: 'text-amber-700' },
    no_modem:       { label: '无设备',      badge: 'bg-stone-50 text-stone-400 border-stone-200',       bar: 'bg-stone-200',   text: 'text-stone-400',   tone: 'text-stone-400' },
  };
  const STATUS_UNASSIGNED = { label: '未分配', badge: 'bg-stone-50 text-stone-400 border-stone-200', bar: 'bg-stone-200', text: 'text-stone-400', tone: 'text-stone-400' };

  function statusMeta(status) {
    return STATUS_META[status] ?? STATUS_UNASSIGNED;
  }

  // Computed stats (6-state: active, offline, sim_error, iccid_mismatch, no_modem, unassigned)
  let activeCount = $derived(allMappingsCache.filter(m => m.is_active === 'active').length);
  let errorCount = $derived(allMappingsCache.filter(m => ['sim_error', 'iccid_mismatch', 'offline'].includes(m.is_active)).length);
  let inactiveCount = $derived(allMappingsCache.filter(m => ['no_modem', 'unassigned'].includes(m.is_active) || !m.is_active).length);
  let totalCount = $derived(allMappingsCache.length);

  // Form data
  let formData = $state({
    iccid: "",
    phone_number: "",
    carrier: "",
    country: "",
    description: "",
    sim_index: "",
    imei: "",
  });

  async function loadMappings() {
    loading = true;
    error = null;

    try {
      const response = await api.iccidMappings.list({
        page: 1,
        limit: 10000,
      });

      if (response && response.success) {
        if (response.data && response.data.results) {
          allMappingsCache = response.data.results || [];
        } else {
          allMappingsCache = response.data || [];
        }
        filterMappings();
      } else {
        error = response?.error || "Failed to load ICCID mappings";
      }
    } catch (err) {
      error = err.message || "Failed to load ICCID mappings";
    } finally {
      loading = false;
    }
  }

  function filterMappings() {
    let filtered = allMappingsCache;

    // Filter by status
    if (statusFilter === "active") {
      filtered = filtered.filter(m => m.is_active === 'active');
    } else if (statusFilter === "error") {
      filtered = filtered.filter(m => ['sim_error', 'iccid_mismatch', 'offline'].includes(m.is_active));
    } else if (statusFilter === "inactive") {
      filtered = filtered.filter(m => ['no_modem', 'unassigned'].includes(m.is_active) || !m.is_active);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter((m) =>
        (m.iccid || "").toLowerCase().includes(q) ||
        (m.phone_number || "").toLowerCase().includes(q) ||
        (m.carrier || "").toLowerCase().includes(q) ||
        (m.equipment_id || "").toLowerCase().includes(q) ||
        (m.usb_path || "").toLowerCase().includes(q) ||
        (m.notes || m.description || "").toLowerCase().includes(q)
      );
    }

    mappings = filtered;
  }

  async function handleAddMapping() {
    try {
      const response = await api.iccidMappings.create(formData);

      if (response.success) {
        showAddForm = false;
        resetForm();
        await loadMappings();
      } else {
        error = response.error || "Failed to add mapping";
      }
    } catch (err) {
      error = err.message;
    }
  }

  async function handleEditMapping() {
    try {
      const response = await api.iccidMappings.update(editingMapping.id, {
        phone_number: formData.phone_number,
        carrier: formData.carrier,
        country: formData.country,
        description: formData.description,
        sim_index: formData.sim_index,
        imei: formData.imei,
      });

      if (response.success) {
        showEditForm = false;
        resetForm();
        await loadMappings();
      } else {
        error = response.error || "Failed to update mapping";
      }
    } catch (err) {
      error = err.message;
    }
  }

  async function handleDeleteMapping(id) {
    if (!confirm("Are you sure you want to delete this mapping?")) {
      return;
    }

    try {
      const response = await api.iccidMappings.delete(id);

      if (response.success) {
        await loadMappings();
      } else {
        error = response.error || "Failed to delete mapping";
      }
    } catch (err) {
      error = err.message;
    }
  }

  function startEdit(mapping) {
    editingMapping = mapping;
    formData = {
      iccid: mapping.iccid,
      phone_number: mapping.phone_number,
      carrier: mapping.carrier || "",
      country: mapping.country || "",
      description: mapping.notes || mapping.description || "",
      sim_index: mapping.sim_index || "",
      imei: mapping.equipment_id || "",
    };
    showEditForm = true;
  }

  function resetForm() {
    formData = {
      iccid: "",
      phone_number: "",
      carrier: "",
      country: "",
      description: "",
      sim_index: "",
      imei: "",
    };
    editingMapping = null;
  }

  // Re-filter whenever the search box or status filter changes. The `undefined`
  // guards are vestigial; left in to preserve the original trigger surface.
  $effect(() => {
    if (searchQuery !== undefined || statusFilter !== undefined) filterMappings();
  });

  onMount(() => {
    loadMappings();
  });
</script>

<div class="tech-card p-4 sm:p-6">
  <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
    <h2 class="text-xl sm:text-2xl font-bold data-value high-contrast header-effect-target">ICCID 映射管理</h2>
    <div class="flex gap-2 w-full sm:w-auto">
      <button
        onclick={() => (showAddForm = true)}
        class="w-full sm:w-auto px-4 py-2 tech-button transition-all duration-300"
      >
        添加映射
      </button>
    </div>
  </div>

  <!-- Filter and Search Bar -->
  <div class="mb-4 flex flex-col sm:flex-row gap-2">
    <div class="flex flex-wrap gap-2">
      <button
        onclick={() => statusFilter = "all"}
        class="px-3 sm:px-4 py-2 text-sm sm:text-base rounded-lg transition-colors whitespace-nowrap {statusFilter === 'all' ? 'bg-stone-800 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}"
      >
        全部 ({totalCount})
      </button>
      <button
        onclick={() => statusFilter = "active"}
        class="px-3 sm:px-4 py-2 text-sm sm:text-base rounded-lg transition-colors whitespace-nowrap {statusFilter === 'active' ? 'bg-green-600 text-white' : 'bg-green-50 text-green-600 hover:bg-green-100'}"
      >
        活动 ({activeCount})
      </button>
      <button
        onclick={() => statusFilter = "error"}
        class="px-3 sm:px-4 py-2 text-sm sm:text-base rounded-lg transition-colors whitespace-nowrap {statusFilter === 'error' ? 'bg-amber-600 text-white' : 'bg-amber-50 text-amber-600 hover:bg-amber-100'}"
      >
        异常 ({errorCount})
      </button>
      <button
        onclick={() => statusFilter = "inactive"}
        class="px-3 sm:px-4 py-2 text-sm sm:text-base rounded-lg transition-colors whitespace-nowrap {statusFilter === 'inactive' ? 'bg-stone-500 text-white' : 'bg-stone-50 text-stone-500 hover:bg-stone-100'}"
      >
        未激活 ({inactiveCount})
      </button>
    </div>
    <input
      type="text"
      bind:value={searchQuery}
      placeholder="搜索 ICCID、手机号、运营商..."
      class="flex-1 px-4 py-2 cyber-input w-full"
    />
  </div>

  {#if successMessage}
    <div class="mb-4 p-4 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-lg flex items-center justify-between">
      <span>✓ {successMessage}</span>
      <button onclick={() => { successMessage = null; }} class="text-emerald-400 hover:text-emerald-600">&times;</button>
    </div>
  {/if}

  {#if error}
    <div
      class="mb-4 p-4 bg-red-50 border border-red-200 text-red-600 rounded-lg"
    >
      {error}
    </div>
  {/if}

  {#if loading}
    <div class="text-center py-8">
      <div
        class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-stone-500"
      ></div>
      <p class="mt-2 text-stone-500">加载中...</p>
    </div>
  {:else if error}
    <div class="text-center py-8">
      <p class="text-red-500 mb-4">❌ {error}</p>
      <button
        onclick={loadMappings}
        class="px-4 py-2 tech-button"
      >
        重试
      </button>
    </div>
  {:else}
    <!-- Mappings Table (Desktop) -->
    <div class="hidden sm:block overflow-x-auto">
      {#if mappings.length === 0}
        <div class="text-center py-16">
          <p class="text-stone-500 mb-4">暂无 ICCID 映射数据</p>
          <p class="text-stone-800/60 text-sm">点击上方"添加映射"按钮创建第一个映射</p>
        </div>
      {:else}
        <table class="min-w-full">
          <thead>
            <tr class="border-b border-stone-200">
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">SIM#</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">ICCID</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">手机号</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">国家</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">运营商</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">设备ID</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">备注</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">USB 位置</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">Modem</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">信号</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">状态</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-stone-100">
            {#each mappings as mapping}
            <tr class="hover:bg-stone-100 transition-colors">
              <td class="px-4 py-3 text-sm font-semibold text-stone-600">
                {#if mapping.sim_index}
                  <span class="inline-flex items-center justify-center w-8 h-8 rounded-full bg-stone-100 border border-stone-200">
                    {mapping.sim_index}
                  </span>
                {:else}
                  <span class="text-stone-300">-</span>
                {/if}
              </td>
              <td class="px-4 py-3 text-sm font-mono text-stone-800">{mapping.iccid}</td>
              <td class="px-4 py-3 text-sm font-medium text-stone-900"
                >{mapping.phone_number}</td
              >
              <td class="px-4 py-3 text-sm">
                {#if mapping.country}
                  <span class="inline-flex items-center gap-1">
                    <span class="text-lg">{getCountryFlag(mapping.country)}</span>
                    <span class="text-xs text-stone-500">{getCountryName(mapping.country)}</span>
                  </span>
                {:else}
                  <span class="text-stone-500">-</span>
                {/if}
              </td>
              <td class="px-4 py-3 text-sm">
                {#if mapping.carrier}
                  <span class="inline-flex px-2 py-1 text-xs rounded-full font-medium {getCarrierColor(mapping.carrier)}">
                    {mapping.carrier}
                  </span>
                {:else}
                  <span class="text-stone-500">-</span>
                {/if}
              </td>
              <td class="px-4 py-3 text-sm font-mono text-stone-500">
                {#if mapping.equipment_id}
                  <span title={mapping.equipment_id}>{mapping.equipment_id}</span>
                {:else}
                  <span class="text-stone-300">-</span>
                {/if}
              </td>
              <td class="px-4 py-3 text-sm text-stone-800">{mapping.notes || mapping.description || "-"}</td>
              <!-- USB physical path — where the modem is enumerated right now.
                   Server NULLs this when a modem goes disconnected, so a value
                   here always reflects a currently-present device. -->
              <td class="px-4 py-3 text-sm font-mono text-stone-500">
                {#if mapping.usb_path}
                  <span title={mapping.usb_path}>{mapping.usb_path}</span>
                {:else}
                  <span class="text-stone-300">-</span>
                {/if}
              </td>
              <!-- Modem indicator -->
              <td class="px-4 py-3">
                {#if mapping.equipment_id && mapping.modem_status && mapping.modem_status !== 'disconnected'}
                  <span class="inline-flex items-center gap-1 text-xs">
                    <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
                    <span class="text-emerald-700">UP</span>
                  </span>
                {:else if mapping.equipment_id}
                  <span class="inline-flex items-center gap-1 text-xs">
                    <span class="w-2 h-2 rounded-full bg-red-500"></span>
                    <span class="text-red-600">DOWN</span>
                  </span>
                {:else}
                  <span class="text-stone-300 text-xs">—</span>
                {/if}
              </td>
              <!-- Signal -->
              <td class="px-4 py-3">
                {#if mapping.signal_quality != null}
                  <span class="text-xs font-mono {mapping.signal_quality >= 60 ? 'text-emerald-600' : mapping.signal_quality >= 30 ? 'text-amber-600' : 'text-red-600'}">
                    {mapping.signal_quality}%
                  </span>
                {:else}
                  <span class="text-stone-300 text-xs">—</span>
                {/if}
              </td>
              <!-- Summary status badge (6 states) -->
              <td class="px-4 py-3">
                <span class="inline-flex px-2 py-1 text-xs rounded-full border {statusMeta(mapping.is_active).badge}">
                  {statusMeta(mapping.is_active).label}
                </span>
              </td>
              <td class="px-4 py-3 text-sm">
                <button
                  onclick={() => startEdit(mapping)}
                  class="text-stone-500 hover:text-stone-800 mr-3 transition-colors"
                >
                  编辑
                </button>
                <button
                  onclick={() => handleDeleteMapping(mapping.id)}
                  class="text-red-500 hover:text-red-300 transition-colors"
                >
                  删除
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {/if}
    </div>

    <!-- Mappings List (Mobile) -->
    <div class="sm:hidden space-y-3">
      {#if mappings.length === 0}
        <div class="text-center py-12 bg-stone-50 rounded-xl border border-stone-100">
          <p class="text-stone-500 mb-2">暂无 ICCID 映射数据</p>
          <p class="text-stone-800/60 text-xs">点击上方"添加映射"按钮创建第一个映射</p>
        </div>
      {:else}
        {#each mappings as mapping}
          <!--
            Compact 3-line card. The old layout spent 42px of its ~204px on a row that
            held nothing but 编辑/删除, and another ~94px on four "label — value" rows
            whose labels were redundant with their values. Both are gone, so roughly
            twice as many cards fit on a phone screen.

            Status is carried by the 3px left bar rather than a pill in the header:
            a pill plus two icons overflows a 320px screen once the label is as long
            as ICCID不匹配. The bar costs no horizontal space, and the status is still
            spelled out in text on line 2, so it is never colour-only.
          -->
          <div class="relative bg-white border border-stone-200 rounded-xl p-3 pl-4 shadow-sm overflow-hidden">
            <span class="absolute left-0 top-0 bottom-0 w-[3px] {statusMeta(mapping.is_active).bar}" aria-hidden="true"></span>

            <!-- Line 1: identity, then the actions pushed right -->
            <div class="flex items-center gap-2">
              {#if mapping.sim_index}
                <span class="inline-flex items-center justify-center w-6 h-6 shrink-0 text-xs font-bold rounded-full bg-stone-100 border border-stone-200 text-stone-600">
                  {mapping.sim_index}
                </span>
              {/if}
              <span class="font-medium text-stone-900 truncate">{mapping.phone_number || '无号码'}</span>

              <!-- -my-1 lets the 32px tap targets overflow the 24px row instead of
                   growing it, so reach stays usable without costing card height. -->
              <div class="ml-auto flex items-center gap-0.5 shrink-0 -my-1">
                <button
                  onclick={() => startEdit(mapping)}
                  aria-label="编辑 {mapping.phone_number || mapping.iccid}"
                  class="p-2 text-stone-400 hover:text-stone-800 hover:bg-stone-100 rounded-lg transition-colors"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  onclick={() => handleDeleteMapping(mapping.id)}
                  aria-label="删除 {mapping.phone_number || mapping.iccid}"
                  class="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>

            <!--
              One quiet line instead of two busy ones. Everything is grey by default;
              only a status that needs attention, a DOWN modem, or a weak signal gets
              tinted. On a healthy list that means zero colour except the status bars,
              so the few problem rows are the only thing that stands out.
            -->
            <div class="mt-1 flex items-center gap-1.5 text-xs text-stone-500 min-w-0">
              <span class="shrink-0 {statusMeta(mapping.is_active).tone}">{statusMeta(mapping.is_active).label}</span>

              <span class="flex items-center gap-1 min-w-0">
                {#if mapping.country}<span class="shrink-0 opacity-70">{getCountryFlag(mapping.country)}</span>{/if}
                <span class="truncate">{mapping.carrier || '-'}</span>
              </span>

              <!-- Only surface the link when something is wrong with it. A working
                   modem needs no annotation; 活动 already says so. -->
              {#if mapping.equipment_id && mapping.modem_status === 'disconnected'}
                <span class="shrink-0 text-red-600">DOWN</span>
              {:else if mapping.signal_quality != null && mapping.signal_quality < 60}
                <span class="shrink-0 font-mono {mapping.signal_quality >= 30 ? 'text-amber-600' : 'text-red-600'}">{mapping.signal_quality}%</span>
              {/if}

              {#if mapping.usb_path}
                <span class="ml-auto shrink-0 font-mono text-stone-400">{mapping.usb_path}</span>
              {/if}
            </div>

            {#if mapping.notes || mapping.description}
              <div class="mt-2 text-xs text-stone-600 bg-stone-50 px-2 py-1.5 rounded border border-stone-100">
                {mapping.notes || mapping.description}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>

  {/if}
</div>

<!-- Add Mapping Modal -->
{#if showAddForm}
  <div
    class="fixed inset-0 bg-stone-900/50 flex items-center justify-center z-50 p-4"
  >
    <div class="tech-card p-4 sm:p-6 max-w-md w-full max-h-full flex flex-col">
      <h3 class="text-lg font-bold mb-4 data-value high-contrast flex-shrink-0">添加 ICCID 映射</h3>

      <div class="space-y-4 overflow-y-auto flex-1 min-h-0 pr-2">
        <div>
          <label
            for="create-iccid"
            class="block text-sm font-medium text-stone-500 mb-1">ICCID</label
          >
          <input
            id="create-iccid"
            type="text"
            bind:value={formData.iccid}
            placeholder="输入 ICCID"
            class="w-full px-3 py-2 cyber-input"
          />
        </div>

        <div>
          <label
            for="create-phone-number"
            class="block text-sm font-medium text-stone-500 mb-1">手机号</label
          >
          <input
            id="create-phone-number"
            type="text"
            bind:value={formData.phone_number}
            placeholder="输入手机号"
            class="w-full px-3 py-2 cyber-input"
          />
        </div>

        <div>
          <label
            for="create-country"
            class="block text-sm font-medium text-stone-500 mb-1"
            >国家</label
          >
          <select
            id="create-country"
            bind:value={formData.country}
            class="w-full px-3 py-2 cyber-input"
          >
            <option value="">选择国家...</option>
            {#each COUNTRIES as country}
              <option value={country.code}>
                {country.flag} {country.name}
              </option>
            {/each}
          </select>
        </div>

        <div>
          <label
            for="create-carrier"
            class="block text-sm font-medium text-stone-500 mb-1"
            >运营商</label
          >
          <input
            id="create-carrier"
            type="text"
            bind:value={formData.carrier}
            placeholder="例如：中国移动"
            class="w-full px-3 py-2 cyber-input"
          />
        </div>

        <div>
          <label
            for="create-sim-index"
            class="block text-sm font-medium text-stone-500 mb-1"
            >SIM 索引 <span class="text-red-500">*</span></label
          >
          <input
            id="create-sim-index"
            type="number"
            bind:value={formData.sim_index}
            placeholder="1-95"
            min="1"
            max="95"
            required
            class="w-full px-3 py-2 cyber-input"
          />
        </div>

        <div>
          <label
            for="create-imei"
            class="block text-sm font-medium text-stone-500 mb-1"
            >IMEI</label
          >
          <input
            id="create-imei"
            type="text"
            bind:value={formData.imei}
            placeholder="设备 IMEI 号"
            class="w-full px-3 py-2 cyber-input font-mono text-sm"
          />
        </div>

        <div>
          <label
            for="create-description"
            class="block text-sm font-medium text-stone-500 mb-1"
            >描述（可选）</label
          >
          <textarea
            id="create-description"
            bind:value={formData.description}
            placeholder="添加备注信息"
            class="w-full px-3 py-2 cyber-input"
            rows="3"
          ></textarea>
        </div>
      </div>

      <div class="mt-6 flex justify-end gap-3 flex-shrink-0 pt-4 border-t border-stone-100">
        <button
          onclick={() => {
            showAddForm = false;
            resetForm();
          }}
          class="px-4 py-2 border border-stone-300 rounded-lg hover:bg-stone-100 text-stone-500 transition-all duration-300"
        >
          取消
        </button>
        <button
          onclick={handleAddMapping}
          class="px-4 py-2 tech-button transition-all duration-300"
        >
          添加
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Edit Mapping Modal -->
{#if showEditForm}
  <div
    class="fixed inset-0 bg-stone-900/50 flex items-center justify-center z-50 p-4"
  >
    <div class="tech-card p-4 sm:p-6 max-w-md w-full max-h-full flex flex-col">
      <h3 class="text-lg font-bold mb-4 data-value high-contrast flex-shrink-0">编辑 ICCID 映射</h3>

      <div class="space-y-4 overflow-y-auto flex-1 min-h-0 pr-2">
        <div>
          <label
            for="edit-iccid"
            class="block text-sm font-medium text-stone-500 mb-1">ICCID</label
          >
          <input
            id="edit-iccid"
            type="text"
            value={formData.iccid}
            disabled
            class="w-full px-3 py-2 cyber-input bg-stone-50 cursor-not-allowed"
          />
        </div>

        <div>
          <label
            for="edit-phone-number"
            class="block text-sm font-medium text-stone-500 mb-1">手机号</label
          >
          <input
            id="edit-phone-number"
            type="text"
            bind:value={formData.phone_number}
            placeholder="输入手机号"
            class="w-full px-3 py-2 cyber-input"
          />
        </div>

        <div>
          <label
            for="edit-country"
            class="block text-sm font-medium text-stone-500 mb-1"
            >国家</label
          >
          <select
            id="edit-country"
            bind:value={formData.country}
            class="w-full px-3 py-2 cyber-input"
          >
            <option value="">选择国家...</option>
            {#each COUNTRIES as country}
              <option value={country.code}>
                {country.flag} {country.name}
              </option>
            {/each}
          </select>
        </div>

        <div>
          <label
            for="edit-carrier"
            class="block text-sm font-medium text-stone-500 mb-1"
            >运营商</label
          >
          <input
            id="edit-carrier"
            type="text"
            bind:value={formData.carrier}
            placeholder="例如：中国移动"
            class="w-full px-3 py-2 cyber-input"
          />
        </div>

        <div>
          <label
            for="edit-sim-index"
            class="block text-sm font-medium text-stone-500 mb-1"
            >SIM 索引 <span class="text-red-500">*</span></label
          >
          <input
            id="edit-sim-index"
            type="number"
            bind:value={formData.sim_index}
            placeholder="1-95"
            min="1"
            max="95"
            required
            class="w-full px-3 py-2 cyber-input"
          />
        </div>

        <div>
          <label
            for="edit-imei"
            class="block text-sm font-medium text-stone-500 mb-1"
            >IMEI</label
          >
          <input
            id="edit-imei"
            type="text"
            bind:value={formData.imei}
            placeholder="设备 IMEI 号"
            class="w-full px-3 py-2 cyber-input font-mono text-sm"
          />
        </div>

        <div>
          <label
            for="edit-description"
            class="block text-sm font-medium text-stone-500 mb-1"
            >描述（可选）</label
          >
          <textarea
            id="edit-description"
            bind:value={formData.description}
            placeholder="添加备注信息"
            class="w-full px-3 py-2 cyber-input"
            rows="3"
          ></textarea>
        </div>
      </div>

      <div class="mt-6 flex justify-end gap-3 flex-shrink-0 pt-4 border-t border-stone-100">
        <button
          onclick={() => {
            showEditForm = false;
            resetForm();
          }}
          class="px-4 py-2 border border-stone-300 rounded-lg hover:bg-stone-100 text-stone-500 transition-all duration-300"
        >
          取消
        </button>
        <button
          onclick={handleEditMapping}
          class="px-4 py-2 tech-button transition-all duration-300"
        >
          保存
        </button>
      </div>
    </div>
  </div>
{/if}

