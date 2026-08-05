<script>
  import { onMount } from "svelte";
  import { api } from "./api";
  import { COUNTRIES, getCountryFlag, getCountryName, getCarrierColor } from "./countries.js";

  let allMappingsCache = [];
  let mappings = [];
  let loading = false;
  let error = null;
  let showAddForm = false;
  let showEditForm = false;
  let editingMapping = null;
  let searchQuery = "";
  export let initialStatusFilter = "all";
  let statusFilter = initialStatusFilter;
  $: if (initialStatusFilter !== statusFilter && initialStatusFilter !== "all") {
    statusFilter = initialStatusFilter;
    filterMappings();
  }
  let successMessage = null;

  // Computed stats (6-state: active, offline, sim_error, iccid_mismatch, no_modem, unassigned)
  $: activeCount = allMappingsCache.filter(m => m.is_active === 'active').length;
  $: errorCount = allMappingsCache.filter(m => ['sim_error', 'iccid_mismatch', 'offline'].includes(m.is_active)).length;
  $: inactiveCount = allMappingsCache.filter(m => ['no_modem', 'unassigned'].includes(m.is_active) || !m.is_active).length;
  $: totalCount = allMappingsCache.length;

  // Form data
  let formData = {
    iccid: "",
    phone_number: "",
    carrier: "",
    country: "",
    description: "",
    sim_index: "",
    imei: "",
  };

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

  $: if (searchQuery !== undefined || statusFilter !== undefined) filterMappings();

  onMount(() => {
    loadMappings();
  });
</script>

