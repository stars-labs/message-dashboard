<script>
  import { onMount, onDestroy } from "svelte";
  import PhoneList from "./lib/PhoneList.svelte";
  import SimpleMessageView from "./lib/SimpleMessageView.svelte";
  import MessageComposer from "./lib/MessageComposer.svelte";
  import IccidMappings from "./lib/IccidMappings.svelte";
  import PhoneDetails from "./lib/PhoneDetails.svelte";
  import IccidMappingDialog from "./lib/IccidMappingDialog.svelte";
  import KeywordConfig from "./lib/KeywordConfig.svelte";
  import ErrorBoundary from "./lib/ErrorBoundary.svelte";
  import Toast from "./lib/Toast.svelte";
  import { api } from "./lib/api.js";
  import { getPhoneFlag, mapStatsResponse } from "./lib/countries.js";
  import { auth } from "./lib/auth.js";

  let selectedPhoneIccid = null;
  let selectedPhone = null;
  
  // Manual function to update selected phone
  function updateSelectedPhone() {
    selectedPhone = selectedPhoneIccid
      ? phoneNumbers.find((p) => p.iccid === selectedPhoneIccid)
      : null;
  }
  
  // Manual function to handle phone selection changes
  function handlePhoneSelection() {
    updateSelectedPhone();
    loadMessagesForPhone(selectedPhoneIccid);
  }
  
  // Centralized function to calculate online devices
  function calculateOnlineDevices(phones) {
    if (!phones || phones.length === 0) return 0;
    
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    const onlinePhones = phones.filter(p => {
      const hasOnlineStatus = p?.status && ["online", "active", "registered"].includes(p.status);
      if (!hasOnlineStatus) {
        return false;
      }
      if (!p.updated_at) {
        return false;
      }
      
      try {
        const updateTime = new Date(p.updated_at).getTime();
        const isRecent = !isNaN(updateTime) && updateTime > fiveMinutesAgo;
        return isRecent;
      } catch (e) {
        console.warn('Invalid date for phone:', p.iccid, p.updated_at);
        return false;
      }
    });
    
    return onlinePhones.length;
  }
  
  // Centralized function to calculate SIM missing devices
  function calculateSimMissingDevices(phones) {
    if (!phones || phones.length === 0) return 0;
    
    const simMissingPhones = phones.filter(p => {
      return p?.status === 'sim-missing' || (!p?.iccid && !p?.number);
    });
    
    return simMissingPhones.length;
  }
  
  // Track if we've loaded stats from backend (to prevent race conditions)
  let backendStatsLoaded = false;
  
  // Manual function to update stats - no reactive statements to avoid circular dependencies
  function updateStatsFromPhones() {
    if (phoneNumbers && phoneNumbers.length > 0 && !dataLoading) {
      const onlineCount = calculateOnlineDevices(phoneNumbers);
      const simMissingCount = calculateSimMissingDevices(phoneNumbers);
      if (onlineCount !== stats.onlineDevices || simMissingCount !== stats.simMissingDevices) {
        stats = { ...stats, onlineDevices: onlineCount, simMissingDevices: simMissingCount };
      }
    }
  }
  let selectedCountry = "all";
  let searchTerm = "";
  let showPhoneList = false;
  let messages = [];
  let phoneNumbers = [];
  let user = null;
  let loading = true;
  let dataLoading = true; // Track data loading separately
  let currentView = "dashboard"; // 'dashboard', 'iccid-mappings', or 'keywords'
  let showIccidMappingDialog = false;
  let toasts = [];
  let messageRequestId = 0; // Prevents stale message responses from overwriting newer ones

  function showToast(message, type = 'info', duration = 4000) {
    const id = Date.now();
    toasts = [...toasts, { id, message, type, duration }];
  }

  function removeToast(id) {
    toasts = toasts.filter(t => t.id !== id);
  }
  let phoneToMap = null;
  let daemonStatus = {
    status: 'unknown',
    message: 'Checking daemon status...',
    modem_count: 0,
    last_heartbeat: null,
    version: null,
    device_id: null,
    // Legacy fields for compatibility
    connected: true,
    lastDataUpdate: Date.now(),
    lastPhoneUpdate: Date.now(),
    healthCheckTime: Date.now(),
  };

  let stats = {
    totalMessages: 0,
    todayMessages: 0,
    totalSent: 0,
    totalReceived: 0,
    todaySent: 0,
    todayReceived: 0,
    onlineDevices: 0,
    totalDevices: 0,
    verificationRate: 0,
    simMissingDevices: 0,
  };
  
  
  // Hash routing handler
  function handleHashChange() {
    const hash = window.location.hash.slice(1);
    if (hash === 'keywords') {
      currentView = 'keywords';
    } else if (hash === 'iccid-mappings') {
      currentView = 'iccid-mappings';
    } else if (hash === 'dashboard' || hash === '') {
      currentView = 'dashboard';
    }
    
  }

  // Load data using HTTP API directly for better performance
  async function loadData() {
    // Only proceed if user is authenticated
    if (!user || !auth.token) {
      dataLoading = false;
      return;
    }
    
    try {
      // Load data via HTTP API (authenticatedFetch handles 401→logout)
      const [phonesResponse, messagesResponse, statsResponse] =
        await Promise.all([
          auth.authenticatedFetch("/api/phones")
            .then((r) => r.json())
            .catch((err) => {
              console.error('[App] Failed to fetch phones:', err);
              return { success: false, data: [] };
            }),
          auth.authenticatedFetch("/api/messages?limit=2000")
            .then(async (r) => {
              if (!r.ok) {
                console.error('[App] Messages API response not ok:', r.status, r.statusText);
                return { success: false, data: [], error: `HTTP ${r.status}` };
              }
              return r.json();
            })
            .catch((err) => {
              console.error('[App] Failed to fetch messages:', err);
              return { success: false, data: [] };
            }),
          auth.authenticatedFetch("/api/stats")
            .then((r) => r.json())
            .catch((err) => {
              console.error('[App] Failed to fetch stats:', err);
              return { success: false };
            }),
        ]);

      // Handle different response formats
      if (
        phonesResponse &&
        phonesResponse.data &&
        Array.isArray(phonesResponse.data)
      ) {
        phoneNumbers = phonesResponse.data.map(phone => ({
          ...phone,
          flag: getPhoneFlag(phone)
        }));
        updateStatsFromPhones();
        updateSelectedPhone();
      } else if (Array.isArray(phonesResponse)) {
        phoneNumbers = phonesResponse.map(phone => ({
          ...phone,
          flag: getPhoneFlag(phone)
        }));
        updateStatsFromPhones();
        updateSelectedPhone();
      } else {
        phoneNumbers = [];
        updateStatsFromPhones();
        updateSelectedPhone();
      }
      

      if (messagesResponse && messagesResponse.success && Array.isArray(messagesResponse.data)) {
        messages = messagesResponse.data;
      } else {
        console.error('[App] Messages API failed:', messagesResponse?.error);
        
        // If this is an auth error, try to re-authenticate
        if (messagesResponse?.error && messagesResponse.error.includes('HTTP 401')) {
          console.error('[App] Authentication error detected, forcing logout');
          auth.logout();
          return;
        }
        
        messages = [];
      }
      
      // Map API stats to component format
      if (statsResponse) {
        
        stats = mapStatsResponse(statsResponse);
        backendStatsLoaded = true;
        // Re-apply client-calculated device counts (more accurate than cached API stats)
        updateStatsFromPhones();

        // Check daemon status
        await checkDaemonStatus();
        
      }

      // Mark data as loaded
      dataLoading = false;
      // Update daemon status to show fresh data
      daemonStatus.lastDataUpdate = Date.now();
      daemonStatus.lastPhoneUpdate = Date.now();
      
      // Check daemon health based on recent phone data
      updateDaemonHealthStatus();
    } catch (error) {
      console.warn("Failed to load data:", error);
      // Use default values on error
      phoneNumbers = [];
      updateStatsFromPhones();
      messages = [];
      stats = {
        totalMessages: 0,
        todayMessages: 0,
        totalSent: 0,
        totalReceived: 0,
        todaySent: 0,
        todayReceived: 0,
        onlineDevices: 0,
        totalDevices: 0,
        verificationRate: 0,
      };
      // Mark data as loaded even on error
      dataLoading = false;
    }
  }

  onMount(async () => {
    if (window.location.search.includes("token=")) {
      await auth.handleCallback();
    }

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);

    try {
      if (auth.isAuthenticated()) {
        user = await auth.getUser();
      } else {
        const existingUser = await auth.getUser();
        if (existingUser) {
          user = existingUser;
        }
      }
    } catch (error) {
      // Authentication check failed
    }

    loading = false;

    if (user) {
      daemonStatus.connected = true;
      daemonStatus.lastDataUpdate = Date.now();

      loadData().finally(() => {
        dataLoading = false;
      }).catch((error) => {
        console.error("Failed to load data:", error);
      });
    } else {
      dataLoading = false;
    }
  });

  onDestroy(() => {
    window.removeEventListener('hashchange', handleHashChange);
  });

  function selectPhone(phone) {
    selectedPhoneIccid = phone?.iccid || null;
    handlePhoneSelection();
    showPhoneList = false;
  }
  
  // Load messages for a specific phone (race-condition safe)
  async function loadMessagesForPhone(phoneIccid) {
    if (!user || !auth.token) return;

    const requestId = ++messageRequestId;

    try {
      const response = await api.getMessages(
        phoneIccid
          ? { phone_iccid: phoneIccid, limit: 500 }
          : { limit: 2000 }
      );

      // Discard if user switched phones while we were loading
      if (requestId !== messageRequestId) return;

      if (response && response.data) {
        messages = response.data;
      }
    } catch (error) {
      if (requestId !== messageRequestId) return;
      console.error('[App] Failed to load messages:', error);
      messages = [];
    }
  }

  function handleSetIccidMapping(phone) {
    phoneToMap = phone;
    showIccidMappingDialog = true;
  }

  async function handleIccidMappingSuccess(event) {
    const { phone_iccid, phone_number } = event.detail;

    // Update the phone in our local list
    const phoneIndex = phoneNumbers.findIndex((p) => p.iccid === phone_iccid);
    if (phoneIndex !== -1) {
      phoneNumbers[phoneIndex] = {
        ...phoneNumbers[phoneIndex],
        number: phone_number,
      };
      phoneNumbers = [...phoneNumbers]; // Trigger reactivity
      updateStatsFromPhones();
      updateSelectedPhone();
    }

  }

  async function handleMessageSent(event) {
    const newMessage = event.detail;


    try {
      // Send message via HTTP API
      const response = await api.sendMessage({
        phone_iccid: newMessage.phone_iccid,
        recipient: newMessage.recipient,
        content: newMessage.content,
      });

      if (response.success) {
        // Add to local messages immediately with sending status using backend ID
        const sentMessage = {
          id: response.messageId, // Use the actual message ID from backend
          phone_iccid: newMessage.phone_iccid,
          phone_number: newMessage.recipient,
          recipient: newMessage.recipient,
          content: newMessage.content,
          timestamp: new Date().toISOString(),
          type: "sent",
          status: "sending",
        };

        messages = [sentMessage, ...messages];
        stats.totalMessages++;
        stats.todayMessages++;
      }
    } catch (error) {
      console.error("Failed to send message:", error);
      showToast("发送失败: " + error.message, 'error');
    }
  }

  function formatTimeAgo(timestamp) {
    if (!timestamp) return "从未";

    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    return `${Math.floor(diff / 86400000)}天前`;
  }

  // Update daemon health status based on recent data
  function updateDaemonHealthStatus() {
    const now = Date.now();
    const fiveMinutesAgo = now - (5 * 60 * 1000); // 5 minutes
    
    // If we have heartbeat-based status from API, check if it's still fresh
    if (daemonStatus.lastHeartbeat) {
      const heartbeatIsRecent = daemonStatus.lastHeartbeat > fiveMinutesAgo;
      daemonStatus.connected = heartbeatIsRecent;
    } else {
      // Fallback to data-based detection if no heartbeat
      const hasRecentPhoneData = phoneNumbers.some(phone => {
        return phone.status === 'active' || phone.status === 'online' || phone.status === 'registered';
      });
      
      const dataIsRecent = daemonStatus.lastDataUpdate > fiveMinutesAgo;
      const hasActivePhones = phoneNumbers.length > 0 && hasRecentPhoneData;
      
      daemonStatus.connected = dataIsRecent && (hasActivePhones || phoneNumbers.length === 0);
    }
    
    daemonStatus.healthCheckTime = now;
  }

  function getDaemonStatusText() {
    const statusMap = {
      'online': '在线',
      'warning': '警告',
      'offline': '离线',
      'error': '错误',
      'unknown': '未知'
    };
    return statusMap[daemonStatus.status] || '未知';
  }

  function getDaemonStatusClass() {
    const classMap = {
      'online': 'text-emerald-600',
      'warning': 'text-amber-600',
      'offline': 'text-red-500',
      'error': 'text-red-500',
      'unknown': 'text-stone-400'
    };
    return classMap[daemonStatus.status] || 'text-stone-400';
  }

  function getDaemonStatusIcon() {
    const iconMap = {
      'online': '🟢',
      'warning': '🟡',
      'offline': '🔴',
      'error': '🔴',
      'unknown': '⚪'
    };
    return iconMap[daemonStatus.status] || '⚪';
  }

  async function checkDaemonStatus() {
    try {
      const response = await fetch('/api/daemon/status');
      if (response.ok) {
        const data = await response.json();
        // Only show modem count when actually online
        const cleanData = {
          ...data,
          modem_count: data.status === 'online' ? (data.modem_count || 0) : undefined
        };
        daemonStatus = {
          ...cleanData,
          // Keep legacy fields for compatibility
          connected: data.status === 'online',
          lastDataUpdate: daemonStatus.lastDataUpdate,
          lastPhoneUpdate: daemonStatus.lastPhoneUpdate,
          healthCheckTime: daemonStatus.healthCheckTime
        };
        
        // Only fetch stats if user is authenticated (stats API requires auth)
        if (user && auth.token) {
          await fetchStats();
        }
      } else {
        daemonStatus = {
          ...daemonStatus,
          status: 'error',
          message: 'Failed to check daemon status',
          connected: false,
          modem_count: undefined
        };
      }
    } catch (error) {
      console.error('Failed to check daemon status:', error);
      daemonStatus = {
        ...daemonStatus,
        status: 'error',
        message: 'Cannot connect to server',
        connected: false,
        modem_count: undefined
      };
    }
  }
  
  async function fetchStats() {
    if (!user || !auth.token) {
      return;
    }

    try {
      const response = await auth.authenticatedFetch('/api/stats');
      if (response.ok) {
        const data = await response.json();
        
        stats = mapStatsResponse(data);
        backendStatsLoaded = true;
        // Re-apply client-calculated device counts (more accurate than cached API stats)
        updateStatsFromPhones();
      }
    } catch (error) {
      console.error('Failed to fetch stats from API:', error);
    }
  }

