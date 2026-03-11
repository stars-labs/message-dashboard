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
  let statusFilter = "all"; // "all", "active", "inactive"
  let successMessage = null;

  // Computed stats
  $: activeCount = allMappingsCache.filter(m => m.is_active === 'active').length;
  $: inactiveCount = allMappingsCache.filter(m => m.is_active === 'inactive' || !m.is_active).length;
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
    } else if (statusFilter === "inactive") {
      filtered = filtered.filter(m => m.is_active === 'inactive' || !m.is_active);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter((m) =>
        (m.iccid || "").toLowerCase().includes(q) ||
        (m.phone_number || "").toLowerCase().includes(q) ||
        (m.carrier || "").toLowerCase().includes(q) ||
        (m.equipment_id || "").toLowerCase().includes(q) ||
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

<div class="tech-card p-6">
  <div class="flex justify-between items-center mb-6">
    <h2 class="text-2xl font-bold data-value high-contrast header-effect-target">ICCID 映射管理</h2>
    <div class="flex gap-2">
      <button
        on:click={() => (showAddForm = true)}
        class="px-4 py-2 tech-button transition-all duration-300"
      >
        添加映射
      </button>
    </div>
  </div>

  <!-- Filter and Search Bar -->
  <div class="mb-4 flex gap-2">
    <button
      on:click={() => statusFilter = "all"}
      class="px-4 py-2 rounded-lg transition-colors whitespace-nowrap {statusFilter === 'all' ? 'bg-stone-800 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}"
    >
      全部 ({totalCount})
    </button>
    <button
      on:click={() => statusFilter = "active"}
      class="px-4 py-2 rounded-lg transition-colors whitespace-nowrap {statusFilter === 'active' ? 'bg-green-600 text-white' : 'bg-green-50 text-green-600 hover:bg-green-100'}"
    >
      活动 ({activeCount})
    </button>
    <button
      on:click={() => statusFilter = "inactive"}
      class="px-4 py-2 rounded-lg transition-colors whitespace-nowrap {statusFilter === 'inactive' ? 'bg-stone-500 text-white' : 'bg-stone-50 text-stone-500 hover:bg-stone-100'}"
    >
      未激活 ({inactiveCount})
    </button>
    <input
      type="text"
      bind:value={searchQuery}
      placeholder="搜索 ICCID、手机号、运营商..."
      class="flex-1 px-4 py-2 cyber-input"
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
    <!-- Mappings Table -->
    <div class="overflow-x-auto">
      {#if mappings.length === 0}
        <div class="text-center py-16">
          <p class="text-stone-500 mb-4">暂无 ICCID 映射数据</p>
          <p class="text-stone-800/60 text-sm">点击上方"添加映射"按钮创建第一个映射</p>
        </div>
      {:else}
        <table class="min-w-full">
          <thead>
            <tr class="border-b border-stone-200">
              <th
                class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider"
                >SIM#</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider"
                >ICCID</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider"
                >手机号</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider"
                >国家</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider"
                >运营商</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider"
                >设备ID</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider"
                >备注</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider"
                >状态</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider"
                >创建时间</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider"
                >操作</th
              >
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
              <td class="px-4 py-3">
                <span
                  class="inline-flex px-2 py-1 text-xs rounded-full {mapping.is_active === 'active'
                    ? 'bg-green-50 text-green-700 border border-green-200'
                    : 'bg-stone-100 text-stone-500 border border-stone-200'}"
                >
                  {mapping.is_active === 'active' ? "活动" : "未激活"}
                </span>
              </td>
              <td class="px-4 py-3 text-sm text-stone-400">
                {new Date(mapping.created_at).toLocaleString()}
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

  {/if}
</div>

<!-- Add Mapping Modal -->
{#if showAddForm}
  <div
    class="fixed inset-0 bg-stone-900/50 flex items-center justify-center z-50"
  >
    <div class="tech-card p-6 max-w-md w-full mx-4">
      <h3 class="text-lg font-bold mb-4 data-value high-contrast">添加 ICCID 映射</h3>

      <div class="space-y-4">
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

      <div class="mt-6 flex justify-end gap-3">
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
    class="fixed inset-0 bg-stone-900/50 flex items-center justify-center z-50"
  >
    <div class="tech-card p-6 max-w-md w-full mx-4">
      <h3 class="text-lg font-bold mb-4 data-value high-contrast">编辑 ICCID 映射</h3>

      <div class="space-y-4">
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

      <div class="mt-6 flex justify-end gap-3">
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

