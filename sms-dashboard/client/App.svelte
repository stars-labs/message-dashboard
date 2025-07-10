<script>
  import { onMount, onDestroy } from 'svelte';
  import PhoneList from './lib/PhoneList.svelte';
  import MessageView from './lib/MessageView.svelte';
  import MessageComposer from './lib/MessageComposer.svelte';
  import StatsCard from './lib/StatsCard.svelte';
  import IccidMappings from './lib/IccidMappings.svelte';
  import PhoneDetails from './lib/PhoneDetails.svelte';
  import { api } from './lib/api.js';
  import { realtimeService } from './lib/websocket-with-fallback.js';
  import { auth } from './lib/auth.js';
  
  let selectedPhone = null;
  let selectedCountry = 'all';
  let searchTerm = '';
  let showPhoneList = false;
  let messages = [];
  let phoneNumbers = [];
  let user = null;
  let loading = true;
  let wsConnected = false;
  let wsUnsubscribers = [];
  let currentView = 'dashboard'; // 'dashboard' or 'iccid-mappings'
  
  let stats = {
    totalMessages: 0,
    todayMessages: 0,
    onlineDevices: 0,
    totalDevices: 0,
    verificationRate: 0
  };
  
  // Load data from API
  async function loadData() {
    try {
      const [phonesData, messagesData, statsData] = await Promise.all([
        api.getPhones(),
        api.getMessages({ limit: 100 }),
        api.getStats()
      ]);
      
      phoneNumbers = phonesData || [];
      messages = messagesData.data || [];
      
      // Map API stats to component format
      stats = {
        totalMessages: statsData.total_messages,
        todayMessages: statsData.today_messages,
        onlineDevices: statsData.online_devices,
        totalDevices: statsData.total_devices,
        verificationRate: Math.round(statsData.verification_rate * 100)
      };
    } catch (error) {
      console.error('Failed to load data:', error);
    }
  }
  
  onMount(async () => {
    // Check if returning from Auth0 callback
    if (window.location.search.includes('token=')) {
      await auth.handleCallback();
    }
    
    // Check authentication
    try {
      if (auth.isAuthenticated()) {
        user = await auth.getUser();
        if (user) {
          await loadData();
          
          // Connect realtime service (WebSocket with SSE fallback)
          const token = auth.token;
          if (token) {
            await realtimeService.connect(token);
            setupWebSocketListeners();
          }
        }
      } else {
        // Try to get user info if token exists
        const existingUser = await auth.getUser();
        if (existingUser) {
          user = existingUser;
          await loadData();
          
          // Connect realtime service (WebSocket with SSE fallback)
          const token = auth.token;
          if (token) {
            await realtimeService.connect(token);
            setupWebSocketListeners();
          }
        }
      }
    } catch (error) {
      console.log('Authentication check failed:', error);
    }
    loading = false;
  });
  
  function setupWebSocketListeners() {
    // Listen for new messages
    wsUnsubscribers.push(
      realtimeService.on('message:created', (msg) => {
        console.log('New message received:', msg);
        messages = [msg.data, ...messages];
        // Update stats
        stats.totalMessages++;
        stats.todayMessages++;
      })
    );
    
    // Listen for message updates
    wsUnsubscribers.push(
      realtimeService.on('message:updated', (msg) => {
        console.log('Message updated:', msg);
        const index = messages.findIndex(m => m.id === msg.data.id);
        if (index !== -1) {
          messages[index] = msg.data;
          messages = [...messages];
        }
      })
    );
    
    // Listen for bulk message creation
    wsUnsubscribers.push(
      realtimeService.on('messages:bulk_created', (msg) => {
        console.log('Bulk messages received:', msg);
        messages = [...msg.data, ...messages];
        // Update stats
        stats.totalMessages += msg.data.length;
        stats.todayMessages += msg.data.length;
      })
    );
    
    // Listen for phone updates
    wsUnsubscribers.push(
      realtimeService.on('phones:updated', (msg) => {
        console.log('Phones updated:', msg);
        msg.data.forEach(updatedPhone => {
          const index = phoneNumbers.findIndex(p => p.id === updatedPhone.id);
          if (index !== -1) {
            phoneNumbers[index] = { ...phoneNumbers[index], ...updatedPhone };
          } else {
            phoneNumbers = [...phoneNumbers, updatedPhone];
          }
        });
        phoneNumbers = [...phoneNumbers];
        
        // Update online device count
        stats.onlineDevices = phoneNumbers.filter(p => p.status === 'online').length;
        stats.totalDevices = phoneNumbers.length;
      })
    );
    
    // Listen for connection status
    wsUnsubscribers.push(
      realtimeService.on('connected', () => {
        wsConnected = true;
        console.log('WebSocket connected');
      })
    );
  }
  
  // Refresh data periodically
  let refreshInterval;
  $: if (user && !refreshInterval) {
    refreshInterval = setInterval(loadData, 30000); // Refresh every 30 seconds
  }
  
  onDestroy(() => {
    if (refreshInterval) clearInterval(refreshInterval);
    
    // Cleanup realtime service
    wsUnsubscribers.forEach(unsubscribe => unsubscribe());
    realtimeService.disconnect();
  });
  
  function selectPhone(phone) {
    selectedPhone = phone;
    showPhoneList = false;
  }
  
  async function handleMessageSent(event) {
    const newMessage = event.detail;
    
    // Send to API
    try {
      const response = await api.sendMessage({
        phoneId: newMessage.phoneId,
        recipient: newMessage.recipient,
        content: newMessage.content
      });
      
      if (response.success) {
        // Add to local messages
        messages = [response.data, ...messages];
        // Reload stats
        await loadData();
      }
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  }
</script>

{#if loading}
  <div class="min-h-screen flex items-center justify-center">
    <div class="text-center">
      <div class="inline-flex items-center">
        <svg class="animate-spin h-8 w-8 text-purple-600 mr-3" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span class="text-xl text-gray-600">加载中...</span>
      </div>
    </div>
  </div>
{:else if !user}
  <div class="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-indigo-100">
    <div class="text-center bg-white p-8 rounded-xl shadow-lg">
      <h1 class="text-3xl font-bold text-gray-800 mb-4">短信验证码管理系统</h1>
      <p class="text-gray-600 mb-6">请登录以继续</p>
      <button 
        on:click={() => auth.login()}
        class="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white font-medium rounded-lg transition-colors"
      >
        使用 Auth0 登录
      </button>
    </div>
  </div>
{:else}
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
        <h1 class="text-xl font-bold bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text text-transparent">短信验证码管理系统</h1>
        
        <!-- Navigation -->
        <div class="hidden lg:flex items-center gap-4 flex-1 justify-center">
          <button 
            on:click={() => currentView = 'dashboard'}
            class="px-4 py-2 rounded-lg transition-colors {currentView === 'dashboard' ? 'bg-purple-100 text-purple-700' : 'text-gray-600 hover:bg-gray-100'}"
          >
            消息管理
          </button>
          <button 
            on:click={() => currentView = 'iccid-mappings'}
            class="px-4 py-2 rounded-lg transition-colors {currentView === 'iccid-mappings' ? 'bg-purple-100 text-purple-700' : 'text-gray-600 hover:bg-gray-100'}"
          >
            ICCID 映射
          </button>
        </div>
        
        <div class="hidden lg:flex items-center gap-4">
          {#if user}
            <span class="text-sm text-gray-600">欢迎, {user.name || user.email}</span>
            <button 
              on:click={() => auth.logout()}
              class="text-sm px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              退出
            </button>
          {/if}
          <div class="flex items-center gap-2 text-sm text-gray-600">
            <div class="w-2 h-2 {wsConnected ? 'bg-green-500' : 'bg-red-500'} rounded-full {wsConnected ? 'animate-pulse' : ''}"></div>
            <span>{wsConnected && realtimeService.getConnectionType() ? `${realtimeService.getConnectionType() === 'websocket' ? 'WS' : 'SSE'}` : 'Offline'}</span>
          </div>
        </div>
      </div>
    </div>
  </header>

  <!-- Mobile Navigation -->
  <div class="lg:hidden px-4 py-2 bg-gray-50 border-b">
    <div class="flex gap-2">
      <button 
        on:click={() => currentView = 'dashboard'}
        class="flex-1 px-3 py-2 rounded-lg text-sm transition-colors {currentView === 'dashboard' ? 'bg-purple-100 text-purple-700' : 'text-gray-600 bg-white'}"
      >
        消息管理
      </button>
      <button 
        on:click={() => currentView = 'iccid-mappings'}
        class="flex-1 px-3 py-2 rounded-lg text-sm transition-colors {currentView === 'iccid-mappings' ? 'bg-purple-100 text-purple-700' : 'text-gray-600 bg-white'}"
      >
        ICCID 映射
      </button>
    </div>
  </div>

  {#if currentView === 'dashboard'}
    <!-- Mobile Stats (Horizontal Scroll) -->
    <div class="lg:hidden overflow-x-auto px-4 py-4">
      <div class="flex gap-3 min-w-max">
        <div class="bg-gradient-to-br from-blue-500 to-blue-600 text-white px-4 py-3 rounded-xl shadow-lg">
          <div class="text-xs opacity-90">在线设备</div>
          <div class="text-xl font-bold">{phoneNumbers.filter(p => p.status === 'online').length}/{phoneNumbers.length}</div>
        </div>
        <div class="bg-gradient-to-br from-green-500 to-green-600 text-white px-4 py-3 rounded-xl shadow-lg">
          <div class="text-xs opacity-90">今日消息</div>
          <div class="text-xl font-bold">{stats.todayMessages}</div>
        </div>
        <div class="bg-gradient-to-br from-purple-500 to-purple-600 text-white px-4 py-3 rounded-xl shadow-lg">
          <div class="text-xs opacity-90">总消息数</div>
          <div class="text-xl font-bold">{stats.totalMessages}</div>
        </div>
        <div class="bg-gradient-to-br from-orange-500 to-orange-600 text-white px-4 py-3 rounded-xl shadow-lg">
          <div class="text-xs opacity-90">提取成功率</div>
          <div class="text-xl font-bold">{stats.verificationRate}%</div>
        </div>
      </div>
    </div>
  {/if}

  {#if currentView === 'dashboard'}
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
          value={stats.totalMessages} 
          gradient="from-purple-500 to-purple-600"
          icon="💬"
        />
        <StatsCard 
          title="今日消息" 
          value={stats.todayMessages} 
          gradient="from-green-500 to-green-600"
          icon="📊"
        />
        <StatsCard 
          title="验证码提取率" 
          value={`${stats.verificationRate}%`} 
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
          {#if selectedPhone}
            <PhoneDetails phone={selectedPhone} mobile={false} />
            <div class="mt-4">
              <MessageView 
                {messages} 
                {selectedPhone}
                mobile={true}
              />
            </div>
          {:else}
            <MessageView 
              {messages} 
              {selectedPhone}
              mobile={true}
            />
          {/if}
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
  {:else if currentView === 'iccid-mappings'}
    <!-- ICCID Mappings View -->
    <div class="px-4 lg:px-8 py-6">
      <IccidMappings />
    </div>
  {/if}
</div>
{/if}
