<script>
  import { onMount } from 'svelte';
  import { api } from './api';
  
  let mappings = [];
  let loading = false;
  let error = null;
  let showAddForm = false;
  let showEditForm = false;
  let showBulkImport = false;
  let editingMapping = null;
  let searchQuery = '';
  let currentPage = 1;
  let totalPages = 1;
  
  // Form data
  let formData = {
    iccid: '',
    phone_number: '',
    carrier: '',
    description: ''
  };
  
  // Bulk import data
  let bulkImportText = '';
  
  async function loadMappings() {
    loading = true;
    error = null;
    
    try {
      const response = await api.iccidMappings.list({
        page: currentPage,
        search: searchQuery
      });
      
      if (response.success) {
        mappings = response.data;
        totalPages = response.pagination.totalPages;
      } else {
        error = 'Failed to load ICCID mappings';
      }
    } catch (err) {
      error = err.message;
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
        error = response.error || 'Failed to add mapping';
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
        description: formData.description,
        is_active: formData.is_active
      });
      
      if (response.success) {
        showEditForm = false;
        resetForm();
        await loadMappings();
      } else {
        error = response.error || 'Failed to update mapping';
      }
    } catch (err) {
      error = err.message;
    }
  }
  
  async function handleDeleteMapping(id) {
    if (!confirm('Are you sure you want to delete this mapping?')) {
      return;
    }
    
    try {
      const response = await api.iccidMappings.delete(id);
      
      if (response.success) {
        await loadMappings();
      } else {
        error = response.error || 'Failed to delete mapping';
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
        const lines = bulkImportText.trim().split('\n');
        const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
        
        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',').map(v => v.trim());
          const mapping = {};
          
          headers.forEach((header, index) => {
            mapping[header] = values[index] || '';
          });
          
          mappingsData.push(mapping);
        }
      }
      
      const response = await api.iccidMappings.bulkImport({ mappings: mappingsData });
      
      if (response.success) {
        showBulkImport = false;
        bulkImportText = '';
        await loadMappings();
        
        alert(`Import complete!\nSuccess: ${response.results.success}\nFailed: ${response.results.failed}`);
      } else {
        error = response.error || 'Failed to import mappings';
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
      carrier: mapping.carrier || '',
      description: mapping.description || '',
      is_active: mapping.is_active
    };
    showEditForm = true;
  }
  
  function resetForm() {
    formData = {
      iccid: '',
      phone_number: '',
      carrier: '',
      description: ''
    };
    editingMapping = null;
  }
  
  function handleSearch() {
    currentPage = 1;
    loadMappings();
  }
  
  onMount(() => {
    loadMappings();
  });
</script>

