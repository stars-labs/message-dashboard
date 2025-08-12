<script>
  import { onMount } from "svelte";
  import { api } from "./api";

  let mappings = [];
  let loading = false;
  let error = null;
  let showAddForm = false;
  let showEditForm = false;
  let showBulkImport = false;
  let editingMapping = null;
  let searchQuery = "";
  let currentPage = 1;
  let totalPages = 1;

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
    console.debug("[IccidMappings] Loading mappings...");
    loading = true;
    error = null;

    try {
      console.debug("[IccidMappings] Calling API with params:", {
        page: currentPage,
        search: searchQuery,
      });
      
      const response = await api.iccidMappings.list({
        page: currentPage,
        search: searchQuery,
      });

      console.debug("[IccidMappings] API response:", response);

      if (response && response.success) {
        // Handle D1 response format
        if (response.data && response.data.results) {
          mappings = response.data.results || [];
        } else {
          mappings = response.data || [];
        }
        totalPages = response.pagination?.totalPages || 1;
        console.debug("[IccidMappings] Loaded mappings:", mappings);
      } else {
        error = response?.error || "Failed to load ICCID mappings";
        console.error("ICCID mappings API error:", response);
      }
    } catch (err) {
      error = err.message || "Failed to load ICCID mappings";
      console.error("Failed to load ICCID mappings:", err);
    } finally {
      loading = false;
    }
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

  function handleSearch() {
    currentPage = 1;
    loadMappings();
  }

  onMount(() => {
    console.debug("[IccidMappings] Component mounted!");
    loadMappings();
  });

  // Country list with flags
  const countries = [
    { code: "CN", name: "中国", flag: "🇨🇳" },
    { code: "HK", name: "香港", flag: "🇭🇰" },
    { code: "SG", name: "新加坡", flag: "🇸🇬" },
    { code: "US", name: "美国", flag: "🇺🇸" },
    { code: "UK", name: "英国", flag: "🇬🇧" },
    { code: "JP", name: "日本", flag: "🇯🇵" },
    { code: "KR", name: "韩国", flag: "🇰🇷" },
    { code: "MY", name: "马来西亚", flag: "🇲🇾" },
    { code: "TH", name: "泰国", flag: "🇹🇭" },
    { code: "VN", name: "越南", flag: "🇻🇳" },
    { code: "PH", name: "菲律宾", flag: "🇵🇭" },
    { code: "ID", name: "印度尼西亚", flag: "🇮🇩" },
    { code: "IN", name: "印度", flag: "🇮🇳" },
    { code: "AU", name: "澳大利亚", flag: "🇦🇺" },
    { code: "NZ", name: "新西兰", flag: "🇳🇿" },
    { code: "CA", name: "加拿大", flag: "🇨🇦" },
    { code: "DE", name: "德国", flag: "🇩🇪" },
    { code: "FR", name: "法国", flag: "🇫🇷" },
    { code: "IT", name: "意大利", flag: "🇮🇹" },
    { code: "ES", name: "西班牙", flag: "🇪🇸" },
    { code: "RU", name: "俄罗斯", flag: "🇷🇺" },
    { code: "BR", name: "巴西", flag: "🇧🇷" },
    { code: "MX", name: "墨西哥", flag: "🇲🇽" },
  ];

  function getCountryFlag(countryCode) {
    const country = countries.find(c => c.code === countryCode);
    return country ? country.flag : "🌍";
  }

  function getCountryName(countryCode) {
    const country = countries.find(c => c.code === countryCode);
    return country ? country.name : countryCode || "";
  }

  // Function to get carrier color class
  function getCarrierColor(carrier) {
    if (!carrier) return "";
    
    const carrierUpper = carrier.toUpperCase();
    
    // Common carrier mappings (dark theme)
    if (carrierUpper.includes("CMCC") || carrierUpper.includes("中国移动") || carrierUpper.includes("CHINA MOBILE")) {
      return "bg-blue-900/50 text-blue-300 border border-blue-500/30";
    }
    if (carrierUpper.includes("UNICOM") || carrierUpper.includes("中国联通") || carrierUpper.includes("CHINA UNICOM")) {
      return "bg-orange-900/50 text-orange-300 border border-orange-500/30";
    }
    if (carrierUpper.includes("TELECOM") || carrierUpper.includes("中国电信") || carrierUpper.includes("CHINA TELECOM")) {
      return "bg-red-900/50 text-red-300 border border-red-500/30";
    }
    if (carrierUpper.includes("CMHK") || carrierUpper.includes("香港移动")) {
      return "bg-purple-900/50 text-purple-300 border border-purple-500/30";
    }
    if (carrierUpper.includes("SINGTEL")) {
      return "bg-teal-900/50 text-teal-300 border border-teal-500/30";
    }
    if (carrierUpper.includes("STARHUB")) {
      return "bg-indigo-900/50 text-indigo-300 border border-indigo-500/30";
    }
    if (carrierUpper.includes("M1") || carrierUpper.includes("SGP-M1")) {
      return "bg-green-900/50 text-green-300 border border-green-500/30";
    }
    
    // Default color for unknown carriers
    return "bg-gray-900/50 text-gray-300 border border-gray-500/30";
  }