</script>

{#if loading}
  <div class="min-h-screen flex items-center justify-center bg-[#F7F5F2]">
    <div class="text-center">
      <div class="inline-flex items-center">
        <svg class="animate-spin h-8 w-8 text-stone-400 mr-3" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span class="text-xl text-stone-600">加载中...</span>
      </div>
    </div>
  </div>
{:else if !user}
  <div class="min-h-screen flex items-center justify-center bg-[#F7F5F2]">
    <div class="text-center bg-white border border-stone-200 rounded-xl p-10 shadow-sm">
      <h1 class="text-2xl font-semibold mb-3 text-stone-900">短信验证码管理系统</h1>
      <p class="text-stone-500 mb-6">请登录以继续</p>
      <button
        on:click={() => auth.login()}
        class="px-6 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg transition-colors font-medium"
      >
        使用 Auth0 登录
      </button>
    </div>
  </div>
{:else}
  <div class="min-h-screen lg:h-screen lg:flex lg:flex-col lg:overflow-hidden bg-[#F7F5F2]">
    <!-- Header -->
    <header class="bg-white border-b border-stone-200 sticky top-0 z-40 lg:flex-shrink-0">
      <div class="px-4">
        <div class="flex justify-between items-center h-16">
          <button
            class="lg:hidden p-2 -ml-2 text-stone-600 hover:bg-stone-100 rounded-lg transition-colors"
            on:click={() => (showPhoneList = !showPhoneList)}
            aria-label="切换手机列表"
          >
            <svg
              class="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>
          <h1 class="text-xl font-semibold text-stone-900">
            短信验证码管理系统
          </h1>

          <!-- Navigation -->
          <div class="hidden lg:flex items-center gap-1 flex-1 justify-center">
            <button
              on:click={() => {
                currentView = "dashboard";
                window.location.hash = 'dashboard';
              }}
              class="px-4 py-2 rounded-lg transition-all {currentView ===
              'dashboard'
                ? 'bg-orange-50 text-orange-700 font-semibold'
                : 'text-stone-500 hover:text-stone-900 hover:bg-stone-100'}"
            >
              消息管理
            </button>
            <button
              on:click={() => {
                currentView = "iccid-mappings";
                window.location.hash = 'iccid-mappings';
              }}
              class="px-4 py-2 rounded-lg transition-all {currentView ===
              'iccid-mappings'
                ? 'bg-orange-50 text-orange-700 font-semibold'
                : 'text-stone-500 hover:text-stone-900 hover:bg-stone-100'}"
            >
              ICCID 映射
            </button>
            <button
              on:click={() => {
                currentView = "keywords";
                window.location.hash = 'keywords';
              }}
              class="px-4 py-2 rounded-lg transition-all {currentView ===
              'keywords'
                ? 'bg-orange-50 text-orange-700 font-semibold'
                : 'text-stone-500 hover:text-stone-900 hover:bg-stone-100'}"
            >
              关键词高亮
            </button>
          </div>

          <div class="hidden lg:flex items-center gap-4">
            {#if user}
              <span class="text-sm text-stone-500"
                >欢迎, {user.name || user.email}</span
              >
              <button
                on:click={() => auth.logout()}
                class="text-sm px-3 py-1.5 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-lg border border-stone-200 transition-colors"
              >
                退出
              </button>
            {/if}
            <div class="flex items-center gap-4 text-sm text-stone-500">
              <!-- Daemon Status -->
              <div class="flex items-center gap-2">
                <span class="text-lg">{getDaemonStatusIcon()}</span>
                <span class="{getDaemonStatusClass()} text-sm font-medium">
                  {#if daemonStatus.status === 'online'}
                    守护进程: {getDaemonStatusText()} ({daemonStatus.modem_count || 0} 设备)
                  {:else if daemonStatus.status === 'warning'}
                    守护进程: {getDaemonStatusText()}
                  {:else if daemonStatus.status === 'offline'}
                    守护进程: {getDaemonStatusText()}
                  {:else}
                    守护进程: 等待连接...
                  {/if}
                </span>
                <button
                  on:click={checkDaemonStatus}
                  class="text-xs text-stone-400 hover:text-stone-600 transition-colors ml-1"
                  title="刷新状态"
                >
                  🔄
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
    <!-- Content below header fills remaining height on desktop -->
    <div class="lg:flex-1 lg:min-h-0 lg:flex lg:flex-col lg:overflow-hidden">

    <!-- Daemon Status Alert Banner -->
    {#if daemonStatus.status === 'offline' || daemonStatus.status === 'error'}
      <div class="bg-red-50 border-b border-red-200 px-4 py-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <svg
              class="w-5 h-5 text-red-600 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span class="text-sm text-red-800">
              <strong>守护进程{daemonStatus.status === 'error' ? '错误' : '离线'}</strong> - {daemonStatus.message || '设备数据可能不是最新的'}
              {#if daemonStatus.last_heartbeat}
                • 最后心跳: {formatTimeAgo(daemonStatus.last_heartbeat)}
              {/if}
            </span>
          </div>
          <div class="flex items-center gap-2">
            <button
              on:click={() => window.location.reload()}
              class="text-xs text-red-600 hover:text-red-700 underline"
            >
              刷新页面
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Status Alert Banner -->
    {#if phoneNumbers.some((p) => p.status === "searching" || p.status === "failed")}
      <div class="bg-yellow-50 border-b border-yellow-200 px-4 py-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <svg
              class="w-5 h-5 text-yellow-600 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <span class="text-sm text-yellow-800">
              {#if phoneNumbers.filter((p) => p.status === "searching").length > 0}
                <strong
                  >{phoneNumbers.filter((p) => p.status === "searching")
                    .length}</strong
                > 张SIM卡正在搜索网络
              {/if}
              {#if phoneNumbers.filter((p) => p.status === "failed").length > 0}
                {#if phoneNumbers.filter((p) => p.status === "searching").length > 0}
                  •
                {/if}
                <strong
                  >{phoneNumbers.filter((p) => p.status === "failed")
                    .length}</strong
                > 张SIM卡连接故障
              {/if}
            </span>
          </div>
          <button
            on:click={() => (currentView = "dashboard")}
            class="text-xs text-yellow-600 hover:text-yellow-700 underline"
          >
            查看详情
          </button>
        </div>
      </div>
    {/if}

    <!-- Mobile Navigation -->
    <div class="lg:hidden px-4 py-2 bg-white border-b border-stone-200">
      <div class="flex gap-2">
        <button
          on:click={() => (currentView = "dashboard")}
          class="flex-1 px-3 py-2 rounded-lg text-sm transition-all {currentView ===
          'dashboard'
            ? 'bg-orange-50 text-orange-700 font-semibold'
            : 'text-stone-500 hover:bg-stone-100'}"
        >
          消息管理
        </button>
        <button
          on:click={() => {
            currentView = "iccid-mappings";
          }}
          class="flex-1 px-3 py-2 rounded-lg text-sm transition-all {currentView ===
          'iccid-mappings'
            ? 'bg-orange-50 text-orange-700 font-semibold'
            : 'text-stone-500 hover:bg-stone-100'}"
        >
          ICCID 映射
        </button>
        <button
          on:click={() => {
            currentView = "keywords";
          }}
          class="flex-1 px-3 py-2 rounded-lg text-sm transition-all {currentView ===
          'keywords'
            ? 'bg-orange-50 text-orange-700 font-semibold'
            : 'text-stone-500 hover:bg-stone-100'}"
        >
          关键词
        </button>
      </div>
    </div>

    {#if currentView === "dashboard"}
      <!-- Mobile Stats (Horizontal Scroll) -->
      <div class="lg:hidden overflow-x-auto px-4 py-4">
        <div class="flex gap-3 min-w-max">
          <div
            class="bg-white border border-stone-200 rounded-lg text-stone-900 px-4 py-3 shadow-sm"
          >
            <div class="text-xs text-stone-500 font-medium">在线设备</div>
            <div class="text-xl font-bold data-value high-contrast" title="Online: {stats.onlineDevices}, Total: {stats.totalDevices}, Phones: {phoneNumbers.length}">
              {#key stats.onlineDevices + ':' + stats.totalDevices}
                {stats.onlineDevices}/{stats.totalDevices}
              {/key}
            </div>
          </div>
          <div
            class="bg-white border border-stone-200 rounded-lg text-stone-900 px-4 py-3 shadow-sm"
          >
            <div class="text-xs text-stone-500 font-medium">今日接收</div>
            <div class="text-xl font-bold data-value high-contrast">{stats.todayReceived || 0}</div>
          </div>
          <div
            class="bg-white border border-stone-200 rounded-lg text-stone-900 px-4 py-3 shadow-sm"
          >
            <div class="text-xs text-stone-500 font-medium">今日发送</div>
            <div class="text-xl font-bold data-value high-contrast">{stats.todaySent || 0}</div>
          </div>
          <div
            class="bg-white border border-stone-200 rounded-lg text-stone-900 px-4 py-3 shadow-sm"
          >
            <div class="text-xs text-stone-500 font-medium">总接收</div>
            <div class="text-xl font-bold data-value high-contrast">{stats.totalReceived || 0}</div>
          </div>
          <div
            class="bg-white border border-stone-200 rounded-lg text-stone-900 px-4 py-3 shadow-sm"
          >
            <div class="text-xs text-stone-500 font-medium">总发送</div>
            <div class="text-xl font-bold data-value high-contrast">{stats.totalSent || 0}</div>
          </div>
          <div
            class="bg-white border border-stone-200 rounded-lg text-stone-900 px-4 py-3 shadow-sm"
          >
            <div class="text-xs text-stone-500 font-medium">提取成功率</div>
            <div class="text-xl font-bold data-value high-contrast">{stats.verificationRate || 0}%</div>
          </div>
        </div>
      </div>
    {/if}

    {#if currentView === "dashboard"}
      <ErrorBoundary componentName="Dashboard">
        <!-- Desktop Stats Bar -->
        <div class="hidden lg:block lg:flex-shrink-0 px-8 py-3">
          <div class="bg-white border border-stone-200 rounded-xl shadow-sm flex divide-x divide-stone-100">
            <div class="flex-1 px-5 py-3 min-w-0">
              <div class="text-[10px] font-semibold text-stone-400 uppercase tracking-widest mb-1">在线设备</div>
              <div class="font-mono text-xl font-bold text-stone-900 leading-none">
                {stats.onlineDevices}<span class="text-stone-400 font-normal text-sm"> / {stats.totalDevices}</span>
              </div>
            </div>
            <div class="flex-1 px-5 py-3 min-w-0">
              <div class="text-[10px] font-semibold text-stone-400 uppercase tracking-widest mb-1">今日接收</div>
              <div class="font-mono text-xl font-bold text-stone-900 leading-none">{stats.todayReceived || 0}</div>
            </div>
            <div class="flex-1 px-5 py-3 min-w-0">
              <div class="text-[10px] font-semibold text-stone-400 uppercase tracking-widest mb-1">今日发送</div>
              <div class="font-mono text-xl font-bold text-stone-900 leading-none">{stats.todaySent || 0}</div>
            </div>
            <div class="flex-1 px-5 py-3 min-w-0">
              <div class="text-[10px] font-semibold text-stone-400 uppercase tracking-widest mb-1">需要SIM卡</div>
              <div class="font-mono text-xl font-bold leading-none {stats.simMissingDevices > 0 ? 'text-orange-600' : 'text-stone-900'}">{stats.simMissingDevices || 0}</div>
            </div>
            <div class="flex-1 px-5 py-3 min-w-0">
              <div class="text-[10px] font-semibold text-stone-400 uppercase tracking-widest mb-1">总接收消息</div>
              <div class="font-mono text-xl font-bold text-stone-900 leading-none">{stats.totalReceived || 0}</div>
            </div>
            <div class="flex-1 px-5 py-3 min-w-0">
              <div class="text-[10px] font-semibold text-stone-400 uppercase tracking-widest mb-1">总发送消息</div>
              <div class="font-mono text-xl font-bold text-stone-900 leading-none">{stats.totalSent || 0}</div>
            </div>
          </div>
        </div>

      <!-- Main Content -->
      <div class="lg:flex-1 lg:min-h-0 lg:px-8 lg:pb-4 lg:flex lg:flex-col">
        <div class="lg:grid lg:grid-cols-4 lg:gap-6 lg:flex-1 lg:min-h-0">
          <!-- Mobile Phone List Overlay -->
          {#if showPhoneList}
            <div
              class="lg:hidden fixed inset-0 z-50 bg-stone-900/40"
              on:click={() => (showPhoneList = false)}
              on:keydown={(e) => e.key === "Escape" && (showPhoneList = false)}
              role="button"
              tabindex="0"
              aria-label="关闭手机列表"
            >
              <div
                class="absolute left-0 top-0 bottom-0 w-80 max-w-full bg-white shadow-xl border-r border-stone-200"
                on:click|stopPropagation
                on:keydown|stopPropagation
                role="dialog"
                tabindex="-1"
                aria-label="手机列表"
              >
                <div class="h-full overflow-y-auto">
                  <PhoneList
                    {phoneNumbers}
                    {selectedPhone}
                    bind:selectedPhoneIccid
                    bind:selectedCountry
                    bind:searchTerm
                    onSelectPhone={selectPhone}
                    onSetIccidMapping={handleSetIccidMapping}
                    mobile={true}
                    {daemonStatus}
                    isLoading={dataLoading}
                  />
                </div>
              </div>
            </div>
          {/if}

          <!-- Desktop Phone List -->
          <div class="hidden lg:flex lg:flex-col lg:col-span-1 h-full min-h-0">
            <PhoneList
              {phoneNumbers}
              {selectedPhone}
              bind:selectedPhoneIccid
              bind:selectedCountry
              bind:searchTerm
              onSelectPhone={selectPhone}
              onSetIccidMapping={handleSetIccidMapping}
              {daemonStatus}
              isLoading={dataLoading}
            />
          </div>

          <!-- Message View Column -->
          <div class="lg:col-span-2 flex flex-col gap-4 h-full min-h-0">
            <!-- Always show SimpleMessageView at the top -->
            <div class="flex-1 min-h-0 flex flex-col">
              <SimpleMessageView {messages} {selectedPhone} isLoading={dataLoading} />
            </div>
            <!-- Show PhoneDetails below if selected -->
            {#if selectedPhone}
              <div class="flex-shrink-0">
                <PhoneDetails
                  phone={selectedPhone}
                  mobile={false}
                  {daemonStatus}
                />
              </div>
            {/if}
          </div>

          <!-- Message Composer -->
          <div class="lg:col-span-1 h-full min-h-0">
            <MessageComposer
              {selectedPhone}
              {phoneNumbers}
              {messages}
              on:messageSent={handleMessageSent}
            />
          </div>
        </div>
      </div>
      </ErrorBoundary>
    {:else if currentView === "iccid-mappings"}
      <ErrorBoundary componentName="IccidMappings">
        <!-- ICCID Mappings View -->
        <div class="px-4 lg:px-8 py-6 lg:flex-1 lg:min-h-0 lg:overflow-auto">
          <IccidMappings />
        </div>
      </ErrorBoundary>
    {:else if currentView === "keywords"}
      <ErrorBoundary componentName="Keywords">
        <!-- Keywords Configuration View -->
        <div class="px-4 lg:px-8 py-6 lg:flex-1 lg:min-h-0 lg:overflow-auto">
          <KeywordConfig />
        </div>
      </ErrorBoundary>
    {/if}
    </div><!-- end content wrapper -->
  </div><!-- end outer -->
{/if}

<!-- ICCID Mapping Dialog -->
<IccidMappingDialog
  phone={phoneToMap}
  bind:show={showIccidMappingDialog}
  on:success={handleIccidMappingSuccess}
  on:close={() => {
    phoneToMap = null;
    showIccidMappingDialog = false;
  }}
/>

<!-- Toast notifications -->
{#each toasts as toast (toast.id)}
  <Toast message={toast.message} type={toast.type} duration={toast.duration} onClose={() => removeToast(toast.id)} />
{/each}

