<script>
  import { onMount } from 'svelte';
  import { api } from './api.js';
  import { fade, slide } from 'svelte/transition';

  export let phoneId = null;
  export let compact = false;

  let insights = null;
  let loading = true;
  let error = null;

  onMount(() => {
    console.log('[AIInsights] onMount called, phoneId:', phoneId);
    if (phoneId) {
      loadInsights();
    } else {
      console.log('[AIInsights] No phoneId provided in onMount');
    }
  });

  $: if (phoneId) {
    console.log('[AIInsights] Reactive statement triggered, phoneId changed to:', phoneId);
    loadInsights();
  } else {
    console.log('[AIInsights] Reactive statement triggered, phoneId is:', phoneId);
  }

  async function loadInsights() {
    console.log(`[AIInsights] Loading insights for phoneId: ${phoneId}`);
    loading = true;
    error = null;

    try {
      console.log(`[AIInsights] Making API call to /api/ai/insights/${phoneId}`);
      const response = await api.get(`/api/ai/insights/${phoneId}`);
      console.log('[AIInsights] API response received:', response);
      
      if (response.success) {
        insights = response.data;
        console.log('[AIInsights] Insights data:', insights);
      } else {
        console.error('[AIInsights] API error response:', response);
        throw new Error(response.error || 'Failed to load insights');
      }
    } catch (err) {
      console.error('Failed to load AI insights:', err);
      error = err.message;
    } finally {
      console.log('[AIInsights] Loading complete, setting loading = false');
      loading = false;
    }
  }

  function getCategoryIcon(category) {
    const icons = {
      verification: '🔐',
      transaction: '💳',
      delivery: '📦',
      marketing: '📢',
      personal: '👤',
      spam: '🚫',
      notification: '🔔'
    };
    return icons[category] || '📄';
  }

  function getCategoryColor(category) {
    const colors = {
      verification: 'var(--accent-color, #00ffff)',
      transaction: '#4ade80',
      delivery: '#f59e0b',
      marketing: '#8b5cf6',
      personal: '#3b82f6',
      spam: '#ef4444',
      notification: '#6366f1'
    };
    return colors[category] || '#666';
  }

  function copyCode(code) {
    navigator.clipboard.writeText(code);
    // Could add toast notification
  }
</script>