</script>

{console.debug("[IccidMappings] Component rendering")}
<div class="tech-card p-6">
  <div class="flex justify-between items-center mb-6">
    <h2 class="text-2xl font-bold data-value high-contrast header-effect-target">ICCID 映射管理</h2>
    <div class="flex gap-2">
      <button
        on:click={() => (showBulkImport = true)}
        class="px-4 py-2 tech-button bg-gray-900/80 hover:bg-gray-800/90 transition-all duration-300"
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
    <div class="flex gap-2">
      <input
        type="text"
        bind:value={searchQuery}
        on:keydown={(e) => e.key === "Enter" && handleSearch()}
        placeholder="搜索 ICCID、手机号、运营商..."
        class="flex-1 px-4 py-2 cyber-input"
      />
      <button
        on:click={handleSearch}
        class="px-6 py-2 tech-button transition-all duration-300"
      >
        搜索
      </button>
    </div>
  </div>

  {#if error}
    <div
      class="mb-4 p-4 bg-red-900/20 border border-red-500/50 text-red-400 rounded-lg"
    >
      {error}
    </div>
  {/if}

  {#if loading}
    <div class="text-center py-8">
      <div
        class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-500"
      ></div>
      <p class="mt-2 text-cyan-400">加载中...</p>
    </div>
  {:else if error}
    <div class="text-center py-8">
      <p class="text-red-400 mb-4">❌ {error}</p>
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
          <p class="text-cyan-400 mb-4">暂无 ICCID 映射数据</p>
          <p class="text-cyan-300/60 text-sm">点击上方"添加映射"按钮创建第一个映射</p>
        </div>
      {:else}
        <table class="min-w-full">
          <thead>
            <tr class="border-b border-cyan-900/30">
              <th
                class="px-4 py-3 text-left text-xs font-medium text-cyan-400 uppercase tracking-wider"
                >ICCID</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-cyan-400 uppercase tracking-wider"
                >手机号</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-cyan-400 uppercase tracking-wider"
                >国家</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-cyan-400 uppercase tracking-wider"
                >运营商</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-cyan-400 uppercase tracking-wider"
                >描述</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-cyan-400 uppercase tracking-wider"
                >状态</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-cyan-400 uppercase tracking-wider"
                >创建时间</th
              >
              <th
                class="px-4 py-3 text-left text-xs font-medium text-cyan-400 uppercase tracking-wider"
                >操作</th
              >
            </tr>
          </thead>
          <tbody class="divide-y divide-cyan-900/30">
            {#each mappings as mapping}
            <tr class="hover:bg-cyan-900/20 transition-colors">
              <td class="px-4 py-3 text-sm font-mono text-cyan-300">{mapping.iccid}</td>
              <td class="px-4 py-3 text-sm font-medium text-white"
                >{mapping.phone_number}</td
              >
              <td class="px-4 py-3 text-sm">
                {#if mapping.country}
                  <span class="inline-flex items-center gap-1">
                    <span class="text-lg">{getCountryFlag(mapping.country)}</span>
                    <span class="text-xs text-cyan-400">{getCountryName(mapping.country)}</span>
                  </span>
                {:else}
                  <span class="text-gray-600">-</span>
                {/if}
              </td>
              <td class="px-4 py-3 text-sm">
                {#if mapping.carrier}
                  <span class="inline-flex px-2 py-1 text-xs rounded-full font-medium {getCarrierColor(mapping.carrier)}">
                    {mapping.carrier}
                  </span>
                {:else}
                  <span class="text-gray-600">-</span>
                {/if}
              </td>
              <td class="px-4 py-3 text-sm text-cyan-300">{mapping.notes || mapping.description || "-"}</td>
              <td class="px-4 py-3">
                <span
                  class="inline-flex px-2 py-1 text-xs rounded-full {mapping.is_active
                    ? 'bg-green-900/50 text-green-300 border border-green-500/30'
                    : 'bg-gray-900/50 text-gray-300 border border-gray-500/30'}"
                >
                  {mapping.is_active ? "启用" : "禁用"}
                </span>
              </td>
              <td class="px-4 py-3 text-sm text-cyan-400/70">
                {new Date(mapping.created_at).toLocaleString()}
              </td>
              <td class="px-4 py-3 text-sm">
                <button
                  on:click={() => startEdit(mapping)}
                  class="text-cyan-400 hover:text-cyan-300 mr-3 transition-colors"
                >
                  编辑
                </button>
                <button
                  on:click={() => handleDeleteMapping(mapping.id)}
                  class="text-red-400 hover:text-red-300 transition-colors"
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

    <!-- Pagination -->
    {#if totalPages > 1}
      <div class="mt-4 flex justify-center gap-2">
        <button
          on:click={() => {
            currentPage = Math.max(1, currentPage - 1);
            loadMappings();
          }}
          disabled={currentPage === 1}
          class="px-3 py-1 rounded border border-cyan-500/30 {currentPage === 1
            ? 'bg-gray-900/50 text-gray-600'
            : 'bg-cyan-900/20 hover:bg-cyan-900/30 text-cyan-400'}"
        >
          上一页
        </button>
        <span class="px-3 py-1 text-cyan-400">
          第 {currentPage} / {totalPages} 页
        </span>
        <button
          on:click={() => {
            currentPage = Math.min(totalPages, currentPage + 1);
            loadMappings();
          }}
          disabled={currentPage === totalPages}
          class="px-3 py-1 rounded border border-cyan-500/30 {currentPage === totalPages
            ? 'bg-gray-900/50 text-gray-600'
            : 'bg-cyan-900/20 hover:bg-cyan-900/30 text-cyan-400'}"
        >
          下一页
        </button>
      </div>
    {/if}
  {/if}
</div>

<!-- Add Mapping Modal -->
{#if showAddForm}
  <div
    class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50"
  >
    <div class="tech-card p-6 max-w-md w-full mx-4">
      <h3 class="text-lg font-bold mb-4 data-value high-contrast">添加 ICCID 映射</h3>

      <div class="space-y-4">
        <div>
          <label
            for="create-iccid"
            class="block text-sm font-medium text-cyan-400 mb-1">ICCID</label
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
            class="block text-sm font-medium text-cyan-400 mb-1">手机号</label
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
            class="block text-sm font-medium text-cyan-400 mb-1"
            >国家</label
          >
          <select
            id="create-country"
            bind:value={formData.country}
            class="w-full px-3 py-2 cyber-input"
          >
            <option value="">选择国家...</option>
            {#each countries as country}
              <option value={country.code}>
                {country.flag} {country.name}
              </option>
            {/each}
          </select>
        </div>

        <div>
          <label
            for="create-carrier"
            class="block text-sm font-medium text-cyan-400 mb-1"
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
            class="block text-sm font-medium text-cyan-400 mb-1"
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
          class="px-4 py-2 border border-cyan-500/30 rounded-lg hover:bg-cyan-900/20 text-cyan-400 transition-all duration-300"
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
    class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50"
  >
    <div class="tech-card p-6 max-w-md w-full mx-4">
      <h3 class="text-lg font-bold mb-4 data-value high-contrast">编辑 ICCID 映射</h3>

      <div class="space-y-4">
        <div>
          <label
            for="edit-iccid"
            class="block text-sm font-medium text-cyan-400 mb-1">ICCID</label
          >
          <input
            id="edit-iccid"
            type="text"
            value={formData.iccid}
            disabled
            class="w-full px-3 py-2 cyber-input bg-gray-900/50 cursor-not-allowed"
          />
        </div>

        <div>
          <label
            for="edit-phone-number"
            class="block text-sm font-medium text-cyan-400 mb-1">手机号</label
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
            class="block text-sm font-medium text-cyan-400 mb-1"
            >国家</label
          >
          <select
            id="edit-country"
            bind:value={formData.country}
            class="w-full px-3 py-2 cyber-input"
          >
            <option value="">选择国家...</option>
            {#each countries as country}
              <option value={country.code}>
                {country.flag} {country.name}
              </option>
            {/each}
          </select>
        </div>

        <div>
          <label
            for="edit-carrier"
            class="block text-sm font-medium text-cyan-400 mb-1"
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
            class="block text-sm font-medium text-cyan-400 mb-1"
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
            <span class="text-sm font-medium text-cyan-400">启用状态</span>
          </label>
        </div>
      </div>

      <div class="mt-6 flex justify-end gap-3">
        <button
          on:click={() => {
            showEditForm = false;
            resetForm();
          }}
          class="px-4 py-2 border border-cyan-500/30 rounded-lg hover:bg-cyan-900/20 text-cyan-400 transition-all duration-300"
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
    class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50"
  >
    <div class="tech-card p-6 max-w-2xl w-full mx-4">
      <h3 class="text-lg font-bold mb-4 data-value high-contrast">批量导入 ICCID 映射</h3>

      <div class="mb-4">
        <p class="text-sm text-cyan-400/70 mb-2">
          支持 CSV 或 JSON 格式。CSV
          格式第一行应为标题行：iccid,phone_number,country,carrier,description
        </p>
        <p class="text-sm text-cyan-400/70">
          JSON 格式示例：<code
            class="text-cyan-300">[{JSON.stringify({
              iccid: "123456",
              phone_number: "13800138000",
              country: "CN",
              carrier: "中国移动",
            })}]</code
          >
        </p>
        <p class="text-sm text-cyan-400/70 mt-1">
          国家代码：CN=中国, HK=香港, SG=新加坡, US=美国, UK=英国, JP=日本等
        </p>
      </div>

      <textarea
        bind:value={bulkImportText}
        placeholder="粘贴 CSV 或 JSON 数据..."
        class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
        rows="10"
      ></textarea>

      <div class="mt-6 flex justify-end gap-3">
        <button
          on:click={() => {
            showBulkImport = false;
            bulkImportText = "";
          }}
          class="px-4 py-2 border border-cyan-500/30 rounded-lg hover:bg-cyan-900/20 text-cyan-400 transition-all duration-300"
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
