<script>
  import MessageHighlight from './MessageHighlight.svelte';
  import { onMount, afterUpdate } from 'svelte';
  import { api } from './api.js';
  
  export let messages = [];
  export let selectedPhone = null;
  export let mobile = false;
  
  let viewMode = 'recent'; // 'recent' or 'history'
  let groupBy = 'time'; // 'time' or 'source'
  let messageTags = new Map(); // Store tags for each message
  let tagsLoaded = false;
  let keywords = []; // Load keywords once for all messages - always pass array to children
  let keywordsLoading = false;
  
  // These will be computed reactively below
  
  // Helper function to parse timestamps - must be defined before groupMessagesBySource
  function parseTimestamp(timestamp) {
    if (!timestamp) return new Date(0);
    
    // Handle malformed timestamps with single-digit hours/minutes
    let normalizedTimestamp = timestamp;
    const timestampRegex = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})(.*)$/;
    const match = timestamp.match(timestampRegex);
    
    if (match) {
      const [_, year, month, day, hour, minute, second, rest] = match;
      normalizedTimestamp = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}${rest}`;
    }
    
    const date = new Date(normalizedTimestamp);
    return isNaN(date.getTime()) ? new Date(0) : date;
  }
  
  // Helper function to group messages by source - must be defined before reactive block
  function groupMessagesBySource(msgs) {
    const groups = {};
    msgs.forEach(msg => {
      // Only group received messages by source, skip sent messages
      if (msg.type === 'sent') return;
      
      if (!groups[msg.source]) {
        groups[msg.source] = [];
      }
      groups[msg.source].push(msg);
    });
    
    // Sort messages within each group based on view mode
    Object.keys(groups).forEach(source => {
      if (viewMode === 'recent') {
        // Recent mode: newest first in each group
        groups[source].sort((a, b) => parseTimestamp(b.timestamp).getTime() - parseTimestamp(a.timestamp).getTime());
      } else {
        // History mode: oldest first in each group
        groups[source].sort((a, b) => parseTimestamp(a.timestamp).getTime() - parseTimestamp(b.timestamp).getTime());
      }
    });
    
    return groups;
  }
  
  // Simple message display - no reactive statements
  let displayMessages = [];
  let groupedMessages = {};
  
  // Manual update function
  function updateMessages() {
    // Filter messages
    displayMessages = selectedPhone 
      ? (messages || []).filter(msg => msg.phone_iccid === selectedPhone.iccid)
      : (messages || []);
    
    // Group if needed
    if (groupBy === 'source' && viewMode === 'history') {
      groupedMessages = groupMessagesBySource(displayMessages);
    } else {
      groupedMessages = {};
    }
  }
  
  // Load keywords once for all messages
  async function loadKeywords() {
    // Prevent duplicate loading
    if (keywordsLoading) {
      console.debug('[MessageView] Keywords already loading, skipping duplicate request');
      return;
    }
    
    keywordsLoading = true;
    try {
      console.log('[MessageView] Loading keywords ONCE for all messages');
      const response = await api.get('/api/keywords');
      if (response.keywords) {
        // Only load active keywords, sorted by priority
        keywords = response.keywords
          .filter(k => k.is_active)
          .sort((a, b) => (b.priority || 0) - (a.priority || 0));
      } else {
        keywords = []; // Ensure it's always an array
      }
    } catch (err) {
      console.error('[MessageView] Failed to load keywords:', err);
      keywords = []; // Ensure it's always an array even on error
    } finally {
      keywordsLoading = false;
    }
  }
  
  // Simple batch fetch tags for visible messages
  async function batchFetchTags() {
    if (!displayMessages || displayMessages.length === 0) {
      return;
    }
    
    // Get message IDs for visible messages
    const messageIds = displayMessages.map(msg => msg.id).filter(id => id);
    
    if (messageIds.length === 0) {
      return;
    }
    
    try {
      const response = await api.post('/api/messages/batch-tags', { messageIds });
      
      if (response.success && response.data) {
        const newMessageTags = new Map();
        for (const [messageId, tags] of Object.entries(response.data)) {
          newMessageTags.set(messageId, tags);
        }
        messageTags = newMessageTags;
        tagsLoaded = true;
      }
    } catch (err) {
      console.error('[MessageView] Failed to batch fetch tags:', err);
      tagsLoaded = true;
    }
  }
  
  
  // Load keywords and tags on mount 
  onMount(async () => {
    updateMessages();
    await loadKeywords();
    await batchFetchTags();
  });
  
  // Watch for prop changes with afterUpdate
  let lastMessages = null;
  let lastSelectedPhone = null;
  let lastGroupBy = null;
  let lastViewMode = null;
  
  afterUpdate(() => {
    if (messages !== lastMessages || selectedPhone !== lastSelectedPhone || groupBy !== lastGroupBy || viewMode !== lastViewMode) {
      lastMessages = messages;
      lastSelectedPhone = selectedPhone;
      lastGroupBy = groupBy;
      lastViewMode = viewMode;
      updateMessages();
    }
  });
  
  
  // Export function for parent components to manually trigger tag reload if needed
  export function reloadTags() {
    tagsLoaded = false;
    batchFetchTags();
  }
  
  // Note: displayMessages and groupedMessages are now updated in the main reactive block above
  // to avoid circular dependencies
  
  function formatTime(timestamp) {
    if (!timestamp) return '未知时间';
    
    // Handle malformed timestamps with single-digit hours/minutes
    // e.g., "2025-07-29T2:0:17.000Z" -> "2025-07-29T02:00:17.000Z"
    let normalizedTimestamp = timestamp;
    const timestampRegex = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})(.*)$/;
    const match = timestamp.match(timestampRegex);
    
    if (match) {
      const [_, year, month, day, hour, minute, second, rest] = match;
      normalizedTimestamp = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}${rest}`;
    }
    
    // Parse the UTC timestamp from database
    const msgDate = new Date(normalizedTimestamp);
    
    // Check if date is valid
    if (isNaN(msgDate.getTime())) {
      console.error('Invalid date:', timestamp, 'normalized:', normalizedTimestamp);
      return '无效时间';
    }
    
    // Current time in local timezone
    const now = new Date();
    
    // Calculate difference (both dates are already in correct timezone context)
    const diffMs = now - msgDate;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    // Clean timestamp handling - no debug logs needed
    
    if (diffMs < 0) {
      // Handle future timestamps - show absolute time in local timezone
      const futureDiffMs = Math.abs(diffMs);
      if (futureDiffMs < 60000) return '刚刚'; // Within 1 minute, treat as "just now"
      return msgDate.toLocaleString('zh-CN', { 
        month: 'short', 
        day: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit',
        timeZone: 'Asia/Shanghai'
      });
    }
    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return `${diffMins}分钟前`;
    if (diffHours < 24) return `${diffHours}小时前`;
    if (diffDays < 7) return `${diffDays}天前`;
    
    // For older messages, show date in local timezone
    return msgDate.toLocaleDateString('zh-CN', {
      timeZone: 'Asia/Shanghai'
    });
  }
  
  function getSourceColor(source) {
    const colors = {
      '淘宝': 'from-orange-500 to-orange-600',
      '京东': 'from-red-500 to-red-600',
      '微信': 'from-green-500 to-green-600',
      '支付宝': 'from-blue-500 to-blue-600',
      'WhatsApp': 'from-green-400 to-green-500',
      'Telegram': 'from-sky-500 to-sky-600',
      '美团': 'from-yellow-500 to-yellow-600',
      '抖音': 'from-gray-800 to-gray-900',
      '小红书': 'from-pink-500 to-pink-600',
      'Google': 'from-blue-400 to-blue-500',
      'Facebook': 'from-blue-600 to-blue-700',
      'Instagram': 'from-purple-500 to-pink-500',
      '银行': 'from-indigo-500 to-indigo-600',
      '12306': 'from-blue-700 to-blue-800',
      '携程': 'from-sky-600 to-sky-700',
      '滴滴': 'from-orange-400 to-orange-500',
      'Uber': 'from-gray-700 to-gray-800',
      'Grab': 'from-green-600 to-green-700',
      'Tron': 'from-red-600 to-red-700',
      'TRON': 'from-red-600 to-red-700'
    };
    
    return colors[source] || 'from-gray-500 to-gray-600';
  }
  
  function handleTagsExtracted(messageId, tags) {
    // Only update if we don't already have tags for this message from server
    if (!messageTags.has(messageId)) {
      // Create a new Map instead of mutating the existing one to avoid triggering reactivity
      requestAnimationFrame(() => {
        const newTagsMap = new Map(messageTags);
        newTagsMap.set(messageId, tags);
        messageTags = newTagsMap;
      });
    }
  }
  
  // Removed getMessageTags - no longer needed since we use messageTags Map directly
  
  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Navigate to a specific message by ID
  export function scrollToMessage(messageId) {
    console.debug('[MessageView] Scrolling to message:', messageId);
    const element = document.getElementById(`message-${messageId}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Add a highlight effect
      element.classList.add('highlight-message');
      setTimeout(() => {
        element.classList.remove('highlight-message');
      }, 3000);
    } else {
      console.warn('[MessageView] Message element not found:', messageId);
    }
  }
</script>

<div class="{mobile ? 'bg-white' : 'tech-card'}">
  <div class="p-3 lg:p-4 {mobile ? 'border-b border-stone-200' : ''}">
    <div class="flex justify-between items-center mb-3">
      <h2 class="text-base lg:text-lg font-bold text-stone-900">
        {#if selectedPhone}
          <span class="inline-flex items-center gap-1">
            <span>{selectedPhone.flag}</span>
            <span class="text-sm lg:text-base">{selectedPhone.number}</span>
          </span>
        {:else}
          最新消息 (所有设备)
        {/if}
      </h2>
      
      <div class="flex gap-1 lg:gap-2">
        <button
          class="px-3 py-1.5 text-xs lg:text-sm rounded-lg font-medium transition-colors {viewMode === 'recent' ? 'bg-stone-300 text-stone-900' : 'text-stone-500 hover:bg-stone-200'}"
          on:click={() => viewMode = 'recent'}
        >
          最新
        </button>
        <button
          class="px-3 py-1.5 text-xs lg:text-sm rounded-lg font-medium transition-colors {viewMode === 'history' ? 'bg-stone-300 text-stone-900' : 'text-stone-500 hover:bg-stone-200'}"
          on:click={() => viewMode = 'history'}
        >
          历史
        </button>
      </div>
    </div>
    
    {#if viewMode === 'history' && !mobile}
      <div class="flex gap-2 items-center mt-3">
        <span class="text-sm text-stone-500">分组方式:</span>
        <select
          bind:value={groupBy}
          class="px-2 py-1 text-sm cyber-input"
        >
          <option value="time">按时间</option>
          <option value="source">按来源</option>
        </select>
      </div>
    {/if}
  </div>
  
  <div class="{mobile ? 'max-h-[calc(100vh-280px)]' : 'max-h-[calc(100vh-400px)]'} overflow-y-auto p-3 lg:p-4">
    {#if groupBy === 'source' && viewMode === 'history' && !mobile}
      {#each Object.entries(groupedMessages) as [source, msgs]}
        <div class="mb-4 lg:mb-6">
          <h3 class="font-bold text-stone-600 mb-2 lg:mb-3 sticky top-0 bg-white py-1 lg:py-2 flex items-center gap-2">
            <span class="px-2 py-1 rounded-lg bg-stone-300 text-stone-900 text-xs">{source || '未知来源'}</span>
            <span class="text-sm text-stone-400">({msgs.length})</span>
          </h3>
          <div class="space-y-2 lg:space-y-3">
            {#each msgs as message}
              <div class="bg-white border border-stone-200 rounded-xl p-3 lg:p-4 transition-colors">
                <div class="flex justify-between items-start mb-2">
                  <div class="flex-1">
                    <div class="flex items-center gap-2 flex-wrap mb-2">
                      <span class="text-xs px-2 py-1 rounded-full bg-gradient-to-r {getSourceColor(message.source)} text-stone-900 font-medium">
                        {message.source || '未知来源'}
                      </span>
                      {#if messageTags.has(message.id)}
                        {#each messageTags.get(message.id) as tag}
                          <span 
                            class="text-xs px-2 py-1 rounded-full text-stone-900 font-bold"
                            style="background-color: {tag.color};"
                          >
                            {tag.tag}
                            {#if tag.count > 1}
                              <span class="text-xs opacity-80">×{tag.count}</span>
                            {/if}
                          </span>
                        {/each}
                      {/if}
                      {#if message.verificationCode}
                        <span class="px-3 py-1 bg-gradient-to-r from-blue-500 to-blue-600 text-stone-900 text-sm rounded-full font-mono font-bold shadow-md data-display">
                          {message.verificationCode}
                        </span>
                      {/if}
                    </div>
                    <div class="bg-stone-50 rounded-lg p-3 border border-stone-200">
                      <MessageHighlight 
                        content={message.content} 
                        messageId={message.id} 
                        serverTags={messageTags.get(message.id)}
                        preloadedKeywords={keywords}
                        disableServerFetch={true}
                        onTagsExtracted={(tags) => handleTagsExtracted(message.id, tags)} 
                      />
                    </div>
                    <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <span class="text-purple-400 font-bold flex items-center gap-1 tech-text">
                        <span>📱</span>
                        接收卡: {message.phone_iccid}
                      </span>
                      {#if message.phone_number}
                        <span class="text-stone-500">•</span>
                        <span class="text-emerald-600 font-bold flex items-center gap-1 tech-text">
                          <span>📞</span>
                          发送方: {message.phone_number}
                        </span>
                      {/if}
                      <span class="text-stone-500">•</span>
                      <span class="text-stone-500">{message.display_phone_number || '-'}</span>
                    </div>
                  </div>
                  <span class="text-xs text-stone-400 ml-2">{formatTime(message.timestamp)}</span>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    {:else}
      <div class="space-y-2 lg:space-y-3">
        {#each displayMessages as message}
          <div id="message-{message.id}" class="bg-white border border-stone-200 {message.type === 'sent' ? 'border-l-4 border-l-blue-400' : ''} rounded-xl p-3 lg:p-4 transition-colors">
            <div class="flex justify-between items-start mb-2">
              <div class="flex-1">
                {#if message.type === 'sent'}
                  <div class="flex flex-wrap items-center gap-2 mb-2">
                    {#if message.status === 'failed'}
                      <span class="text-xs px-2 py-1 rounded-full bg-gradient-to-r from-red-500 to-red-600 text-stone-900 font-medium shadow-md">
                        发送失败
                      </span>
                    {:else}
                      <span class="text-xs px-2 py-1 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 text-stone-900 font-medium shadow-md">
                        已发送
                      </span>
                      {#if message.status === 'delivered'}
                        <span class="text-xs text-emerald-600">✓ 已送达</span>
                      {/if}
                    {/if}
                  </div>
                {/if}
                {#if message.type !== 'sent'}
                  <div class="flex items-center gap-2 flex-wrap mb-2">
                    {#if message.source}
                      <span class="text-xs px-2 py-1 rounded-full bg-gradient-to-r {getSourceColor(message.source)} text-stone-900 font-medium shadow-md">
                        {message.source}
                      </span>
                    {:else}
                      <span class="text-xs px-2 py-1 rounded-full bg-gradient-to-r from-gray-500 to-gray-600 text-stone-900 font-medium shadow-md">
                        未知来源
                      </span>
                    {/if}
                    {#if messageTags.has(message.id)}
                      {#each messageTags.get(message.id) as tag}
                        <span 
                          class="text-xs px-2 py-1 rounded-full text-stone-900 font-bold"
                          style="background-color: {tag.color};"
                        >
                          {tag.tag}
                          {#if tag.count > 1}
                            <span class="text-xs opacity-80">×{tag.count}</span>
                          {/if}
                        </span>
                      {/each}
                    {/if}
                    {#if message.verificationCode}
                      <span class="px-3 py-1 bg-gradient-to-r from-blue-500 to-blue-600 text-stone-900 text-sm rounded-full font-mono font-bold shadow-md animate-pulse">
                        {message.verificationCode}
                      </span>
                    {/if}
                  </div>
                {/if}
                <div class="bg-stone-50 rounded-lg p-3 border border-stone-200">
                  <MessageHighlight 
                    content={message.content} 
                    messageId={message.id} 
                    serverTags={messageTags.get(message.id)}
                    preloadedKeywords={keywords}
                    disableServerFetch={true}
                    onTagsExtracted={(tags) => handleTagsExtracted(message.id, tags)} 
                  />
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {#if message.type === 'sent'}
                    <span class="text-blue-400 font-bold flex items-center gap-1 tech-text">
                      <span>📤</span>
                      发送卡: {message.phone_iccid}
                    </span>
                    <span class="text-stone-500">•</span>
                    <span class="text-stone-500">发送至: {message.recipient}</span>
                  {:else}
                    <span class="text-purple-400 font-bold flex items-center gap-1 tech-text">
                      <span>📱</span>
                      接收卡: {message.phone_iccid}
                    </span>
                    {#if message.phone_number}
                      <span class="text-stone-500">•</span>
                      <span class="text-emerald-600 font-bold flex items-center gap-1 tech-text">
                        <span>📞</span>
                        发送方: {message.phone_number}
                      </span>
                    {/if}
                    {#if !selectedPhone}
                      <span class="text-stone-500">•</span>
                      <span class="text-stone-500">{message.display_phone_number || '-'}</span>
                    {/if}
                  {/if}
                </div>
              </div>
              <span class="text-xs text-stone-400 ml-2 whitespace-nowrap">{formatTime(message.timestamp)}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
    
    {#if displayMessages.length === 0 || (groupBy === 'source' && Object.keys(groupedMessages).length === 0)}
      <div class="text-center py-8">
        <div class="text-6xl mb-4">📭</div>
        <p class="text-stone-400">暂无消息记录</p>
      </div>
    {/if}
  </div>
</div>

<style>
  /* Highlight effect for scrolled-to message */
  :global(.highlight-message) {
    animation: pulse-highlight 3s ease-out;
    box-shadow: 0 0 30px rgba(0, 255, 255, 0.8), inset 0 0 20px rgba(0, 255, 255, 0.3) !important;
  }

  @keyframes pulse-highlight {
    0% {
      box-shadow: 0 0 10px rgba(0, 255, 255, 0.4), inset 0 0 10px rgba(0, 255, 255, 0.2);
    }
    20% {
      box-shadow: 0 0 40px rgba(0, 255, 255, 1), inset 0 0 30px rgba(0, 255, 255, 0.5);
    }
    100% {
      box-shadow: 0 0 10px rgba(0, 255, 255, 0.2), inset 0 0 5px rgba(0, 255, 255, 0.1);
    }
  }
</style>