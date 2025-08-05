<script>
  import { onMount } from 'svelte';
  import { api } from './api.js';

  let keywords = [];
  let loading = false;
  let error = null;
  let showAddDialog = false;
  let editingKeyword = null;

  // Form data
  let formData = {
    keyword: '',
    tag: '',
    color: '#3B82F6',
    priority: 0,
    case_sensitive: false,
    whole_word: false
  };

  onMount(() => {
    loadKeywords();
  });

  async function loadKeywords() {
    loading = true;
    error = null;
    
    try {
      const response = await api.get('/api/keywords');
      if (response.keywords) {
        keywords = response.keywords;
      }
    } catch (err) {
      console.error('[KeywordConfig] Failed to load keywords:', err);
      error = 'Failed to load keywords';
    } finally {
      loading = false;
    }
  }

  function showAddKeyword() {
    formData = {
      keyword: '',
      tag: '',
      color: '#3B82F6',
      priority: 0,
      case_sensitive: false,
      whole_word: false
    };
    editingKeyword = null;
    showAddDialog = true;
  }

  function showEditKeyword(keyword) {
    formData = {
      keyword: keyword.keyword,
      tag: keyword.tag,
      color: keyword.color || '#3B82F6',
      priority: keyword.priority || 0,
      case_sensitive: keyword.case_sensitive || false,
      whole_word: keyword.whole_word || false
    };
    editingKeyword = keyword;
    showAddDialog = true;
  }

  async function saveKeyword() {
    error = null;
    
    try {
      if (editingKeyword) {
        // Update existing keyword
        await api.put(`/api/keywords/${editingKeyword.id}`, formData);
      } else {
        // Create new keyword
        await api.post('/api/keywords', formData);
      }
      
      showAddDialog = false;
      await loadKeywords();
    } catch (err) {
      console.error('[KeywordConfig] Failed to save keyword:', err);
      // Extract the actual error message from the response
      if (err.message === 'Keyword already exists') {
        error = 'This keyword already exists. Please use a different keyword.';
      } else if (err.message) {
        error = err.message;
      } else {
        error = 'Failed to save keyword';
      }
    }
  }

  async function deleteKeyword(keyword) {
    if (!confirm(`Are you sure you want to delete the keyword "${keyword.keyword}"?`)) {
      return;
    }
    
    try {
      await api.delete(`/api/keywords/${keyword.id}`);
      await loadKeywords();
    } catch (err) {
      console.error('[KeywordConfig] Failed to delete keyword:', err);
      error = 'Failed to delete keyword';
    }
  }

  async function toggleKeywordActive(keyword) {
    try {
      await api.put(`/api/keywords/${keyword.id}`, {
        ...keyword,
        is_active: !keyword.is_active
      });
      await loadKeywords();
    } catch (err) {
      console.error('[KeywordConfig] Failed to toggle keyword:', err);
      error = 'Failed to update keyword';
    }
  }
</script>