<div class="ai-insights {compact ? 'compact' : ''}" transition:fade>
  {#if loading}
    <div class="loading">
      <div class="spinner"></div>
      <span>Analyzing messages with AI...</span>
    </div>
  {:else if error}
    <div class="error">
      <span>⚠️ {error}</span>
      <button on:click={loadInsights}>Retry</button>
    </div>
  {:else if insights}
    <div class="insights-content">
      {console.log('[AIInsights] Rendering insights data:', insights)}
      <!-- AI Summary -->
      {#if insights.ai_summary && !compact}
        <div class="ai-summary" transition:slide>
          <h4>AI Analysis</h4>
          <p>{insights.ai_summary}</p>
        </div>
      {/if}

      <!-- Quick Stats -->
      <div class="quick-stats">
        <div class="stat-item">
          <span class="stat-icon">📊</span>
          <div class="stat-info">
            <span class="stat-value">{insights.stats.total_messages}</span>
            <span class="stat-label">Total Messages</span>
          </div>
        </div>
        
        <div class="stat-item">
          <span class="stat-icon">🔐</span>
          <div class="stat-info">
            <span class="stat-value">{insights.stats.verification_codes}</span>
            <span class="stat-label">Verification Codes</span>
          </div>
        </div>
        
        <div class="stat-item">
          <span class="stat-icon">📥</span>
          <div class="stat-info">
            <span class="stat-value">{insights.stats.received}</span>
            <span class="stat-label">Received</span>
          </div>
        </div>
        
        <div class="stat-item">
          <span class="stat-icon">🚫</span>
          <div class="stat-info">
            <span class="stat-value">{insights.stats.spam_count}</span>
            <span class="stat-label">Spam</span>
          </div>
        </div>
      </div>

      <!-- Recent Verification Codes -->
      {#if insights.recent_codes.length > 0}
        <div class="recent-codes" transition:slide>
          <h4>Recent Verification Codes</h4>
          <div class="codes-grid">
            {#each insights.recent_codes as code}
              <div class="code-card">
                <div class="code-header">
                  <span class="code-service">{code.service || 'Unknown'}</span>
                  <span class="code-time">
                    {new Date(code.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div class="code-content">
                  <code>{code.code}</code>
                  <button 
                    class="copy-btn" 
                    on:click={() => copyCode(code.code)}
                    title="Copy code"
                  >
                    📋
                  </button>
                </div>
                {#if code.confidence_score}
                  <div class="confidence">
                    <span class="confidence-label">Confidence:</span>
                    <div class="confidence-bar">
                      <div 
                        class="confidence-fill" 
                        style="width: {code.confidence_score * 100}%"
                      ></div>
                    </div>
                    <span class="confidence-value">
                      {Math.round(code.confidence_score * 100)}%
                    </span>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Message Categories -->
      {#if insights.categories.length > 0 && !compact}
        <div class="categories" transition:slide>
          <h4>Message Categories (Last 7 Days)</h4>
          <div class="category-chart">
            {#each insights.categories as category}
              <div class="category-item">
                <div class="category-info">
                  <span class="category-icon">{getCategoryIcon(category.category)}</span>
                  <span class="category-name">{category.category}</span>
                  <span class="category-count">{category.count}</span>
                </div>
                <div class="category-bar">
                  <div 
                    class="category-fill" 
                    style="width: {(category.count / insights.stats.total_messages) * 100}%; background-color: {getCategoryColor(category.category)}"
                  ></div>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Generated timestamp -->
      <div class="generated-at">
        <span>Generated at {new Date(insights.generated_at).toLocaleString()}</span>
        <button class="refresh-btn" on:click={loadInsights} title="Refresh insights">
          🔄
        </button>
      </div>
    </div>
  {:else}
    <div class="no-data">
      <span>No insights available</span>
    </div>
  {/if}
</div>

<style>
  .ai-insights {
    background: var(--bg-card, #1a1a1a);
    border: 1px solid var(--border-color, #333);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 20px;
  }

  .ai-insights.compact {
    padding: 16px;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 40px;
    color: var(--text-secondary, #666);
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid transparent;
    border-top-color: var(--accent-color, #00ffff);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 20px;
    color: #ef4444;
  }

  .error button {
    padding: 6px 12px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid #ef4444;
    border-radius: 6px;
    color: #ef4444;
    cursor: pointer;
    transition: all 0.2s;
  }

  .error button:hover {
    background: rgba(239, 68, 68, 0.2);
  }

  .insights-content {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .ai-summary {
    padding: 16px;
    background: rgba(0, 255, 255, 0.05);
    border: 1px solid rgba(0, 255, 255, 0.2);
    border-radius: 8px;
  }

  .ai-summary h4 {
    margin: 0 0 8px 0;
    font-size: 14px;
    color: var(--accent-color, #00ffff);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ai-summary p {
    margin: 0;
    font-size: 14px;
    line-height: 1.6;
    color: var(--text-primary, #fff);
  }

  .quick-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 12px;
  }

  .stat-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 8px;
    transition: all 0.2s;
  }

  .stat-item:hover {
    background: rgba(255, 255, 255, 0.05);
    transform: translateY(-2px);
  }

  .stat-icon {
    font-size: 24px;
  }

  .stat-info {
    display: flex;
    flex-direction: column;
  }

  .stat-value {
    font-size: 20px;
    font-weight: bold;
    color: var(--text-primary, #fff);
  }

  .stat-label {
    font-size: 12px;
    color: var(--text-secondary, #666);
  }

  .recent-codes h4,
  .categories h4 {
    margin: 0 0 12px 0;
    font-size: 14px;
    color: var(--text-primary, #fff);
  }

  .codes-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
  }

  .code-card {
    padding: 12px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--border-color, #333);
    border-radius: 8px;
    transition: all 0.2s;
  }

  .code-card:hover {
    background: rgba(255, 255, 255, 0.05);
    border-color: var(--accent-color, #00ffff);
  }

  .code-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .code-service {
    font-size: 13px;
    color: var(--text-secondary, #666);
  }

  .code-time {
    font-size: 11px;
    color: var(--text-secondary, #666);
  }

  .code-content {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .code-content code {
    flex: 1;
    padding: 6px 10px;
    background: rgba(0, 255, 255, 0.2);
    border: 1px solid var(--accent-color, #00ffff);
    border-radius: 6px;
    font-family: monospace;
    font-size: 16px;
    color: var(--accent-color, #00ffff);
    text-align: center;
  }

  .copy-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 16px;
    opacity: 0.7;
    transition: opacity 0.2s;
  }

  .copy-btn:hover {
    opacity: 1;
  }

  .confidence {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .confidence-label {
    color: var(--text-secondary, #666);
  }

  .confidence-bar {
    flex: 1;
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }

  .confidence-fill {
    height: 100%;
    background: var(--accent-color, #00ffff);
    transition: width 0.3s ease;
  }

  .confidence-value {
    color: var(--text-secondary, #666);
    min-width: 35px;
    text-align: right;
  }

  .category-chart {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .category-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .category-info {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .category-icon {
    font-size: 16px;
  }

  .category-name {
    flex: 1;
    font-size: 13px;
    color: var(--text-primary, #fff);
    text-transform: capitalize;
  }

  .category-count {
    font-size: 13px;
    color: var(--text-secondary, #666);
  }

  .category-bar {
    height: 8px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    overflow: hidden;
  }

  .category-fill {
    height: 100%;
    transition: width 0.3s ease;
    border-radius: 4px;
  }

  .generated-at {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 12px;
    border-top: 1px solid var(--border-color, #333);
    font-size: 12px;
    color: var(--text-secondary, #666);
  }

  .refresh-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 16px;
    opacity: 0.7;
    transition: all 0.2s;
  }

  .refresh-btn:hover {
    opacity: 1;
    transform: rotate(180deg);
  }

  .no-data {
    text-align: center;
    padding: 40px;
    color: var(--text-secondary, #666);
  }

  /* Mobile responsive */
  @media (max-width: 640px) {
    .codes-grid {
      grid-template-columns: 1fr;
    }
    
    .quick-stats {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>