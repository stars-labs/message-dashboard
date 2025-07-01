<script>
  import { phoneNumbers, messages as initialMessages, getMessageStats } from './lib/mockData.js';
  import PhoneList from './lib/PhoneList.svelte';
  import MessageView from './lib/MessageView.svelte';
  import MessageComposer from './lib/MessageComposer.svelte';
  import StatsCard from './lib/StatsCard.svelte';
  
  let selectedPhone = null;
  let selectedCountry = 'all';
  let searchTerm = '';
  let showPhoneList = false;
  let messages = [...initialMessages];
  
  let stats = getMessageStats();
  
  function selectPhone(phone) {
    selectedPhone = phone;
    showPhoneList = false;
  }
  
  function handleMessageSent(event) {
    const newMessage = event.detail;
    messages = [newMessage, ...messages];
    stats = getMessageStats();
  }
</script>

<div class="min-h-screen">
  <!-- Mobile Header -->
  <header class="glassmorphism shadow-lg sticky top-0 z-40">
    <div class="px-4">
      <div class="flex justify-between items-center h-16">
        <button 
          class="lg:hidden p-2 -ml-2 text-purple-600 hover:bg-purple-100 rounded-lg transition-colors"
          on:click={() => showPhoneList = !showPhoneList}
        >
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <h1 class="text-xl font-bold bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text text-transparent flex-1 text-center lg:text-left">短信验证码管理系统</h1>
        <div class="hidden lg:flex items-center gap-2 text-sm text-gray-600">
          <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
          <span>EC20 x95</span>
        </div>
      </div>
    </div>
  </header>

  <!-- Mobile Stats (Horizontal Scroll) -->
  <div class="lg:hidden overflow-x-auto px-4 py-4">
    <div class="flex gap-3 min-w-max">
      <div class="bg-gradient-to-br from-blue-500 to-blue-600 text-white px-4 py-3 rounded-xl shadow-lg">
        <div class="text-xs opacity-90">在线设备</div>
        <div class="text-xl font-bold">{phoneNumbers.filter(p => p.status === 'online').length}/{phoneNumbers.length}</div>
      </div>
      <div class="bg-gradient-to-br from-green-500 to-green-600 text-white px-4 py-3 rounded-xl shadow-lg">
        <div class="text-xs opacity-90">今日消息</div>
        <div class="text-xl font-bold">{stats.today}</div>
      </div>
      <div class="bg-gradient-to-br from-purple-500 to-purple-600 text-white px-4 py-3 rounded-xl shadow-lg">
        <div class="text-xs opacity-90">总消息数</div>
        <div class="text-xl font-bold">{stats.total}</div>
      </div>
      <div class="bg-gradient-to-br from-orange-500 to-orange-600 text-white px-4 py-3 rounded-xl shadow-lg">
        <div class="text-xs opacity-90">提取成功率</div>
        <div class="text-xl font-bold">98%</div>
      </div>
    </div>
  </div>

  <!-- Desktop Stats -->
  <div class="hidden lg:block px-8 py-6">
    <div class="grid grid-cols-4 gap-6">
      <StatsCard 
        title="在线设备" 
        value={phoneNumbers.filter(p => p.status === 'online').length} 
        total={phoneNumbers.length} 
        gradient="from-blue-500 to-blue-600"
        icon="📱"
      />
      <StatsCard 
        title="总消息数" 
        value={stats.total} 
        gradient="from-purple-500 to-purple-600"
        icon="💬"
      />
      <StatsCard 
        title="今日消息" 
        value={stats.today} 
        gradient="from-green-500 to-green-600"
        icon="📊"
      />
      <StatsCard 
        title="验证码提取率" 
        value="98%" 
        gradient="from-orange-500 to-orange-600"
        icon="✅"
      />
    </div>
  </div>

  <!-- Main Content -->
  <div class="lg:px-8 lg:pb-6">
    <div class="lg:grid lg:grid-cols-4 lg:gap-6">
      <!-- Mobile Phone List Overlay -->
      {#if showPhoneList}
        <div class="lg:hidden fixed inset-0 z-50 bg-gray-900 bg-opacity-75 backdrop-blur-sm" on:click={() => showPhoneList = false}>
          <div class="absolute left-0 top-0 bottom-0 w-80 max-w-full bg-white shadow-2xl" on:click|stopPropagation>
            <div class="h-full overflow-y-auto">
              <PhoneList 
                {phoneNumbers} 
                bind:selectedPhone={selectedPhone}
                bind:selectedCountry
                bind:searchTerm
                onSelectPhone={selectPhone}
                mobile={true}
              />
            </div>
          </div>
        </div>
      {/if}
      
      <!-- Desktop Phone List -->
      <div class="hidden lg:block lg:col-span-1">
        <PhoneList 
          {phoneNumbers} 
          bind:selectedPhone 
          bind:selectedCountry
          bind:searchTerm
        />
      </div>
      
      <!-- Message View -->
      <div class="lg:col-span-2">
        <MessageView 
          {messages} 
          {selectedPhone}
          mobile={true}
        />
      </div>
      
      <!-- Message Composer -->
      <div class="lg:col-span-1">
        <MessageComposer 
          {selectedPhone}
          {phoneNumbers}
          {messages}
          on:messageSent={handleMessageSent}
        />
      </div>
    </div>
  </div>
</div>