<div class="keyword-config">
  <div class="flex justify-between items-center mb-6">
    <div>
      <h2 class="text-2xl font-bold text-cyan-400">Keyword Highlighting</h2>
      <p class="text-gray-400 mt-1">Configure keywords to highlight and tag messages automatically</p>
    </div>
    <button
      on:click={showAddKeyword}
      class="tech-button px-4 py-2 rounded-lg flex items-center gap-2"
    >
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
      </svg>
      Add Keyword
    </button>
  </div>

  {#if error}
    <div class="bg-red-900/20 border border-red-500/50 text-red-400 p-4 rounded-lg mb-4">
      {error}
    </div>
  {/if}

  {#if loading}
    <div class="text-center py-8">
      <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-400"></div>
      <p class="text-gray-400 mt-2">Loading keywords...</p>
    </div>
  {:else if keywords.length === 0}
    <div class="text-center py-12 bg-gray-900/50 rounded-lg border border-gray-800">
      <svg class="w-16 h-16 mx-auto text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"></path>
      </svg>
      <p class="text-gray-400 mb-4">No keywords configured yet</p>
      <button
        on:click={showAddKeyword}
        class="tech-button px-6 py-2 rounded-lg"
      >
        Add Your First Keyword
      </button>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full">
        <thead>
          <tr class="text-left border-b border-gray-800">
            <th class="px-4 py-3 text-gray-400 font-medium">Keyword</th>
            <th class="px-4 py-3 text-gray-400 font-medium">Tag</th>
            <th class="px-4 py-3 text-gray-400 font-medium">Color</th>
            <th class="px-4 py-3 text-gray-400 font-medium">Priority</th>
            <th class="px-4 py-3 text-gray-400 font-medium">Options</th>
            <th class="px-4 py-3 text-gray-400 font-medium">Usage</th>
            <th class="px-4 py-3 text-gray-400 font-medium">Status</th>
            <th class="px-4 py-3 text-gray-400 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each keywords as keyword}
            <tr class="border-b border-gray-800 hover:bg-gray-900/50 transition-colors">
              <td class="px-4 py-3">
                <span class="font-mono text-cyan-400">{keyword.keyword}</span>
              </td>
              <td class="px-4 py-3">
                <span 
                  class="inline-block px-2 py-1 rounded text-xs font-medium"
                  style="background-color: {keyword.color}20; color: {keyword.color}; border: 1px solid {keyword.color}50"
                >
                  {keyword.tag}
                </span>
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <div 
                    class="w-6 h-6 rounded border border-gray-600"
                    style="background-color: {keyword.color}"
                  ></div>
                  <span class="text-xs text-gray-400">{keyword.color}</span>
                </div>
              </td>
              <td class="px-4 py-3 text-center">
                <span class="text-sm">{keyword.priority}</span>
              </td>
              <td class="px-4 py-3">
                <div class="flex gap-3 text-xs">
                  {#if keyword.case_sensitive}
                    <span class="text-yellow-400" title="Case sensitive">Aa</span>
                  {/if}
                  {#if keyword.whole_word}
                    <span class="text-green-400" title="Whole word only">W</span>
                  {/if}
                </div>
              </td>
              <td class="px-4 py-3 text-center">
                <span class="text-sm text-gray-400">{keyword.usage_count || 0}</span>
              </td>
              <td class="px-4 py-3">
                <button
                  on:click={() => toggleKeywordActive(keyword)}
                  class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors {keyword.is_active ? 'bg-cyan-600' : 'bg-gray-700'}"
                >
                  <span class="sr-only">Toggle active</span>
                  <span
                    class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform {keyword.is_active ? 'translate-x-6' : 'translate-x-1'}"
                  />
                </button>
              </td>
              <td class="px-4 py-3">
                <div class="flex gap-2">
                  <button
                    on:click={() => showEditKeyword(keyword)}
                    class="text-cyan-400 hover:text-cyan-300 transition-colors"
                    title="Edit"
                  >
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                    </svg>
                  </button>
                  <button
                    on:click={() => deleteKeyword(keyword)}
                    class="text-red-400 hover:text-red-300 transition-colors"
                    title="Delete"
                  >
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <!-- Add/Edit Dialog -->
  {#if showAddDialog}
    <div class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50" on:click={() => showAddDialog = false}>
      <div class="bg-gray-900 border border-gray-800 rounded-lg p-6 max-w-md w-full mx-4" on:click|stopPropagation>
        <h3 class="text-xl font-bold text-cyan-400 mb-4">
          {editingKeyword ? 'Edit Keyword' : 'Add New Keyword'}
        </h3>

        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-400 mb-1">Keyword</label>
            <input
              type="text"
              bind:value={formData.keyword}
              placeholder="Enter keyword to highlight"
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:border-cyan-400 focus:outline-none"
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-400 mb-1">Tag</label>
            <input
              type="text"
              bind:value={formData.tag}
              placeholder="Tag to display"
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:border-cyan-400 focus:outline-none"
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-400 mb-1">Color</label>
            <div class="flex gap-2">
              <input
                type="color"
                bind:value={formData.color}
                class="h-10 w-20 bg-gray-800 border border-gray-700 rounded cursor-pointer"
              />
              <input
                type="text"
                bind:value={formData.color}
                placeholder="#3B82F6"
                class="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:border-cyan-400 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-400 mb-1">Priority</label>
            <input
              type="number"
              bind:value={formData.priority}
              min="0"
              max="100"
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:border-cyan-400 focus:outline-none"
            />
            <p class="text-xs text-gray-500 mt-1">Higher priority keywords take precedence when overlapping</p>
          </div>

          <div class="space-y-2">
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                bind:checked={formData.case_sensitive}
                class="w-4 h-4 text-cyan-600 bg-gray-800 border-gray-600 rounded focus:ring-cyan-500"
              />
              <span class="text-sm text-gray-400">Case sensitive matching</span>
            </label>

            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                bind:checked={formData.whole_word}
                class="w-4 h-4 text-cyan-600 bg-gray-800 border-gray-600 rounded focus:ring-cyan-500"
              />
              <span class="text-sm text-gray-400">Match whole words only</span>
            </label>
          </div>
        </div>

        <div class="flex gap-3 mt-6">
          <button
            on:click={() => showAddDialog = false}
            class="flex-1 px-4 py-2 border border-gray-700 text-gray-400 rounded-lg hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            on:click={saveKeyword}
            class="flex-1 tech-button px-4 py-2 rounded-lg"
            disabled={!formData.keyword || !formData.tag}
          >
            {editingKeyword ? 'Update' : 'Add'} Keyword
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .keyword-config {
    @apply text-white;
  }

  .tech-button {
    @apply bg-gradient-to-r from-cyan-500 to-blue-500 text-white font-medium hover:from-cyan-600 hover:to-blue-600 transition-all duration-200 shadow-lg hover:shadow-cyan-500/25;
  }
</style>