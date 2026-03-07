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
  let showBulkImport = false;
  let showExportMenu = false;
  let editingMapping = null;
  let searchQuery = "";

  // Form data
  let formData = {
    iccid: "",
    phone_number: "",
    carrier: "",
    country: "",
    description: "",
  };

  // Bulk import data
  let bulkImportText = "";

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
    if (!searchQuery.trim()) {
      mappings = allMappingsCache;
      return;
    }
    const q = searchQuery.trim().toLowerCase();
    mappings = allMappingsCache.filter((m) =>
      (m.iccid || "").toLowerCase().includes(q) ||
      (m.phone_number || "").toLowerCase().includes(q) ||
      (m.carrier || "").toLowerCase().includes(q) ||
      (m.notes || m.description || "").toLowerCase().includes(q)
    );
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
        is_active: formData.is_active,
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

  async function handleBulkImport() {
    try {
      // Parse CSV or JSON format
      let mappingsData = [];

      // Try to parse as JSON first
      try {
        mappingsData = JSON.parse(bulkImportText);
      } catch {
        // Parse as CSV
        const lines = bulkImportText.trim().split("\n");
        const headers = lines[0]
          .toLowerCase()
          .split(",")
          .map((h) => h.trim());

        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(",").map((v) => v.trim());
          const mapping = {};

          headers.forEach((header, index) => {
            mapping[header] = values[index] || "";
          });

          mappingsData.push(mapping);
        }
      }

      const response = await api.iccidMappings.bulkImport({
        mappings: mappingsData,
      });

      if (response.success) {
        showBulkImport = false;
        bulkImportText = "";
        await loadMappings();

        alert(
          `Import complete!\nSuccess: ${response.results.success}\nFailed: ${response.results.failed}`,
        );
      } else {
        error = response.error || "Failed to import mappings";
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
      is_active: mapping.is_active,
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
    };
    editingMapping = null;
  }

  $: if (searchQuery !== undefined) filterMappings();

  onMount(() => {
    loadMappings();
    
    // Close export menu when clicking outside
    const handleClickOutside = (event) => {
      if (showExportMenu && !event.target.closest('.export-menu-container')) {
        showExportMenu = false;
      }
    };
    
    document.addEventListener('click', handleClickOutside);
    
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  });

  // Export functions
  function exportAllMappings(format = 'csv') {
    if (allMappingsCache.length === 0) {
      error = "No mappings to export";
      return;
    }

    if (format === 'csv') {
      exportAsCSV(allMappingsCache);
    } else if (format === 'json') {
      exportAsJSON(allMappingsCache);
    }
  }

  function exportAsCSV(data) {
    // CSV header
    const headers = ['ICCID', 'Phone Number', 'Country', 'Carrier', 'Status', 'Description', 'Created Time', 'Last Used'];
    
    // Convert data to CSV rows
    const rows = data.map(item => [
      item.iccid || '',
      item.phone_number || '',
      getCountryName(item.country) || item.country || '',
      item.carrier || '',
      item.is_active ? '启用' : '停用',
      item.description || '',
      item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : '',
      item.last_used ? new Date(item.last_used).toLocaleString('zh-CN') : ''
    ]);
    
    // Combine headers and rows
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(','))
    ].join('\n');
    
    // Create download
    const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `iccid_mappings_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function exportAsJSON(data) {
    // Format data for JSON export
    const exportData = data.map(item => ({
      iccid: item.iccid,
      phone_number: item.phone_number,
      country: item.country,
      country_name: getCountryName(item.country),
      carrier: item.carrier,
      is_active: item.is_active,
      description: item.description,
      created_at: item.created_at,
      last_used: item.last_used
    }));
    
    const jsonContent = JSON.stringify(exportData, null, 2);
    
    // Create download
    const blob = new Blob([jsonContent], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `iccid_mappings_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
</script>

