<script>
  import { createEventDispatcher, onMount } from 'svelte';
  
  export let selectedPhone = null;
  export let phoneNumbers = [];
  export let messages = [];
  
  const dispatch = createEventDispatcher();
  
  let recipientNumber = '';
  let recipientSIM = '';
  let messageContent = '';
  let sendingStatus = '';
  let showComposer = false;
  let showRecipientHistory = false;
  let recipientSearch = '';
  
  // Get unique recipient numbers from sent messages
  $: recipientHistory = [...new Set(messages
    .filter(msg => msg.type === 'sent' && msg.recipient)
    .map(msg => msg.recipient))]
    .slice(0, 20); // Keep last 20 unique recipients
  
  // Filter recipient history based on search
  $: filteredRecipients = recipientHistory.filter(num => 
    num.includes(recipientSearch) || recipientSearch === ''
  );
  
  $: if (selectedPhone) {
    recipientSIM = selectedPhone.id;
  }
  
  function handleSend() {
    if (!recipientNumber || !recipientSIM || !messageContent) {
      sendingStatus = 'error';
      setTimeout(() => sendingStatus = '', 3000);
      return;
    }
    
    sendingStatus = 'sending';
    
    // Store recipient in localStorage for persistence
    const storedRecipients = JSON.parse(localStorage.getItem('recipientHistory') || '[]');
    if (!storedRecipients.includes(recipientNumber)) {
      storedRecipients.unshift(recipientNumber);
      localStorage.setItem('recipientHistory', JSON.stringify(storedRecipients.slice(0, 50)));
    }
    
    // Simulate sending
    setTimeout(() => {
      const sentMessage = {
        id: `msg-sent-${Date.now()}`,
        phoneId: recipientSIM,
        phoneNumber: recipientNumber,
        recipient: recipientNumber,
        content: messageContent,
        timestamp: new Date(),
        type: 'sent',
        status: 'delivered'
      };
      
      dispatch('messageSent', sentMessage);
      
      sendingStatus = 'success';
      messageContent = '';
      
      setTimeout(() => {
        sendingStatus = '';
        showComposer = false;
      }, 2000);
    }, 1500);
  }
  
  function selectRecipient(number) {
    recipientNumber = number;
    showRecipientHistory = false;
    recipientSearch = '';
  }
  
  function insertTemplate(template) {
    messageContent = template;
  }
  
  const messageTemplates = [
    { name: '验证码模板', content: '您的验证码是：123456，有效期5分钟。' },
    { name: '通知模板', content: '尊敬的用户，您的订单已发货，请注意查收。' },
    { name: '提醒模板', content: '温馨提醒：您的账户余额不足，请及时充值。' },
    { name: '营销模板', content: '限时优惠！全场商品8折，快来选购吧！' }
  ];
  
  // Load recipient history from localStorage on mount
  onMount(() => {
    const storedRecipients = JSON.parse(localStorage.getItem('recipientHistory') || '[]');
    if (storedRecipients.length > 0) {
      recipientHistory.push(...storedRecipients);
    }
  });
  
  // Close dropdown when clicking outside
  function handleClickOutside(event) {
    if (!event.target.closest('.recipient-input-container')) {
      showRecipientHistory = false;
    }
  }
</script>

<svelte:window on:click={handleClickOutside} />

