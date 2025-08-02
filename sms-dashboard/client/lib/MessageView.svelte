<script>
  export let messages = [];
  export let selectedPhone = null;
  export let mobile = false;
  
  let viewMode = 'recent'; // 'recent' or 'history'
  let groupBy = 'time'; // 'time' or 'source'
  
  // Filter messages first
  $: filteredMessages = selectedPhone 
    ? messages.filter(msg => msg.phone_iccid === selectedPhone.iccid)
    : messages.slice().slice(0, 50);
  
  // Debug logging for message filtering
  $: {
    if (messages.length > 0) {
      console.log('[MessageView] Total messages:', messages.length);
      console.log('[MessageView] Selected phone:', selectedPhone);
      console.log('[MessageView] Filtered messages:', filteredMessages.length);
      if (selectedPhone) {
        console.log('[MessageView] Filtering by ICCID:', selectedPhone.iccid);
        console.log('[MessageView] Message ICCIDs:', messages.slice(0, 5).map(m => m.phone_iccid));
      }
    }
  }
  
  // Helper function to parse and normalize timestamps
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
  
  // Sort messages based on view mode
  $: recentMessages = filteredMessages.slice().sort((a, b) => {
    // Recent mode: newest first (DESC)
    const dateA = parseTimestamp(a.timestamp);
    const dateB = parseTimestamp(b.timestamp);
    return dateB.getTime() - dateA.getTime();
  });
  
  $: historyMessages = filteredMessages.slice().sort((a, b) => {
    // History mode: oldest first (ASC)
    const dateA = parseTimestamp(a.timestamp);
    const dateB = parseTimestamp(b.timestamp);
    return dateA.getTime() - dateB.getTime();
  });
  
  // Select which sorted array to display
  $: displayMessages = viewMode === 'recent' ? recentMessages : historyMessages;
    
  $: groupedMessages = groupBy === 'source' 
    ? groupMessagesBySource(displayMessages)
    : displayMessages;
    
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
</script>