<div class="tech-card p-4 sm:p-6">
  <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
    <h2 class="text-xl sm:text-2xl font-bold data-value high-contrast header-effect-target">ICCID 映射管理</h2>
    <div class="flex gap-2 w-full sm:w-auto">
      <button
        on:click={() => (showAddForm = true)}
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
        on:click={() => statusFilter = "all"}
        class="px-3 sm:px-4 py-2 text-sm sm:text-base rounded-lg transition-colors whitespace-nowrap {statusFilter === 'all' ? 'bg-stone-800 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}"
      >
        全部 ({totalCount})
      </button>
      <button
        on:click={() => statusFilter = "active"}
        class="px-3 sm:px-4 py-2 text-sm sm:text-base rounded-lg transition-colors whitespace-nowrap {statusFilter === 'active' ? 'bg-green-600 text-white' : 'bg-green-50 text-green-600 hover:bg-green-100'}"
      >
        活动 ({activeCount})
      </button>
      <button
        on:click={() => statusFilter = "error"}
        class="px-3 sm:px-4 py-2 text-sm sm:text-base rounded-lg transition-colors whitespace-nowrap {statusFilter === 'error' ? 'bg-amber-600 text-white' : 'bg-amber-50 text-amber-600 hover:bg-amber-100'}"
      >
        异常 ({errorCount})
      </button>
      <button
        on:click={() => statusFilter = "inactive"}
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
      <button on:click={() => { successMessage = null; }} class="text-emerald-400 hover:text-emerald-600">&times;</button>
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
        on:click={loadMappings}
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
                <span
                  class="inline-flex px-2 py-1 text-xs rounded-full {
                    mapping.is_active === 'active'
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : mapping.is_active === 'offline'
                        ? 'bg-stone-100 text-stone-500 border border-stone-200'
                        : mapping.is_active === 'sim_error'
                          ? 'bg-red-50 text-red-600 border border-red-200'
                          : mapping.is_active === 'iccid_mismatch'
                            ? 'bg-amber-50 text-amber-700 border border-amber-200'
                            : 'bg-stone-50 text-stone-400 border border-stone-200'
                  }"
                >
                  {mapping.is_active === 'active' ? '活动'
                    : mapping.is_active === 'offline' ? '离线'
                    : mapping.is_active === 'sim_error' ? 'SIM错误'
                    : mapping.is_active === 'iccid_mismatch' ? 'ICCID不匹配'
                    : mapping.is_active === 'no_modem' ? '无设备'
                    : '未分配'}
                </span>
              </td>
              <td class="px-4 py-3 text-sm">
                <button
                  on:click={() => startEdit(mapping)}
                  class="text-stone-500 hover:text-stone-800 mr-3 transition-colors"
                >
                  编辑
                </button>
                <button
                  on:click={() => handleDeleteMapping(mapping.id)}
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
          <div class="bg-white border border-stone-200 rounded-xl p-4 shadow-sm">
            <div class="flex justify-between items-start mb-3">
              <div class="flex items-center gap-2">
                {#if mapping.sim_index}
                  <span class="inline-flex items-center justify-center w-6 h-6 text-xs font-bold rounded-full bg-stone-100 border border-stone-200 text-stone-600">
                    {mapping.sim_index}
                  </span>
                {/if}
                <span class="font-medium text-stone-900">{mapping.phone_number || '无号码'}</span>
              </div>
              <span
                class="inline-flex px-2 py-0.5 text-[10px] font-medium rounded-full {
                  mapping.is_active === 'active'
                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    : mapping.is_active === 'offline'
                      ? 'bg-stone-100 text-stone-500 border border-stone-200'
                      : mapping.is_active === 'sim_error'
                        ? 'bg-red-50 text-red-600 border border-red-200'
                        : mapping.is_active === 'iccid_mismatch'
                          ? 'bg-amber-50 text-amber-700 border border-amber-200'
                          : 'bg-stone-50 text-stone-400 border border-stone-200'
                }"
              >
                {mapping.is_active === 'active' ? '活动'
                  : mapping.is_active === 'offline' ? '离线'
                  : mapping.is_active === 'sim_error' ? 'SIM错误'
                  : mapping.is_active === 'iccid_mismatch' ? 'ICCID不匹配'
                  : mapping.is_active === 'no_modem' ? '无设备'
                  : '未分配'}
              </span>
            </div>
            
            <div class="space-y-1.5 mb-3">
              <div class="flex items-center justify-between text-xs">
                <span class="text-stone-500">ICCID</span>
                <span class="font-mono text-stone-800">{mapping.iccid ? (mapping.iccid.length > 10 ? mapping.iccid.substring(0, 6) + '...' + mapping.iccid.substring(mapping.iccid.length - 4) : mapping.iccid) : '-'}</span>
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-stone-500">国家/运营商</span>
                <div class="flex items-center gap-1">
                  {#if mapping.country}
                    <span>{getCountryFlag(mapping.country)}</span>
                  {/if}
                  <span class="text-stone-800">{mapping.carrier || '-'}</span>
                </div>
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-stone-500">Modem/信号</span>
                <div class="flex items-center gap-2">
                  {#if mapping.equipment_id && mapping.modem_status && mapping.modem_status !== 'disconnected'}
                    <span class="inline-flex items-center gap-1">
                      <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                      <span class="text-emerald-700">UP</span>
                    </span>
                  {:else if mapping.equipment_id}
                    <span class="inline-flex items-center gap-1">
                      <span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                      <span class="text-red-600">DOWN</span>
                    </span>
                  {:else}
                    <span class="text-stone-300">—</span>
                  {/if}
                  {#if mapping.signal_quality != null}
                    <span class="font-mono {mapping.signal_quality >= 60 ? 'text-emerald-600' : mapping.signal_quality >= 30 ? 'text-amber-600' : 'text-red-600'}">
                      {mapping.signal_quality}%
                    </span>
                  {/if}
                </div>
              </div>
              {#if mapping.usb_path}
                <div class="flex items-center justify-between text-xs">
                  <span class="text-stone-500">USB 位置</span>
                  <span class="font-mono text-stone-800">{mapping.usb_path}</span>
                </div>
              {/if}
              {#if mapping.notes || mapping.description}
                <div class="text-xs text-stone-600 bg-stone-50 p-2 rounded border border-stone-100 mt-2">
                  {mapping.notes || mapping.description}
                </div>
              {/if}
            </div>
            
            <div class="flex justify-end gap-3 pt-3 border-t border-stone-100">
              <button
                on:click={() => startEdit(mapping)}
                class="text-xs font-medium text-stone-600 hover:text-stone-900 px-3 py-1.5 bg-stone-100 hover:bg-stone-200 rounded-md transition-colors"
              >
                编辑
              </button>
              <button
                on:click={() => handleDeleteMapping(mapping.id)}
                class="text-xs font-medium text-red-600 hover:text-red-700 px-3 py-1.5 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
              >
                删除
              </button>
            </div>
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
          on:click={() => {
            showAddForm = false;
            resetForm();
          }}
          class="px-4 py-2 border border-stone-300 rounded-lg hover:bg-stone-100 text-stone-500 transition-all duration-300"
        >
          取消
        </button>
        <button
          on:click={handleAddMapping}
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
          on:click={() => {
            showEditForm = false;
            resetForm();
          }}
          class="px-4 py-2 border border-stone-300 rounded-lg hover:bg-stone-100 text-stone-500 transition-all duration-300"
        >
          取消
        </button>
        <button
          on:click={handleEditMapping}
          class="px-4 py-2 tech-button transition-all duration-300"
        >
          保存
        </button>
      </div>
    </div>
  </div>
{/if}

