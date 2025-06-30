<script>
  import { getMessagesByPhone, getRecentMessages } from './mockData.js';
  
  export let messages = [];
  export let selectedPhone = null;
  export let mobile = false;
  
  let viewMode = 'recent'; // 'recent' or 'history'
  let groupBy = 'time'; // 'time' or 'source'
  
  $: displayMessages = selectedPhone 
    ? getMessagesByPhone(selectedPhone.id)
    : getRecentMessages(50);
    
  $: groupedMessages = groupBy === 'source' 
    ? groupMessagesBySource(displayMessages)
    : displayMessages;
    
  function groupMessagesBySource(msgs) {
    const groups = {};
    msgs.forEach(msg => {
      if (!groups[msg.source]) {
        groups[msg.source] = [];
      }
      groups[msg.source].push(msg);
    });
    return groups;
  }
  
  function formatTime(date) {
    const now = new Date();
    const msgDate = new Date(date);
    const diffMs = now - msgDate;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return `${diffMins}分钟前`;
    if (diffHours < 24) return `${diffHours}小时前`;
    if (diffDays < 7) return `${diffDays}天前`;
    
    return msgDate.toLocaleDateString('zh-CN');
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

<div class="{mobile ? 'bg-white' : 'glassmorphism rounded-2xl shadow-xl lg:mt-0'} mt-4">
  <div class="p-3 lg:p-4 {mobile ? 'border-b' : ''}">
    <div class="flex justify-between items-center {mobile ? '' : 'mb-4'}">
      <h2 class="text-base lg:text-lg font-bold bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text text-transparent">
        {#if selectedPhone}
          <span class="inline-flex items-center gap-1">
            <span>{selectedPhone.flag}</span>
            <span class="text-sm lg:text-base">{selectedPhone.number}</span>
          </span>
        {:else}
          最新消息
        {/if}
      </h2>
      
      <div class="flex gap-1 lg:gap-2">
        <button
          class="px-3 py-1.5 text-xs lg:text-sm rounded-lg font-medium transition-all duration-300 {viewMode === 'recent' ? 'bg-gradient-to-r from-purple-500 to-indigo-500 text-white shadow-lg' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}"
          on:click={() => viewMode = 'recent'}
        >
          最新
        </button>
        <button
          class="px-3 py-1.5 text-xs lg:text-sm rounded-lg font-medium transition-all duration-300 {viewMode === 'history' ? 'bg-gradient-to-r from-purple-500 to-indigo-500 text-white shadow-lg' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}"
          on:click={() => viewMode = 'history'}
        >
          历史
        </button>
      </div>
    </div>
    
    {#if viewMode === 'history' && !mobile}
      <div class="flex gap-2 items-center mt-3">
        <span class="text-sm text-gray-600">分组方式:</span>
        <select
          bind:value={groupBy}
          class="px-2 py-1 text-sm border border-purple-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white/50"
        >
          <option value="time">按时间</option>
          <option value="source">按来源</option>
        </select>
      </div>
    {/if}
  </div>
  
  <div class="{mobile ? 'max-h-[calc(100vh-280px)]' : 'max-h-[600px]'} overflow-y-auto p-3 lg:p-4">
    {#if groupBy === 'source' && viewMode === 'history' && !mobile}
      {#each Object.entries(groupedMessages) as [source, msgs]}
        <div class="mb-4 lg:mb-6">
          <h3 class="font-bold text-gray-900 mb-2 lg:mb-3 sticky top-0 bg-white/90 backdrop-blur-sm py-1 lg:py-2 flex items-center gap-2">
            <span class="px-2 py-1 rounded-lg bg-gradient-to-r {getSourceColor(source)} text-white text-xs">{source}</span>
            <span class="text-sm text-gray-600">({msgs.length})</span>
          </h3>
          <div class="space-y-2 lg:space-y-3">
            {#each msgs as message}
              <div class="bg-gradient-to-r from-gray-50 to-gray-100 rounded-xl p-3 lg:p-4 border border-gray-200 hover:shadow-lg transition-shadow duration-300">
                <div class="flex justify-between items-start mb-2">
                  <div class="flex-1">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="text-xs px-2 py-1 rounded-full bg-gradient-to-r {getSourceColor(message.source)} text-white font-medium">
                        {message.source}
                      </span>
                      {#if message.verificationCode}
                        <span class="px-3 py-1 bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm rounded-full font-mono font-bold shadow-md">
                          {message.verificationCode}
                        </span>
                      {/if}
                    </div>
                    <div class="mt-2 bg-white/50 rounded-lg p-2">
                      <p class="text-xs lg:text-sm text-gray-700 break-words">{message.content}</p>
                    </div>
                    <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <span class="text-purple-600 font-medium flex items-center gap-1">
                        <span>📱</span>
                        接收卡: {message.phoneId}
                      </span>
                      <span class="text-gray-500">•</span>
                      <span class="text-gray-600">{message.phoneNumber}</span>
                    </div>
                  </div>
                  <span class="text-xs text-gray-500 ml-2">{formatTime(message.timestamp)}</span>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    {:else}
      <div class="space-y-2 lg:space-y-3">
        {#each displayMessages as message}
          <div class="bg-gradient-to-r from-white to-gray-50 rounded-xl p-3 lg:p-4 border border-gray-200 hover:shadow-xl hover:scale-[1.02] active:scale-100 transition-all duration-300">
            <div class="flex justify-between items-start mb-2">
              <div class="flex-1">
                <div class="flex flex-wrap items-center gap-2 mb-1">
                  <span class="text-xs px-2 py-1 rounded-full bg-gradient-to-r {getSourceColor(message.source)} text-white font-medium shadow-md">
                    {message.source}
                  </span>
                  {#if message.verificationCode}
                    <span class="px-3 py-1 bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm rounded-full font-mono font-bold shadow-md animate-pulse">
                      {message.verificationCode}
                    </span>
                  {/if}
                </div>
                <div class="mt-2 bg-gray-50 rounded-lg p-2">
                  <p class="text-xs lg:text-sm text-gray-700 break-words">{message.content}</p>
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span class="text-purple-600 font-medium flex items-center gap-1">
                    <span>📱</span>
                    接收卡: {message.phoneId}
                  </span>
                  {#if !selectedPhone}
                    <span class="text-gray-500">•</span>
                    <span class="text-gray-600">{message.phoneNumber}</span>
                  {/if}
                </div>
              </div>
              <span class="text-xs text-gray-500 ml-2 whitespace-nowrap">{formatTime(message.timestamp)}</span>
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