<div class="{mobile ? 'bg-black/90' : 'tech-card'} mt-4 scan-line">
  <div class="p-3 lg:p-4 {mobile ? 'border-b border-cyan-900/30' : ''}">
    <div class="flex justify-between items-center {mobile ? '' : 'mb-4'}">
      <h2 class="text-base lg:text-lg font-bold data-value high-contrast header-effect-target">
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
          class="px-3 py-1.5 text-xs lg:text-sm rounded-lg font-medium transition-all duration-300 {viewMode === 'recent' ? 'tech-button' : 'text-cyan-400 bg-cyan-900/20 hover:bg-cyan-900/30'}"
          on:click={() => viewMode = 'recent'}
        >
          最新
        </button>
        <button
          class="px-3 py-1.5 text-xs lg:text-sm rounded-lg font-medium transition-all duration-300 {viewMode === 'history' ? 'tech-button' : 'text-cyan-400 bg-cyan-900/20 hover:bg-cyan-900/30'}"
          on:click={() => viewMode = 'history'}
        >
          历史
        </button>
      </div>
    </div>
    
    {#if viewMode === 'history' && !mobile}
      <div class="flex gap-2 items-center mt-3">
        <span class="text-sm text-cyan-300">分组方式:</span>
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
          <h3 class="font-bold text-cyan-300 mb-2 lg:mb-3 sticky top-0 bg-black/90 backdrop-blur-sm py-1 lg:py-2 flex items-center gap-2">
            <span class="px-2 py-1 rounded-lg bg-gradient-to-r {getSourceColor(source)} text-white text-xs">{source || '未知来源'}</span>
            <span class="text-sm text-cyan-400/60">({msgs.length})</span>
          </h3>
          <div class="space-y-2 lg:space-y-3">
            {#each msgs as message}
              <div class="tech-card holo-card rounded-xl p-3 lg:p-4 hover:shadow-lg hover:shadow-cyan-500/20 transition-all duration-300">
                <div class="flex justify-between items-start mb-2">
                  <div class="flex-1">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="text-xs px-2 py-1 rounded-full bg-gradient-to-r {getSourceColor(message.source)} text-white font-medium">
                        {message.source || '未知来源'}
                      </span>
                      {#if message.verificationCode}
                        <span class="px-3 py-1 bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm rounded-full font-mono font-bold shadow-md data-display">
                          {message.verificationCode}
                        </span>
                      {/if}
                    </div>
                    <div class="mt-2 bg-black/50 rounded-lg p-2 border border-cyan-500/30">
                      <p class="text-xs lg:text-sm text-white font-medium break-words whitespace-pre-wrap high-contrast">{message.content}</p>
                    </div>
                    <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <span class="text-purple-400 font-bold flex items-center gap-1 tech-text">
                        <span>📱</span>
                        接收卡: {message.phone_iccid}
                      </span>
                      {#if message.phone_number}
                        <span class="text-cyan-600">•</span>
                        <span class="text-green-400 font-bold flex items-center gap-1 tech-text">
                          <span>📞</span>
                          发送方: {message.phone_number}
                        </span>
                      {/if}
                      <span class="text-cyan-600">•</span>
                      <span class="text-cyan-400/70">{message.display_phone_number || '-'}</span>
                    </div>
                  </div>
                  <span class="text-xs text-cyan-500/60 ml-2">{formatTime(message.timestamp)}</span>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    {:else}
      <div class="space-y-2 lg:space-y-3">
        {#each displayMessages as message}
          <div class="tech-card {message.type === 'sent' ? 'border-l-4 border-l-blue-400' : ''} rounded-xl p-3 lg:p-4 hover:shadow-xl hover:shadow-cyan-500/20 hover:scale-[1.01] active:scale-100 transition-all duration-300">
            <div class="flex justify-between items-start mb-2">
              <div class="flex-1">
                <div class="flex flex-wrap items-center gap-2 mb-1">
                  {#if message.type === 'sent'}
                    {#if message.status === 'failed'}
                      <span class="text-xs px-2 py-1 rounded-full bg-gradient-to-r from-red-500 to-red-600 text-white font-medium shadow-md">
                        发送失败
                      </span>
                    {:else}
                      <span class="text-xs px-2 py-1 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 text-white font-medium shadow-md">
                        已发送
                      </span>
                      {#if message.status === 'delivered'}
                        <span class="text-xs text-green-400">✓ 已送达</span>
                      {/if}
                    {/if}
                  {:else}
                    {#if message.source}
                      <span class="text-xs px-2 py-1 rounded-full bg-gradient-to-r {getSourceColor(message.source)} text-white font-medium shadow-md">
                        {message.source}
                      </span>
                    {:else}
                      <span class="text-xs px-2 py-1 rounded-full bg-gradient-to-r from-gray-500 to-gray-600 text-white font-medium shadow-md">
                        未知来源
                      </span>
                    {/if}
                    {#if message.verificationCode}
                      <span class="px-3 py-1 bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm rounded-full font-mono font-bold shadow-md animate-pulse">
                        {message.verificationCode}
                      </span>
                    {/if}
                  {/if}
                </div>
                <div class="mt-2 bg-black/50 rounded-lg p-2 border border-cyan-500/30">
                  <p class="text-xs lg:text-sm text-white font-medium break-words whitespace-pre-wrap high-contrast">{message.content}</p>
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {#if message.type === 'sent'}
                    <span class="text-blue-400 font-bold flex items-center gap-1 tech-text">
                      <span>📤</span>
                      发送卡: {message.phone_iccid}
                    </span>
                    <span class="text-cyan-600">•</span>
                    <span class="text-cyan-400/70">发送至: {message.recipient}</span>
                  {:else}
                    <span class="text-purple-400 font-bold flex items-center gap-1 tech-text">
                      <span>📱</span>
                      接收卡: {message.phone_iccid}
                    </span>
                    {#if message.phone_number}
                      <span class="text-cyan-600">•</span>
                      <span class="text-green-400 font-bold flex items-center gap-1 tech-text">
                        <span>📞</span>
                        发送方: {message.phone_number}
                      </span>
                    {/if}
                    {#if !selectedPhone}
                      <span class="text-cyan-600">•</span>
                      <span class="text-cyan-400/70">{message.display_phone_number || '-'}</span>
                    {/if}
                  {/if}
                </div>
              </div>
              <span class="text-xs text-cyan-500/60 ml-2 whitespace-nowrap">{formatTime(message.timestamp)}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
    
    {#if displayMessages.length === 0}
      <div class="text-center py-8">
        <div class="text-6xl mb-4">📭</div>
        <p class="text-gray-500">暂无消息记录</p>
      </div>
    {/if}
  </div>
</div>