<div class="{showComposer ? 'block' : 'hidden lg:block'} bg-white rounded-2xl shadow-xl p-4 lg:p-6">
  <div class="flex justify-between items-center mb-4">
    <h2 class="text-lg font-bold bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text text-transparent">
      发送短信
    </h2>
    <button 
      class="lg:hidden text-gray-500 hover:text-gray-700"
      on:click={() => showComposer = false}
    >
      <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
  
  <!-- Recipient Number -->
  <div class="mb-4 relative recipient-input-container">
    <label class="block text-sm font-medium text-gray-700 mb-2">
      接收号码
    </label>
    <input
      type="text"
      bind:value={recipientNumber}
      on:focus={() => showRecipientHistory = true}
      on:input={(e) => {
        showRecipientHistory = true;
        recipientSearch = e.target.value;
      }}
      placeholder="输入接收方手机号..."
      class="w-full px-4 py-2 border border-purple-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
    />
    
    <!-- Recipient History Dropdown -->
    {#if showRecipientHistory && filteredRecipients.length > 0}
      <div class="absolute top-full left-0 right-0 mt-1 bg-white border border-purple-200 rounded-lg shadow-xl max-h-48 overflow-y-auto z-10">
        <div class="p-2">
          <div class="text-xs text-gray-500 px-2 py-1 border-b border-gray-100 mb-1">
            历史接收号码
          </div>
          {#each filteredRecipients as recipient}
            <button
              on:click={() => selectRecipient(recipient)}
              class="w-full text-left px-3 py-2 hover:bg-gradient-to-r hover:from-purple-50 hover:to-indigo-50 rounded-md transition-colors text-sm flex items-center gap-2"
            >
              <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span class="font-mono">{recipient}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
  
  <!-- SIM Card Selection -->
  <div class="mb-4">
    <label class="block text-sm font-medium text-gray-700 mb-2">
      发送卡号
    </label>
    <select
      bind:value={recipientSIM}
      class="w-full px-4 py-2 border border-purple-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
    >
      <option value="">选择发送卡...</option>
      {#each phoneNumbers.filter(p => p.status === 'online') as phone}
        <option value={phone.id}>
          {phone.flag} {phone.number} - {phone.id}
        </option>
      {/each}
    </select>
  </div>
  
  <!-- Message Templates -->
  <div class="mb-4">
    <label class="block text-sm font-medium text-gray-700 mb-2">
      快速模板
    </label>
    <div class="flex flex-wrap gap-2">
      {#each messageTemplates as template}
        <button
          on:click={() => insertTemplate(template.content)}
          class="px-3 py-1 text-xs bg-gradient-to-r from-purple-100 to-indigo-100 text-purple-700 rounded-full hover:from-purple-200 hover:to-indigo-200 transition-colors"
        >
          {template.name}
        </button>
      {/each}
    </div>
  </div>
  
  <!-- Message Content -->
  <div class="mb-4">
    <label class="block text-sm font-medium text-gray-700 mb-2">
      短信内容
    </label>
    <textarea
      bind:value={messageContent}
      placeholder="输入短信内容..."
      rows="4"
      class="w-full px-4 py-2 border border-purple-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
    ></textarea>
    <div class="mt-1 text-xs text-gray-500">
      字数：{messageContent.length} / 500
    </div>
  </div>
  
  <!-- Send Button -->
  <button
    on:click={handleSend}
    disabled={sendingStatus === 'sending'}
    class="w-full py-3 bg-gradient-to-r from-purple-500 to-indigo-500 text-white font-medium rounded-lg hover:from-purple-600 hover:to-indigo-600 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed {sendingStatus === 'success' ? 'from-green-500 to-green-600' : ''} {sendingStatus === 'error' ? 'from-red-500 to-red-600' : ''}"
  >
    {#if sendingStatus === 'sending'}
      <span class="flex items-center justify-center">
        <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        发送中...
      </span>
    {:else if sendingStatus === 'success'}
      ✅ 发送成功
    {:else if sendingStatus === 'error'}
      ❌ 请填写完整信息
    {:else}
      发送短信
    {/if}
  </button>
</div>

<!-- Mobile Floating Button -->
<button
  class="lg:hidden fixed bottom-6 right-6 w-14 h-14 bg-gradient-to-r from-purple-500 to-indigo-500 text-white rounded-full shadow-lg flex items-center justify-center hover:scale-110 transition-transform z-30"
  on:click={() => showComposer = true}
>
  <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
  </svg>
</button>