<script>
  import { onMount, onDestroy } from "svelte";
  import PhoneList from "./lib/PhoneList.svelte";
  import SimpleMessageView from "./lib/SimpleMessageView.svelte";
  import MessageComposer from "./lib/MessageComposer.svelte";
  import IccidMappings from "./lib/IccidMappings.svelte";
  import PhoneDetails from "./lib/PhoneDetails.svelte";
  import IccidMappingDialog from "./lib/IccidMappingDialog.svelte";
  import KeywordConfig from "./lib/KeywordConfig.svelte";
  import FilterRules from "./lib/FilterRules.svelte";
  import UserManagement from "./lib/UserManagement.svelte";
  import ErrorBoundary from "./lib/ErrorBoundary.svelte";
  import Toast from "./lib/Toast.svelte";
  import { api } from "./lib/api.js";
  import { getPhoneFlag, mapStatsResponse } from "./lib/countries.js";
  import { auth } from "./lib/auth.js";

  let selectedPhoneIccid = $state(null);
  let selectedPhone = $state(null);
  
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
      const hasOnlineStatus = p?.status === 'active';
      if (!hasOnlineStatus) {
        return false;
      }
      if (!p.updated_at) {
        return false;
      }
      
      try {
        // D1 returns timestamps without timezone suffix — treat as UTC
        const raw = p.updated_at.endsWith('Z') ? p.updated_at : p.updated_at + 'Z';
        const updateTime = new Date(raw).getTime();
        const isRecent = !isNaN(updateTime) && updateTime > fiveMinutesAgo;
        return isRecent;
      } catch (e) {
        console.warn('Invalid date for phone:', p.iccid, p.updated_at);
        return false;
      }
    });
    
    return onlinePhones.length;
  }
  
  // Track if we've loaded stats from backend (to prevent race conditions)
  let backendStatsLoaded = $state(false);

  // Manual function to update stats - no reactive statements to avoid circular dependencies
  function updateStatsFromPhones() {
    if (phoneNumbers && phoneNumbers.length > 0) {
      const onlineCount = calculateOnlineDevices(phoneNumbers);
      if (onlineCount !== stats.onlineDevices) {
        stats.onlineDevices = onlineCount;
      }
    }
  }
  let selectedCountry = $state("all");
  let searchTerm = $state("");
  let showPhoneList = $state(false);
  let messages = $state([]);
  let phoneNumbers = $state([]);
  let user = $state(null);
  let loading = $state(true);
  let dataLoading = $state(true); // Track data loading separately
  let currentView = $state("dashboard"); // 'dashboard', 'iccid-mappings', or 'keywords'
  let iccidMappingsFilter = $state("all");
  let showIccidMappingDialog = $state(false);
  let toasts = $state([]);
  let messageRequestId = 0; // Prevents stale message responses from overwriting newer ones
  let pollInterval = null;
  const POLL_INTERVAL_MS = 15000; // 15 seconds
  let newMessageIds = $state(new Set()); // Track newly arrived message IDs for "新" badge

  // Spam/marketing filtering. Hidden by default; the count is always shown so the
  // filter is never silent, and toggling refetches with include_filtered=1.
  let showFiltered = $state(false);
  let filteredCount = $state(0);
  let filterRules = $state([]); // Loaded lazily, only to name the rule that hid a message

  async function toggleFiltered() {
    showFiltered = !showFiltered;
    if (showFiltered && filterRules.length === 0) {
      try {
        const response = await api.get('/api/filters');
        filterRules = response?.filters || [];
      } catch (error) {
        console.warn('[App] Could not load filter rules for labels:', error);
      }
    }
    await loadMessagesForPhone(selectedPhoneIccid);
  }
  let lastKnownTimestamp = $state(null); // Only flag messages newer than this as "新"
  let daemonRefreshing = $state(false);

  function showToast(message, type = 'info', duration = 4000) {
    const id = Date.now();
    toasts.push({ id, message, type, duration });
  }

  function removeToast(id) {
    toasts = toasts.filter(t => t.id !== id);
  }
  let phoneToMap = $state(null);
  let daemonStatus = $state({
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
  });

  let stats = $state({
    totalMessages: 0,
    todayMessages: 0,
    totalSent: 0,
    totalReceived: 0,
    todaySent: 0,
    todayReceived: 0,
    onlineDevices: 0,
    totalDevices: 0,
    verificationRate: 0,
  });


  // Permission gate. `user.permissions` comes from /api/auth/me, which derives it from
  // the caller's Auth0 roles. This is UX only — the server enforces the same rules on
  // every endpoint, so hiding a control is a convenience, never a security boundary.
  // Reading `user` inside the function body is enough for runes to re-track it.
  function can(permission) {
    return user?.permissions?.includes(permission) ?? false;
  }

  // Which permission each view requires. Used both for nav visibility and for the hash
  // guard below, so the two cannot disagree.
  const VIEW_PERMISSION = {
    dashboard: 'messages.read',
    'iccid-mappings': 'phones.write',
    keywords: 'keywords.read',
    filters: 'filters.read',
    users: 'users.read',
  };

  function navigate(view) {
    currentView = view;
    window.location.hash = view;
  }

  // Hash routing handler
  function handleHashChange() {
    const hash = window.location.hash.slice(1);
    const requested = hash === '' ? 'dashboard' : hash;

    if (!(requested in VIEW_PERMISSION)) return;

    // A viewer typing #keywords would otherwise land on a page whose every API call
    // 403s, which looks like a broken app rather than a permission boundary.
    if (user && !can(VIEW_PERMISSION[requested])) {
      currentView = 'dashboard';
      window.location.hash = 'dashboard';
      return;
    }

    currentView = requested;
  }

  // Re-run the guard once permissions arrive: onMount fires handleHashChange before
  // getUser() resolves, so a deep link is validated only after `user` is known.
  $effect(() => {
    if (user) handleHashChange();
  });

  // Load data using HTTP API directly for better performance
  async function loadData() {
    // Only proceed if user is authenticated
    if (!user) {
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
        // Set high-water mark so polls only flag messages newer than what we loaded
        const newest = messages.reduce((max, m) => {
          const t = m.timestamp ? new Date(m.timestamp).getTime() : 0;
          return t > max ? t : max;
        }, 0);
        if (newest > 0) lastKnownTimestamp = new Date(newest).toISOString();
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
        stats = {
          ...mapStatsResponse(statsResponse),
        };
        backendStatsLoaded = true;
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
    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);

    // No callback step and no token to pick out of the URL: the session arrives as an
    // HttpOnly cookie, so asking the server who we are is the only check.
    // See docs/SECURITY-REVIEW.md finding 4.
    try {
      user = await auth.getUser();
    } catch (error) {
      // Authentication check failed
    }

    loading = false;

    if (user) {
      daemonStatus.connected = true;
      daemonStatus.lastDataUpdate = Date.now();

      loadData().finally(() => {
        dataLoading = false;
        startPolling();
      }).catch((error) => {
        console.error("Failed to load data:", error);
      });
    } else {
      dataLoading = false;
    }
  });

  onDestroy(() => {
    stopPolling();
    window.removeEventListener('hashchange', handleHashChange);
  });

  function selectPhone(phone) {
    selectedPhoneIccid = phone?.iccid || null;
    handlePhoneSelection();
    showPhoneList = false;
  }
  
  // Load messages for a specific phone (race-condition safe)
  async function loadMessagesForPhone(phoneIccid) {
    if (!user) return;

    const requestId = ++messageRequestId;

    try {
      const response = await api.getMessages({
        ...(phoneIccid ? { phone_iccid: phoneIccid, limit: 500 } : { limit: 2000 }),
        ...(showFiltered ? { include_filtered: 1 } : {})
      });

      // Discard if user switched phones while we were loading
      if (requestId !== messageRequestId) return;

      // Keep the badge count fresh even when the offline cache served the list.
      if (response?.pagination?.filtered_count !== undefined) {
        filteredCount = response.pagination.filtered_count;
      }

      if (response && response.data) {
        // Detect genuinely new messages: must have a timestamp newer than anything we've seen
        if (lastKnownTimestamp && messages.length > 0) {
          const cutoff = new Date(lastKnownTimestamp).getTime();
          console.log('[New Message Detection] lastKnownTimestamp:', lastKnownTimestamp, 'cutoff:', new Date(cutoff));
          const freshIds = response.data
            .filter(m => m.timestamp && new Date(m.timestamp).getTime() > cutoff)
            .map(m => m.id);
          console.log('[New Message Detection] Found', freshIds.length, 'new messages:', freshIds);
          if (freshIds.length > 0) {
            freshIds.forEach(id => newMessageIds.add(id));
            console.log('[New Message Detection] Added new message IDs, newMessageIds size:', newMessageIds.size);
            // Auto-clear "新" badges after 10 seconds (design: highlight fades to a normal row)
            setTimeout(() => {
              freshIds.forEach(id => newMessageIds.delete(id));
              console.log('[New Message Detection] Auto-cleared badges after 10s');
            }, 10000);
          }
        } else {
          console.log('[New Message Detection] Skipped - lastKnownTimestamp:', lastKnownTimestamp, 'messages.length:', messages.length);
        }
        // Update the high-water mark to the newest timestamp in this batch
        const newest = response.data.reduce((max, m) => {
          const t = m.timestamp ? new Date(m.timestamp).getTime() : 0;
          return t > max ? t : max;
        }, lastKnownTimestamp ? new Date(lastKnownTimestamp).getTime() : 0);
        if (newest > 0) lastKnownTimestamp = new Date(newest).toISOString();
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

  async function handleIccidMappingSuccess({ phone_iccid, phone_number }) {

    // Update the phone in our local list
    const phoneIndex = phoneNumbers.findIndex((p) => p.iccid === phone_iccid);
    if (phoneIndex !== -1) {
      phoneNumbers[phoneIndex] = {
        ...phoneNumbers[phoneIndex],
        number: phone_number,
      };
      updateStatsFromPhones();
      updateSelectedPhone();
    }

  }

  async function handleMessageSent(newMessage) {


    try {
      // Send message via HTTP API
      const response = await api.sendMessage({
        phone_iccid: newMessage.phone_iccid,
        recipient: newMessage.recipient,
        content: newMessage.content,
      });

      if (response.success) {
        // Find the sender's phone number from the selected SIM's ICCID
        const senderPhone = phoneNumbers.find(p => p.iccid === newMessage.phone_iccid);
        const senderNumber = senderPhone?.number || newMessage.phone_iccid;

        // Add to local messages immediately with sending status using backend ID
        const sentMessage = {
          id: response.messageId, // Use the actual message ID from backend
          phone_iccid: newMessage.phone_iccid,
          phone_number: senderNumber, // CORRECT: Sender's number (发送卡号)
          recipient: newMessage.recipient, // CORRECT: Recipient's number (接收号码)
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
        return phone.status === 'active';
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
        if (user) {
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

  async function handleRefreshDaemon() {
    daemonRefreshing = true;
    try {
      await checkDaemonStatus();
    } finally {
      daemonRefreshing = false;
    }
  }

  async function fetchStats() {
    if (!user) {
      return;
    }

    try {
      const response = await auth.authenticatedFetch('/api/stats');
      if (response.ok) {
        const data = await response.json();

        stats = {
          ...mapStatsResponse(data),
        };
        backendStatsLoaded = true;
      }
    } catch (error) {
      console.error('Failed to fetch stats from API:', error);
    }
  }

  // Background polling for new messages and device status
  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(async () => {
      if (!user || currentView !== 'dashboard') return;
      try {
        // Poll messages for current view
        await loadMessagesForPhone(selectedPhoneIccid);
        // Also refresh device status + stats
        await checkDaemonStatus();
      } catch (e) {
        // Silently ignore polling errors
      }
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
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
        onclick={() => auth.login()}
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
            onclick={() => (showPhoneList = !showPhoneList)}
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

          <!-- Navigation. Each entry is gated on the same permission the hash guard
               uses, so nav and routing cannot disagree. Server-side checks are the real
               boundary; this only avoids showing a viewer pages that would 403. -->
          <div class="hidden lg:flex items-center gap-1 flex-1 justify-center">
            <button
              onclick={() => navigate("dashboard")}
              class="px-4 py-2 rounded-lg transition-all {currentView ===
              'dashboard'
                ? 'bg-orange-50 text-orange-700 font-semibold'
                : 'text-stone-500 hover:text-stone-900 hover:bg-stone-100'}"
            >
              消息管理
            </button>
            {#if can('phones.write')}
              <button
                onclick={() => {
                  iccidMappingsFilter = "all";
                  navigate("iccid-mappings");
                }}
                class="px-4 py-2 rounded-lg transition-all {currentView ===
                'iccid-mappings'
                  ? 'bg-orange-50 text-orange-700 font-semibold'
                  : 'text-stone-500 hover:text-stone-900 hover:bg-stone-100'}"
              >
                ICCID 映射
              </button>
            {/if}
            {#if can('keywords.read')}
              <button
                onclick={() => navigate("keywords")}
                class="px-4 py-2 rounded-lg transition-all {currentView ===
                'keywords'
                  ? 'bg-orange-50 text-orange-700 font-semibold'
                  : 'text-stone-500 hover:text-stone-900 hover:bg-stone-100'}"
              >
                关键词高亮
              </button>
            {/if}
            {#if can('filters.read')}
              <button
                onclick={() => navigate("filters")}
                class="px-4 py-2 rounded-lg transition-all {currentView ===
                'filters'
                  ? 'bg-orange-50 text-orange-700 font-semibold'
                  : 'text-stone-500 hover:text-stone-900 hover:bg-stone-100'}"
              >
                垃圾过滤
              </button>
            {/if}
            {#if can('users.read')}
              <button
                onclick={() => navigate("users")}
                class="px-4 py-2 rounded-lg transition-all {currentView ===
                'users'
                  ? 'bg-orange-50 text-orange-700 font-semibold'
                  : 'text-stone-500 hover:text-stone-900 hover:bg-stone-100'}"
              >
                用户管理
              </button>
            {/if}
          </div>

          <div class="hidden lg:flex items-center gap-4">
            {#if user}
              <span class="text-sm text-stone-500"
                >欢迎, {user.name || user.email}</span
              >
              <button
                onclick={() => auth.logout()}
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
                    守护进程: {getDaemonStatusText()}
                  {:else if daemonStatus.status === 'warning'}
                    守护进程: {getDaemonStatusText()}
                  {:else if daemonStatus.status === 'offline'}
                    守护进程: {getDaemonStatusText()}
                  {:else}
                    守护进程: 等待连接...
                  {/if}
                </span>
                <button
                  onclick={handleRefreshDaemon}
                  class="text-xs text-stone-400 hover:text-stone-600 transition-colors ml-1 {daemonRefreshing ? 'animate-spin' : ''}"
                  title="刷新状态"
                  disabled={daemonRefreshing}
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
              onclick={() => window.location.reload()}
              class="text-xs text-red-600 hover:text-red-700 underline"
            >
              刷新页面
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Status Alert Banner -->
    {#if phoneNumbers.some((p) => ['sim_error', 'iccid_mismatch'].includes(p.status))}
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
              {#if phoneNumbers.filter((p) => p.status === "sim_error").length > 0}
                <strong
                  >{phoneNumbers.filter((p) => p.status === "sim_error")
                    .length}</strong
                > 张SIM卡读取失败
              {/if}
              {#if phoneNumbers.filter((p) => p.status === "iccid_mismatch").length > 0}
                {#if phoneNumbers.filter((p) => p.status === "sim_error").length > 0}
                  •
                {/if}
                <strong
                  >{phoneNumbers.filter((p) => p.status === "iccid_mismatch")
                    .length}</strong
                > 张SIM卡ICCID不匹配
              {/if}
            </span>
          </div>
          {#if can('phones.write')}
            <!-- Deep-links into the ICCID page, which a viewer cannot open — the hash
                 guard would bounce them straight back to the dashboard. -->
            <button
              onclick={() => { iccidMappingsFilter = "error"; navigate("iccid-mappings"); }}
              class="text-xs text-yellow-600 hover:text-yellow-700 underline"
            >
              查看详情
            </button>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Mobile Navigation -->
    <div class="lg:hidden px-4 py-2 bg-white border-b border-stone-200">
      <div class="flex gap-2">
        <button
          onclick={() => navigate("dashboard")}
          class="flex-1 px-3 py-2 rounded-lg text-sm transition-all {currentView ===
          'dashboard'
            ? 'bg-orange-50 text-orange-700 font-semibold'
            : 'text-stone-500 hover:bg-stone-100'}"
        >
          消息管理
        </button>
        {#if can('phones.write')}
          <button
            onclick={() => navigate("iccid-mappings")}
            class="flex-1 px-3 py-2 rounded-lg text-sm transition-all {currentView ===
            'iccid-mappings'
              ? 'bg-orange-50 text-orange-700 font-semibold'
              : 'text-stone-500 hover:bg-stone-100'}"
          >
            ICCID 映射
          </button>
        {/if}
        {#if can('keywords.read')}
          <button
            onclick={() => navigate("keywords")}
            class="flex-1 px-3 py-2 rounded-lg text-sm transition-all {currentView ===
            'keywords'
              ? 'bg-orange-50 text-orange-700 font-semibold'
              : 'text-stone-500 hover:bg-stone-100'}"
          >
            关键词
          </button>
        {/if}
        {#if can('filters.read')}
          <button
            onclick={() => navigate("filters")}
            class="flex-1 px-3 py-2 rounded-lg text-sm transition-all {currentView ===
            'filters'
              ? 'bg-orange-50 text-orange-700 font-semibold'
              : 'text-stone-500 hover:bg-stone-100'}"
          >
            垃圾过滤
          </button>
        {/if}
        {#if can('users.read')}
          <button
            onclick={() => navigate("users")}
            class="flex-1 px-3 py-2 rounded-lg text-sm transition-all {currentView ===
            'users'
              ? 'bg-orange-50 text-orange-700 font-semibold'
              : 'text-stone-500 hover:bg-stone-100'}"
          >
            用户管理
          </button>
        {/if}
      </div>
    </div>

    {#if currentView === "dashboard"}
      <ErrorBoundary componentName="Dashboard">
        <!-- Stats Bar -->
        <div class="lg:flex-shrink-0 px-2 sm:px-4 lg:px-8 py-2 sm:py-3 overflow-x-auto">
          <div class="bg-white border border-stone-200 rounded-xl shadow-sm flex divide-x divide-stone-100 min-w-max lg:min-w-0">
            <div class="flex-1 px-3 sm:px-4 lg:px-5 py-2 sm:py-3 min-w-0">
              <div class="text-[9px] sm:text-[10px] font-semibold text-stone-400 uppercase tracking-wider sm:tracking-widest mb-0.5 sm:mb-1 whitespace-nowrap">在线</div>
              <div class="font-mono text-lg sm:text-xl font-bold text-stone-900 leading-none whitespace-nowrap" title="Online: {stats.onlineDevices}, Total: {stats.totalDevices}, Phones: {phoneNumbers.length}">
                {#key stats.onlineDevices + ':' + stats.totalDevices}
                  {stats.onlineDevices}<span class="text-stone-400 font-normal text-xs sm:text-sm"> / {stats.totalDevices}</span>
                {/key}
              </div>
            </div>
            <div class="flex-1 px-3 sm:px-4 lg:px-5 py-2 sm:py-3 min-w-0">
              <div class="text-[9px] sm:text-[10px] font-semibold text-stone-400 uppercase tracking-wider sm:tracking-widest mb-0.5 sm:mb-1 whitespace-nowrap">今日接收</div>
              <div class="font-mono text-lg sm:text-xl font-bold text-stone-900 leading-none whitespace-nowrap">{stats.todayReceived || 0}</div>
            </div>
            <div class="flex-1 px-3 sm:px-4 lg:px-5 py-2 sm:py-3 min-w-0">
              <div class="text-[9px] sm:text-[10px] font-semibold text-stone-400 uppercase tracking-wider sm:tracking-widest mb-0.5 sm:mb-1 whitespace-nowrap">今日发送</div>
              <div class="font-mono text-lg sm:text-xl font-bold text-stone-900 leading-none whitespace-nowrap">{stats.todaySent || 0}</div>
            </div>
            <div class="flex-1 px-3 sm:px-4 lg:px-5 py-2 sm:py-3 min-w-0">
              <div class="text-[9px] sm:text-[10px] font-semibold text-stone-400 uppercase tracking-wider sm:tracking-widest mb-0.5 sm:mb-1 whitespace-nowrap">总接收</div>
              <div class="font-mono text-lg sm:text-xl font-bold text-stone-900 leading-none whitespace-nowrap">{stats.totalReceived || 0}</div>
            </div>
            <div class="flex-1 px-3 sm:px-4 lg:px-5 py-2 sm:py-3 min-w-0">
              <div class="text-[9px] sm:text-[10px] font-semibold text-stone-400 uppercase tracking-wider sm:tracking-widest mb-0.5 sm:mb-1 whitespace-nowrap">总发送</div>
              <div class="font-mono text-lg sm:text-xl font-bold text-stone-900 leading-none whitespace-nowrap">{stats.totalSent || 0}</div>
            </div>
            <div class="flex-1 px-3 sm:px-4 lg:px-5 py-2 sm:py-3 min-w-0">
              <div class="text-[9px] sm:text-[10px] font-semibold text-stone-400 uppercase tracking-wider sm:tracking-widest mb-0.5 sm:mb-1 whitespace-nowrap">成功率</div>
              <div class="font-mono text-lg sm:text-xl font-bold text-stone-900 leading-none whitespace-nowrap">{stats.verificationRate || 0}%</div>
            </div>
          </div>
        </div>

      <!-- Main Content -->
      <div class="px-2 sm:px-4 lg:px-8 lg:flex-1 lg:min-h-0 lg:pb-4 lg:flex lg:flex-col">
        <div class="lg:grid lg:grid-cols-4 lg:gap-6 lg:flex-1 lg:min-h-0">
          <!-- Mobile Phone List Overlay -->
          {#if showPhoneList}
            <div
              class="lg:hidden fixed inset-0 z-50 bg-stone-900/40"
              onclick={() => (showPhoneList = false)}
              onkeydown={(e) => e.key === "Escape" && (showPhoneList = false)}
              role="button"
              tabindex="0"
              aria-label="关闭手机列表"
            >
              <div
                class="absolute left-0 top-0 bottom-0 w-80 max-w-full bg-white shadow-xl border-r border-stone-200"
                onclick={(e) => e.stopPropagation()}
                onkeydown={(e) => e.stopPropagation()}
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
              <SimpleMessageView
                {messages}
                {selectedPhone}
                isLoading={dataLoading}
                {newMessageIds}
                onClearPhone={() => selectPhone(null)}
                {showFiltered}
                {filteredCount}
                {filterRules}
                onToggleFiltered={toggleFiltered}
              />
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

          <!-- Message Composer. Viewers currently DO hold messages.send, so this stays
               visible for them — gated anyway so the UI follows the permission model if
               that decision is ever revisited. -->
          {#if can('messages.send')}
            <div class="lg:col-span-1 h-full min-h-0">
              <MessageComposer
                {selectedPhone}
                {phoneNumbers}
                {messages}
                onmessagesent={handleMessageSent}
              />
            </div>
          {/if}
        </div>
      </div>
      </ErrorBoundary>
    {:else if currentView === "iccid-mappings"}
      <ErrorBoundary componentName="IccidMappings">
        <!-- ICCID Mappings View -->
        <div class="px-2 sm:px-4 lg:px-8 py-6 lg:flex-1 lg:min-h-0 lg:overflow-auto">
          <IccidMappings initialStatusFilter={iccidMappingsFilter} />
        </div>
      </ErrorBoundary>
    {:else if currentView === "keywords"}
      <ErrorBoundary componentName="Keywords">
        <!-- Keywords Configuration View -->
        <div class="px-4 lg:px-8 py-6 lg:flex-1 lg:min-h-0 lg:overflow-auto">
          <KeywordConfig />
        </div>
      </ErrorBoundary>
    {:else if currentView === "filters"}
      <ErrorBoundary componentName="FilterRules">
        <!-- Spam/marketing filter rules -->
        <div class="px-4 lg:px-8 py-6 lg:flex-1 lg:min-h-0 lg:overflow-auto">
          <FilterRules />
        </div>
      </ErrorBoundary>
    {:else if currentView === "users"}
      <ErrorBoundary componentName="UserManagement">
        <div class="px-4 lg:px-8 py-6 lg:flex-1 lg:min-h-0 lg:overflow-auto">
          <UserManagement currentUserId={user?.id ?? null} />
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
  onsuccess={handleIccidMappingSuccess}
  onclose={() => {
    phoneToMap = null;
    showIccidMappingDialog = false;
  }}
/>

<!-- Toast notifications -->
{#each toasts as toast (toast.id)}
  <Toast message={toast.message} type={toast.type} duration={toast.duration} onClose={() => removeToast(toast.id)} />
{/each}

