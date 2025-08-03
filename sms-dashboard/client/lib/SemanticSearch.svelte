<script>
  import { onMount } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { api } from './api.js';
  import { fade, slide } from 'svelte/transition';

  export let selectedPhoneIccid = null;

  const dispatch = createEventDispatcher();

  let searchQuery = '';
  let searchResults = [];
  let isSearching = false;
  let showResults = false;
  let searchTimeout;
  let recentCodes = [];
  let loadingCodes = true;

  // Example searches for user guidance
  const exampleSearches = [
    'verification codes from banks',
    '所有的验证码',
    'messages from Amazon',
    'OTPs from last hour',
    'urgent messages',
    'package delivery notifications'
  ];

  onMount(() => {
    loadRecentVerificationCodes();
  });

  async function loadRecentVerificationCodes() {
    try {
      loadingCodes = true;
      const response = await api.get('/api/ai/verification-codes?hours=24');
      if (response.success) {
        recentCodes = response.data.slice(0, 5);
      }
    } catch (error) {
      console.error('Failed to load verification codes:', error);
    } finally {
      loadingCodes = false;
    }
  }

  async function performSearch() {
    if (!searchQuery.trim()) {
      searchResults = [];
      showResults = false;
      return;
    }

    isSearching = true;
    showResults = true;

    try {
      const params = new URLSearchParams({
        q: searchQuery,
        limit: '30'
      });

      if (selectedPhoneIccid) {
        params.append('phone_id', selectedPhoneIccid);
      }

      const response = await api.get(`/api/ai/search?${params}`);
      
      if (response.success) {
        searchResults = response.data.messages;
      } else {
        throw new Error(response.error || 'Search failed');
      }
    } catch (error) {
      console.error('Search error:', error);
      searchResults = [];
    } finally {
      isSearching = false;
    }
  }

  function handleInput() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      if (searchQuery.trim()) {
        performSearch();
      } else {
        searchResults = [];
        showResults = false;
      }
    }, 300);
  }

  function selectMessage(message) {
    dispatch('messageSelected', message);
    showResults = false;
  }

  function useExample(example) {
    searchQuery = example;
    performSearch();
  }

  function copyCode(code) {
    navigator.clipboard.writeText(code);
    // You could add a toast notification here
  }

  function highlightMatch(text, query) {
    if (!query) return text;
    
    const regex = new RegExp(`(${query})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
  }
</script>

<div class="semantic-search">
  <div class="search-container">
    <div class="search-input-wrapper">
      <input
        type="text"
        bind:value={searchQuery}
        on:input={handleInput}
        placeholder="Search messages naturally... e.g., 'verification codes from Google'"
        class="search-input"
        aria-label="Search messages"
      />
      
      {#if isSearching}
        <div class="search-icon searching">
          <div class="spinner"></div>
        </div>
      {:else}
        <div class="search-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M21 21L15 15M17 10C17 13.866 13.866 17 10 17C6.13401 17 3 13.866 3 10C3 6.13401 6.13401 3 10 3C13.866 3 17 6.13401 17 10Z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </div>
      {/if}
    </div>

    {#if !searchQuery && !showResults}
      <div class="search-suggestions" transition:fade>
        <p class="suggestion-label">Try searching for:</p>
        <div class="example-searches">
          {#each exampleSearches as example}
            <button 
              class="example-tag" 
              on:click={() => useExample(example)}
            >
              {example}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if showResults && searchResults.length > 0}
      <div class="search-results" transition:slide>
        <div class="results-header">
          <span>Found {searchResults.length} messages</span>
          <button class="close-btn" on:click={() => showResults = false}>✕</button>
        </div>
        
        <div class="results-list">
          {#each searchResults as result}
            <div 
              class="result-item" 
              on:click={() => selectMessage(result)}
              on:keydown={(e) => e.key === 'Enter' && selectMessage(result)}
              role="button"
              tabindex="0"
            >
              <div class="result-header">
                <span class="result-phone">{result.phone_number || result.phone_iccid}</span>
                <span class="result-time">{new Date(result.timestamp).toLocaleString()}</span>
              </div>
              
              <div class="result-content">
                {@html highlightMatch(result.content, searchQuery)}
              </div>
              
              {#if result.ai_verification_code}
                <div class="result-code">
                  <span class="code-label">Code:</span>
                  <code>{result.ai_verification_code}</code>
                  <button 
                    class="copy-btn" 
                    on:click|stopPropagation={() => copyCode(result.ai_verification_code)}
                    title="Copy code"
                  >
                    📋
                  </button>
                </div>
              {/if}
              
              {#if result.classification}
                <div class="result-meta">
                  <span class="classification-badge {result.classification}">
                    {result.classification}
                  </span>
                  {#if result.sender_category}
                    <span class="sender-badge">
                      {result.sender_category}
                    </span>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {:else if showResults && !isSearching}
      <div class="no-results" transition:fade>
        <p>No messages found for "{searchQuery}"</p>
        <p class="no-results-hint">Try different keywords or check the filters</p>
      </div>
    {/if}
  </div>

  <!-- Recent Verification Codes Widget -->
  {#if recentCodes.length > 0 || loadingCodes}
    <div class="recent-codes-widget" transition:slide>
      <h4>Recent Verification Codes</h4>
      
      {#if loadingCodes}
        <div class="loading-codes">
          <div class="spinner"></div>
          <span>Loading codes...</span>
        </div>
      {:else}
        <div class="codes-list">
          {#each recentCodes as code}
            <div class="code-item">
              <div class="code-info">
                <span class="code-service">{code.service || 'Unknown'}</span>
                <code class="code-value">{code.code}</code>
                <button 
                  class="copy-btn small" 
                  on:click={() => copyCode(code.code)}
                  title="Copy code"
                >
                  📋
                </button>
              </div>
              <span class="code-time">
                {new Date(code.timestamp).toLocaleTimeString()}
              </span>
            </div>
          {/each}
        </div>
        
        <button 
          class="view-all-btn" 
          on:click={() => searchQuery = 'verification codes'}
        >
          View all codes →
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .semantic-search {
    margin-bottom: 20px;
  }

  .search-container {
    position: relative;
  }

  .search-input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .search-input {
    width: 100%;
    padding: 12px 48px 12px 16px;
    background: var(--bg-card, #1a1a1a);
    border: 1px solid var(--border-color, #333);
    border-radius: 12px;
    color: var(--text-primary, #fff);
    font-size: 15px;
    transition: all 0.3s ease;
  }

  .search-input:focus {
    outline: none;
    border-color: var(--accent-color, #00ffff);
    box-shadow: 0 0 20px rgba(0, 255, 255, 0.3);
  }

  .search-input::placeholder {
    color: var(--text-secondary, #666);
  }

  .search-icon {
    position: absolute;
    right: 16px;
    color: var(--text-secondary, #666);
    pointer-events: none;
  }

  .search-icon.searching {
    color: var(--accent-color, #00ffff);
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .search-suggestions {
    margin-top: 12px;
  }

  .suggestion-label {
    font-size: 13px;
    color: var(--text-secondary, #666);
    margin-bottom: 8px;
  }

  .example-searches {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .example-tag {
    padding: 6px 12px;
    background: rgba(0, 255, 255, 0.1);
    border: 1px solid rgba(0, 255, 255, 0.3);
    border-radius: 16px;
    color: var(--accent-color, #00ffff);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .example-tag:hover {
    background: rgba(0, 255, 255, 0.2);
    transform: translateY(-1px);
  }

  .search-results {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    right: 0;
    max-height: 400px;
    background: var(--bg-card, #1a1a1a);
    border: 1px solid var(--border-color, #333);
    border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    z-index: 100;
  }

  .results-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    background: var(--bg-secondary, #222);
    border-bottom: 1px solid var(--border-color, #333);
    font-size: 14px;
    color: var(--text-secondary, #666);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-secondary, #666);
    cursor: pointer;
    font-size: 16px;
    padding: 4px;
  }

  .close-btn:hover {
    color: var(--text-primary, #fff);
  }

  .results-list {
    max-height: 350px;
    overflow-y: auto;
  }

  .result-item {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color, #333);
    cursor: pointer;
    transition: background 0.2s;
  }

  .result-item:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .result-item:last-child {
    border-bottom: none;
  }

  .result-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .result-phone {
    font-size: 12px;
    color: var(--text-secondary, #666);
  }

  .result-time {
    font-size: 12px;
    color: var(--text-secondary, #666);
  }

  .result-content {
    font-size: 14px;
    color: var(--text-primary, #fff);
    line-height: 1.4;
    margin-bottom: 8px;
  }

  :global(.result-content mark) {
    background: rgba(0, 255, 255, 0.3);
    color: inherit;
    padding: 1px 3px;
    border-radius: 3px;
  }

  .result-code {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .code-label {
    font-size: 12px;
    color: var(--text-secondary, #666);
  }

  .result-code code {
    padding: 4px 8px;
    background: rgba(0, 255, 255, 0.2);
    border: 1px solid var(--accent-color, #00ffff);
    border-radius: 4px;
    font-family: monospace;
    font-size: 14px;
    color: var(--accent-color, #00ffff);
  }

  .copy-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 14px;
    opacity: 0.7;
    transition: opacity 0.2s;
  }

  .copy-btn:hover {
    opacity: 1;
  }

  .copy-btn.small {
    font-size: 12px;
  }

  .result-meta {
    display: flex;
    gap: 8px;
  }

  .classification-badge,
  .sender-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    text-transform: capitalize;
  }

  .classification-badge {
    background: rgba(255, 255, 255, 0.1);
    color: var(--text-primary, #fff);
  }

  .classification-badge.verification {
    background: rgba(0, 255, 255, 0.2);
    color: var(--accent-color, #00ffff);
  }

  .classification-badge.spam {
    background: rgba(255, 0, 0, 0.2);
    color: #ff6666;
  }

  .sender-badge {
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-secondary, #666);
  }

  .no-results {
    padding: 32px 16px;
    text-align: center;
  }

  .no-results p {
    margin: 0 0 8px 0;
    color: var(--text-primary, #fff);
  }

  .no-results-hint {
    font-size: 13px;
    color: var(--text-secondary, #666);
  }

  /* Recent Codes Widget */
  .recent-codes-widget {
    margin-top: 20px;
    padding: 16px;
    background: var(--bg-card, #1a1a1a);
    border: 1px solid var(--border-color, #333);
    border-radius: 12px;
  }

  .recent-codes-widget h4 {
    margin: 0 0 12px 0;
    font-size: 14px;
    color: var(--text-primary, #fff);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .loading-codes {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 20px;
    justify-content: center;
    color: var(--text-secondary, #666);
  }

  .codes-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .code-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 8px;
    transition: background 0.2s;
  }

  .code-item:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .code-info {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .code-service {
    font-size: 13px;
    color: var(--text-secondary, #666);
    min-width: 80px;
  }

  .code-value {
    padding: 2px 8px;
    background: rgba(0, 255, 255, 0.2);
    border: 1px solid var(--accent-color, #00ffff);
    border-radius: 4px;
    font-family: monospace;
    font-size: 14px;
    color: var(--accent-color, #00ffff);
  }

  .code-time {
    font-size: 12px;
    color: var(--text-secondary, #666);
  }

  .view-all-btn {
    margin-top: 12px;
    padding: 8px 16px;
    background: rgba(0, 255, 255, 0.1);
    border: 1px solid var(--accent-color, #00ffff);
    border-radius: 8px;
    color: var(--accent-color, #00ffff);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
    width: 100%;
    text-align: center;
  }

  .view-all-btn:hover {
    background: rgba(0, 255, 255, 0.2);
    transform: translateY(-1px);
  }

  /* Mobile responsive */
  @media (max-width: 640px) {
    .search-results {
      position: fixed;
      top: 60px;
      left: 10px;
      right: 10px;
      max-height: calc(100vh - 80px);
    }
  }
</style>