<div class="bg-white rounded-lg shadow-sm p-6">
  <div class="flex justify-between items-center mb-6">
    <h2 class="text-2xl font-bold text-gray-800">ICCID 映射管理</h2>
    <div class="flex gap-2">
      <button
        on:click={() => showBulkImport = true}
        class="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
      >
        批量导入
      </button>
      <button
        on:click={() => showAddForm = true}
        class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
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
        on:keydown={e => e.key === 'Enter' && handleSearch()}
        placeholder="搜索 ICCID、手机号、运营商..."
        class="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
      />
      <button
        on:click={handleSearch}
        class="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
      >
        搜索
      </button>
    </div>
  </div>
  
  {#if error}
    <div class="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded-lg">
      {error}
    </div>
  {/if}
  
  {#if loading}
    <div class="text-center py-8">
      <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
      <p class="mt-2 text-gray-600">加载中...</p>
    </div>
  {:else}
    <!-- Mappings Table -->
    <div class="overflow-x-auto">
      <table class="min-w-full">
        <thead>
          <tr class="border-b border-gray-200">
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ICCID</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">手机号</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">运营商</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">描述</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">状态</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">创建时间</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-200">
          {#each mappings as mapping}
            <tr class="hover:bg-gray-50">
              <td class="px-4 py-3 text-sm font-mono">{mapping.iccid}</td>
              <td class="px-4 py-3 text-sm font-medium">{mapping.phone_number}</td>
              <td class="px-4 py-3 text-sm">{mapping.carrier || '-'}</td>
              <td class="px-4 py-3 text-sm">{mapping.description || '-'}</td>
              <td class="px-4 py-3">
                <span class="inline-flex px-2 py-1 text-xs rounded-full {mapping.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}">
                  {mapping.is_active ? '启用' : '禁用'}
                </span>
              </td>
              <td class="px-4 py-3 text-sm text-gray-500">
                {new Date(mapping.created_at).toLocaleString()}
              </td>
              <td class="px-4 py-3 text-sm">
                <button
                  on:click={() => startEdit(mapping)}
                  class="text-blue-600 hover:text-blue-800 mr-3"
                >
                  编辑
                </button>
                <button
                  on:click={() => handleDeleteMapping(mapping.id)}
                  class="text-red-600 hover:text-red-800"
                >
                  删除
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    
    <!-- Pagination -->
    {#if totalPages > 1}
      <div class="mt-4 flex justify-center gap-2">
        <button
          on:click={() => { currentPage = Math.max(1, currentPage - 1); loadMappings(); }}
          disabled={currentPage === 1}
          class="px-3 py-1 rounded border {currentPage === 1 ? 'bg-gray-100 text-gray-400' : 'bg-white hover:bg-gray-50'}"
        >
          上一页
        </button>
        <span class="px-3 py-1">
          第 {currentPage} / {totalPages} 页
        </span>
        <button
          on:click={() => { currentPage = Math.min(totalPages, currentPage + 1); loadMappings(); }}
          disabled={currentPage === totalPages}
          class="px-3 py-1 rounded border {currentPage === totalPages ? 'bg-gray-100 text-gray-400' : 'bg-white hover:bg-gray-50'}"
        >
          下一页
        </button>
      </div>
    {/if}
  {/if}
</div>

<!-- Add Mapping Modal -->
{#if showAddForm}
  <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
    <div class="bg-white rounded-lg p-6 max-w-md w-full mx-4">
      <h3 class="text-lg font-bold mb-4">添加 ICCID 映射</h3>
      
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">ICCID</label>
          <input
            type="text"
            bind:value={formData.iccid}
            placeholder="输入 ICCID"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
        </div>
        
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">手机号</label>
          <input
            type="text"
            bind:value={formData.phone_number}
            placeholder="输入手机号"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
        </div>
        
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">运营商（可选）</label>
          <input
            type="text"
            bind:value={formData.carrier}
            placeholder="例如：中国移动"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
        </div>
        
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">描述（可选）</label>
          <textarea
            bind:value={formData.description}
            placeholder="添加备注信息"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
            rows="3"
          ></textarea>
        </div>
      </div>
      
      <div class="mt-6 flex justify-end gap-3">
        <button
          on:click={() => { showAddForm = false; resetForm(); }}
          class="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          取消
        </button>
        <button
          on:click={handleAddMapping}
          class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
        >
          添加
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Edit Mapping Modal -->
{#if showEditForm}
  <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
    <div class="bg-white rounded-lg p-6 max-w-md w-full mx-4">
      <h3 class="text-lg font-bold mb-4">编辑 ICCID 映射</h3>
      
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">ICCID</label>
          <input
            type="text"
            value={formData.iccid}
            disabled
            class="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-100"
          />
        </div>
        
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">手机号</label>
          <input
            type="text"
            bind:value={formData.phone_number}
            placeholder="输入手机号"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
        </div>
        
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">运营商（可选）</label>
          <input
            type="text"
            bind:value={formData.carrier}
            placeholder="例如：中国移动"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
        </div>
        
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">描述（可选）</label>
          <textarea
            bind:value={formData.description}
            placeholder="添加备注信息"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
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
            <span class="text-sm font-medium text-gray-700">启用状态</span>
          </label>
        </div>
      </div>
      
      <div class="mt-6 flex justify-end gap-3">
        <button
          on:click={() => { showEditForm = false; resetForm(); }}
          class="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          取消
        </button>
        <button
          on:click={handleEditMapping}
          class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
        >
          保存
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Bulk Import Modal -->
{#if showBulkImport}
  <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
    <div class="bg-white rounded-lg p-6 max-w-2xl w-full mx-4">
      <h3 class="text-lg font-bold mb-4">批量导入 ICCID 映射</h3>
      
      <div class="mb-4">
        <p class="text-sm text-gray-600 mb-2">
          支持 CSV 或 JSON 格式。CSV 格式第一行应为标题行：iccid,phone_number,carrier,description
        </p>
        <p class="text-sm text-gray-600">
          JSON 格式示例：<code>[{JSON.stringify({iccid: "123456", phone_number: "13800138000", carrier: "中国移动"})}]</code>
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
          on:click={() => { showBulkImport = false; bulkImportText = ''; }}
          class="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          取消
        </button>
        <button
          on:click={handleBulkImport}
          class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
        >
          导入
        </button>
      </div>
    </div>
  </div>
{/if}