<div class="tech-card p-6">
  <div class="flex justify-between items-center mb-6">
    <h2 class="text-2xl font-bold data-value high-contrast header-effect-target">ICCID 映射管理</h2>
    <div class="flex gap-2">
      <!-- Export button with dropdown -->
      <div class="relative export-menu-container">
        <button
          on:click={() => (showExportMenu = !showExportMenu)}
          class="px-4 py-2 tech-button transition-all duration-300 flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
          </svg>
          导出
        </button>
        {#if showExportMenu}
          <div class="absolute right-0 mt-2 w-48 bg-white border border-stone-200 rounded-xl shadow-lg z-50 overflow-hidden">
            <button
              on:click={() => {
                exportAllMappings('csv');
                showExportMenu = false;
              }}
              class="w-full px-4 py-2.5 text-left text-sm text-stone-700 hover:bg-stone-50 transition-colors"
            >
              导出为 CSV
            </button>
            <button
              on:click={() => {
                exportAllMappings('json');
                showExportMenu = false;
              }}
              class="w-full px-4 py-2.5 text-left text-sm text-stone-700 hover:bg-stone-50 border-t border-stone-100 transition-colors"
            >
              导出为 JSON
            </button>
          </div>
        {/if}
      </div>
      <button
        on:click={() => (showBulkImport = true)}
        class="px-4 py-2 tech-button transition-all duration-300"
      >
        批量导入
      </button>
      <button
        on:click={() => (showAddForm = true)}
        class="px-4 py-2 tech-button transition-all duration-300"
      >
        添加映射
      </button>
    </div>
  </div>

  <!-- Search Bar -->
  <div class="mb-4">
    <input
      type="text"
      bind:value={searchQuery}
      placeholder="搜索 ICCID、手机号、运营商..."
      class="w-full px-4 py-2 cyber-input"
    />
  </div>

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
                >描述</th
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
              <td class="px-4 py-3 text-sm text-stone-800">{mapping.notes || mapping.description || "-"}</td>
              <td class="px-4 py-3">
                <span
                  class="inline-flex px-2 py-1 text-xs rounded-full {mapping.is_active
                    ? 'bg-green-50 text-green-700 border border-green-200'
                    : 'bg-stone-100 text-stone-500 border border-stone-200'}"
                >
                  {mapping.is_active ? "启用" : "禁用"}
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
            >运营商（可选）</label
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
            >运营商（可选）</label
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

        <div>
          <label class="flex items-center">
            <input
              type="checkbox"
              bind:checked={formData.is_active}
              class="mr-2"
            />
            <span class="text-sm font-medium text-stone-500">启用状态</span>
          </label>
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

<!-- Bulk Import Modal -->
{#if showBulkImport}
  <div
    class="fixed inset-0 bg-stone-900/50 flex items-center justify-center z-50"
  >
    <div class="tech-card p-6 max-w-2xl w-full mx-4">
      <h3 class="text-lg font-bold mb-4 data-value high-contrast">批量导入 ICCID 映射</h3>

      <div class="mb-4">
        <p class="text-sm text-stone-400 mb-2">
          支持 CSV 或 JSON 格式。CSV
          格式第一行应为标题行：iccid,phone_number,country,carrier,description
        </p>
        <p class="text-sm text-stone-400">
          JSON 格式示例：<code
            class="text-stone-800">[{JSON.stringify({
              iccid: "123456",
              phone_number: "13800138000",
              country: "CN",
              carrier: "中国移动",
            })}]</code
          >
        </p>
        <p class="text-sm text-stone-400 mt-1">
          国家代码：CN=中国, HK=香港, SG=新加坡, US=美国, UK=英国, JP=日本等
        </p>
      </div>

      <textarea
        bind:value={bulkImportText}
        placeholder="粘贴 CSV 或 JSON 数据..."
        class="w-full px-3 py-2 cyber-input"
        rows="10"
      ></textarea>

      <div class="mt-6 flex justify-end gap-3">
        <button
          on:click={() => {
            showBulkImport = false;
            bulkImportText = "";
          }}
          class="px-4 py-2 border border-stone-300 rounded-lg hover:bg-stone-100 text-stone-500 transition-all duration-300"
        >
          取消
        </button>
        <button
          on:click={handleBulkImport}
          class="px-4 py-2 tech-button transition-all duration-300"
        >
          导入
        </button>
      </div>
    </div>
  </div>
{/if}
