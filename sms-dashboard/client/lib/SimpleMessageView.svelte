<script>
  export let messages = [];
  export let selectedPhone = null;
  
  // Simple function to format time
  function formatTime(timestamp) {
    if (!timestamp) return '未知时间';
    try {
      const date = new Date(timestamp);
      const now = new Date();
      const diffMs = now - date;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      
      if (diffMins < 1) return '刚刚';
      if (diffMins < 60) return `${diffMins}分钟前`;
      if (diffHours < 24) return `${diffHours}小时前`;
      if (diffDays < 7) return `${diffDays}天前`;
      
      return date.toLocaleDateString('zh-CN');
    } catch (e) {
      return '无效时间';
    }
  }
  
  // Simple filter
  let displayMessages = [];
  $: {
    if (selectedPhone) {
      displayMessages = (messages || []).filter(msg => msg.phone_iccid === selectedPhone.iccid);
    } else {
      displayMessages = messages || [];
    }
  }
</script>

<div class="bg-white border border-stone-200 rounded-xl shadow-sm flex flex-col h-full min-h-0">
  <div class="p-4 border-b border-stone-200 flex-shrink-0">
    <h2 class="text-lg font-semibold text-stone-900">
      {#if selectedPhone}
        {selectedPhone.flag} {selectedPhone.number}
      {:else}
        最新消息 (所有设备)
      {/if}
    </h2>
  </div>

  <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4">
    {#if displayMessages.length === 0}
      <div class="text-center py-8">
        <div class="text-6xl mb-4">📭</div>
        <p class="text-stone-400">暂无消息记录</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each displayMessages as message}
          <div class="bg-stone-50 rounded-lg p-3 border border-stone-200">
            <div class="flex justify-between items-start mb-2">
              <div class="flex-1">
                <div class="flex items-center gap-2 mb-2">
                  <span class="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-medium">
                    {message.source || '未知来源'}
                  </span>
                  {#if message.verificationCode}
                    <span class="px-2 py-1 bg-emerald-100 text-emerald-700 text-sm rounded-full font-mono font-semibold">
                      {message.verificationCode}
                    </span>
                  {/if}
                </div>
                <div class="bg-white rounded p-2 text-stone-800 border border-stone-200 break-words">
                  {message.content}
                </div>
                <div class="mt-2 text-xs text-stone-400 break-all">
                  接收卡: {message.phone_iccid}
                  {#if message.direction === 'outgoing' || message.type === 'outgoing' || message.type === 'sent'}
                    {#if message.recipient}
                      • 接收方: {message.recipient}
                    {:else if message.phone_number}
                      • 接收方: {message.phone_number}
                    {/if}
                  {:else if message.phone_number}
                    • 发送方: {message.phone_number}
                  {/if}
                </div>
              </div>
              <span class="text-xs text-stone-400 ml-2 shrink-0">{formatTime(message.timestamp)}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>