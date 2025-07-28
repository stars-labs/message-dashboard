<script>
  import { onMount, onDestroy } from "svelte";
  import PhoneList from "./lib/PhoneList.svelte";
  import MessageView from "./lib/MessageView.svelte";
  import MessageComposer from "./lib/MessageComposer.svelte";
  import StatsCard from "./lib/StatsCard.svelte";
  import IccidMappings from "./lib/IccidMappings.svelte";
  import PhoneDetails from "./lib/PhoneDetails.svelte";
  import IccidMappingDialog from "./lib/IccidMappingDialog.svelte";
  import { api } from "./lib/api.js";
  import { pollingService } from "./lib/polling-service.js";
  import { auth } from "./lib/auth.js";
  import config from "./lib/config.js";

  let selectedPhoneIccid = null;
  $: selectedPhone = selectedPhoneIccid
    ? phoneNumbers.find((p) => p.iccid === selectedPhoneIccid)
    : null;
  let selectedCountry = "all";
  let searchTerm = "";
  let showPhoneList = false;
  let messages = [];
  let phoneNumbers = [];
  let user = null;
  let loading = true;
  let dataLoading = true; // Track data loading separately
  let sseConnected = false;
  let sseUnsubscribers = [];
  let currentView = "dashboard"; // 'dashboard' or 'iccid-mappings'
  let showIccidMappingDialog = false;
  let phoneToMap = null;
  let daemonStatus = {
    connected: true, // Assume connected initially to avoid "数据过期" flash
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
  };

  // Load data using HTTP API directly for better performance
  async function loadData() {
    try {
      // Use HTTP API directly for initial load to avoid WebSocket timeout delays
      const token = auth.token || "anonymous";
      const headers = {
        Authorization: token !== "anonymous" ? `Bearer ${token}` : undefined,
        "Content-Type": "application/json",
      };

      // Make direct HTTP requests in parallel
      const [phonesResponse, messagesResponse, statsResponse] =
        await Promise.all([
          fetch("/api/phones", { headers }).then((r) => r.json()),
          fetch("/api/messages?limit=100", { headers }).then((r) => r.json()),
          fetch("/api/stats", { headers }).then((r) => r.json()),
        ]);

      // Handle different response formats
      if (
        phonesResponse &&
        phonesResponse.data &&
        Array.isArray(phonesResponse.data)
      ) {
        phoneNumbers = phonesResponse.data;
      } else if (Array.isArray(phonesResponse)) {
        phoneNumbers = phonesResponse;
      } else {
        phoneNumbers = [];
      }

      console.log("Loaded phones:", phoneNumbers);
      // Log all phone details only if it's an array
      if (Array.isArray(phoneNumbers)) {
        phoneNumbers.forEach((phone) => {
          console.log(`Phone ${phone.iccid}:`, {
            signal: phone.signal,
            status: phone.status,
            operator_name: phone.operator_name,
            operator_id: phone.operator_id,
            imei: phone.imei,
            access_tech: phone.access_tech,
            iccid: phone.iccid,
            number: phone.number,
          });
        });
      }
      messages = messagesResponse.data || [];

      // Map API stats to component format
      if (statsResponse) {
        stats = {
          totalMessages: statsResponse.total_messages || 0,
          todayMessages: statsResponse.today_messages || 0,
          totalSent: statsResponse.total_sent || 0,
          totalReceived: statsResponse.total_received || 0,
          todaySent: statsResponse.today_sent || 0,
          todayReceived: statsResponse.today_received || 0,
          onlineDevices: phoneNumbers.filter((p) => 
            p.status === "online" || p.status === "active" || p.status === "registered"
          ).length,
          totalDevices: phoneNumbers.length,
          verificationRate: Math.round(
            (statsResponse.verification_rate || 0) * 100,
          ),
        };
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

  // Helper function to establish SSE connection
  async function connectSSE() {
    if (pollingService.isConnected) {
      console.log("[App] SSE already connected, skipping");
      return;
    }

    const token = auth.token || "anonymous";
    console.log(
      "[App] Connecting SSE with token:",
      !!auth.token ? "authenticated" : "anonymous",
    );

    try {
      await pollingService.connect(token);
      setupSSEListeners();
      console.log("[App] SSE connection established successfully");
    } catch (error) {
      console.error("[App] SSE connection failed:", error);
    }
  }

  onMount(async () => {
    // Check if returning from Auth0 callback
    if (window.location.search.includes("token=")) {
      await auth.handleCallback();
    }

    // Quick authentication check
    try {
      if (auth.isAuthenticated()) {
        user = await auth.getUser();
      } else {
        // Try to get user info if token exists
        const existingUser = await auth.getUser();
        if (existingUser) {
          user = existingUser;
        }
      }
    } catch (error) {
      // Authentication check failed
    }

    // Set loading to false immediately to show UI
    loading = false;

    // Load data and establish SSE connection in the background
    if (user) {
      // Mark daemon as initially connected to prevent "数据过期" message
      daemonStatus.connected = true;
      daemonStatus.lastDataUpdate = Date.now();

      // Load data and SSE in parallel without blocking
      Promise.all([
        loadData().finally(() => {
          dataLoading = false;
        }),
        connectSSE(),
      ]).catch((error) => {
        console.error("Failed to load data or connect SSE:", error);
      });
      
      // Set up periodic daemon health check
      const healthCheckInterval = setInterval(() => {
        updateDaemonHealthStatus();
      }, 60000); // Check every minute
      
      // Store interval for cleanup
      window._daemonHealthInterval = healthCheckInterval;
    } else {
      // Still try to connect SSE for anonymous users
      connectSSE().catch((error) => {
        console.error("Failed to connect SSE:", error);
      });
    }
  });

  function setupSSEListeners() {
    // Listen for new messages
    sseUnsubscribers.push(
      pollingService.on("message:created", (msg) => {
        // New message received
        messages = [msg.data, ...messages];
        // Update stats
        stats.totalMessages++;
        stats.todayMessages++;
      }),
    );

    // Listen for message updates
    sseUnsubscribers.push(
      pollingService.on("message:updated", (msg) => {
        // Message updated
        const index = messages.findIndex((m) => m.id === msg.data.id);
        if (index !== -1) {
          messages[index] = msg.data;
          messages = [...messages];
        }
      }),
    );

    // Listen for bulk message creation
    sseUnsubscribers.push(
      pollingService.on("messages:bulk_created", (msg) => {
        // Bulk messages received
        messages = [...msg.data, ...messages];
        // Update stats
        stats.totalMessages += msg.data.length;
        stats.todayMessages += msg.data.length;
      }),
    );

    // Listen for phone updates
    sseUnsubscribers.push(
      pollingService.on("phones:updated", (msg) => {
        // Phones updated
        console.log("SSE phones update:", msg.data);

        // Update daemon status when we receive phone data
        daemonStatus.lastPhoneUpdate = Date.now();
        daemonStatus.lastDataUpdate = Date.now();

        // Only update phones if we have valid data
        if (msg.data && Array.isArray(msg.data) && msg.data.length > 0) {
          // Replace all phones with the new data (don't append)
          // The daemon sends the complete list of phones
          // Filter out phones without valid ICCIDs
          phoneNumbers = msg.data
            .filter(
              (phone) =>
                phone.iccid &&
                phone.iccid.trim() !== "" &&
                !phone.iccid.startsWith("SIM_"),
            )
            .map((updatedPhone) => {
              console.log(
                `SSE Update - Phone ${updatedPhone.iccid}: signal=${updatedPhone.signal}, status=${updatedPhone.status}`,
              );
              // Ensure we have the proper structure
              return {
                ...updatedPhone,
              };
            });

          console.log("Updated phoneNumbers:", phoneNumbers);

          // Update online device count
          stats.onlineDevices = phoneNumbers.filter(
            (p) => p.status === "online" || p.status === "active" || p.status === "registered",
          ).length;
          stats.totalDevices = phoneNumbers.length;
          
          // Update daemon health status
          updateDaemonHealthStatus();
        }
      }),
    );

    // Listen for connection status
    sseUnsubscribers.push(
      pollingService.on("connected", () => {
        sseConnected = true;
        console.log("SSE connected");
      }),
    );

    // Listen for message sent responses
    sseUnsubscribers.push(
      pollingService.on("message:sent", (msg) => {
        // Message sent result received
        console.log("Message sent result:", msg.data);
        if (msg.data.success) {
          // Create message for local display
          const sentMessage = {
            id: `msg-sent-${Date.now()}`,
            phone_iccid: msg.data.phone_iccid || "",
            phone_number: msg.data.recipient || "",
            recipient: msg.data.recipient || "",
            content: msg.data.content || "",
            timestamp: new Date().toISOString(),
            type: "sent",
            status: "delivered",
            sms_id: msg.data.sms_id,
          };

          // Add to local messages
          messages = [sentMessage, ...messages];
          stats.totalMessages++;
          stats.todayMessages++;
        }
      }),
    );

    // Listen for disconnection
    sseUnsubscribers.push(
      pollingService.on("disconnected", () => {
        sseConnected = false;
        console.log("SSE disconnected");
      }),
    );
  }

  // No need for periodic refresh - using SSE real-time updates

  onDestroy(() => {
    // Cleanup realtime service
    sseUnsubscribers.forEach((unsubscribe) => unsubscribe());
    pollingService.disconnect();
    
    // Cleanup health check interval
    if (window._daemonHealthInterval) {
      clearInterval(window._daemonHealthInterval);
    }
  });

  function selectPhone(phone) {
    selectedPhoneIccid = phone?.iccid || null;
    showPhoneList = false;
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
    }

    // No need to reload - WebSocket will provide updates
  }

  async function handleMessageSent(event) {
    const newMessage = event.detail;

    console.log("Sending message via WebSocket:", newMessage);

    try {
      // Send message using WebSocket API
      const response = await api.sendMessage({
        phone_iccid: newMessage.phone_iccid,
        recipient: newMessage.recipient,
        content: newMessage.content,
      });

      if (response.success) {
        // Add to local messages immediately with sending status
        const sentMessage = {
          id: `msg-sent-${Date.now()}`,
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
      // Show error to user
      alert("Failed to send message: " + error.message);
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
    
    // Check if we have recent phone data (phones with recent status updates)
    const hasRecentPhoneData = phoneNumbers.some(phone => {
      return phone.status === 'active' || phone.status === 'online' || phone.status === 'registered';
    });
    
    // Daemon is considered online if:
    // 1. We have recent data update (within 5 minutes)
    // 2. We have phones with active/online status
    const dataIsRecent = daemonStatus.lastDataUpdate > fiveMinutesAgo;
    const hasActivePhones = phoneNumbers.length > 0 && hasRecentPhoneData;
    
    daemonStatus.connected = dataIsRecent && (hasActivePhones || phoneNumbers.length === 0);
    daemonStatus.healthCheckTime = now;
    
    console.log('Daemon health check:', {
      connected: daemonStatus.connected,
      dataIsRecent,
      hasActivePhones,
      phoneCount: phoneNumbers.length,
      lastDataUpdate: new Date(daemonStatus.lastDataUpdate).toLocaleString()
    });
  }

  function getDaemonStatusText() {
    if (!daemonStatus.connected) {
      return "离线";
    }
    return "在线";
  }

  function getDaemonStatusClass() {
    if (!daemonStatus.connected) {
      return "text-red-600";
    }
    return "text-green-600";
  }
</script>

{#if loading}
  <div class="min-h-screen flex items-center justify-center">
    <div class="text-center">
      <div class="inline-flex items-center">
        <svg
          class="animate-spin h-8 w-8 text-purple-600 mr-3"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          ></circle>
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          ></path>
        </svg>
        <span class="text-xl text-gray-600">加载中...</span>
      </div>
    </div>
  </div>
{:else if !user}
  <div
    class="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-indigo-100"
  >
    <div class="text-center bg-white p-8 rounded-xl shadow-lg">
      <h1 class="text-3xl font-bold text-gray-800 mb-4">短信验证码管理系统</h1>
      <p class="text-gray-600 mb-6">请登录以继续</p>
      <a
        href="/login"
        class="inline-block px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white font-medium rounded-lg transition-colors"
      >
        使用 Auth0 登录
      </a>
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
          <h1
            class="text-xl font-bold bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text text-transparent"
          >
            短信验证码管理系统
          </h1>

          <!-- Navigation -->
          <div class="hidden lg:flex items-center gap-4 flex-1 justify-center">
            <button
              on:click={() => (currentView = "dashboard")}
              class="px-4 py-2 rounded-lg transition-colors {currentView ===
              'dashboard'
                ? 'bg-purple-100 text-purple-700'
                : 'text-gray-600 hover:bg-gray-100'}"
            >
              消息管理
            </button>
            <button
              on:click={() => (currentView = "iccid-mappings")}
              class="px-4 py-2 rounded-lg transition-colors {currentView ===
              'iccid-mappings'
                ? 'bg-purple-100 text-purple-700'
                : 'text-gray-600 hover:bg-gray-100'}"
            >
              ICCID 映射
            </button>
          </div>

          <div class="hidden lg:flex items-center gap-4">
            {#if user}
              <span class="text-sm text-gray-600"
                >欢迎, {user.name || user.email}</span
              >
              <button
                on:click={() => auth.logout()}
                class="text-sm px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                退出
              </button>
            {/if}
            <div class="flex items-center gap-4 text-sm text-gray-600">
              <!-- Daemon Status -->
              <div class="flex items-center gap-2">
                <div
                  class="w-2 h-2 {daemonStatus.connected
                    ? 'bg-green-500'
                    : 'bg-red-500'} rounded-full {daemonStatus.connected
                    ? 'animate-pulse'
                    : ''}"
                ></div>
                <span class={getDaemonStatusClass()}
                  >守护进程: {getDaemonStatusText()}</span
                >
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>

    <!-- Daemon Status Alert Banner -->
    {#if !daemonStatus.connected}
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
              <strong>守护进程离线</strong> - 设备数据可能不是最新的
              {#if daemonStatus.lastHeartbeat}
                • 最后更新: {formatTimeAgo(daemonStatus.lastHeartbeat)}
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
    {#if phoneNumbers.some((p) => p.status !== "online")}
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
              {#if phoneNumbers.filter((p) => p.status === "offline").length > 0}
                {#if phoneNumbers.filter((p) => p.status === "searching").length > 0 || phoneNumbers.filter((p) => p.status === "failed").length > 0}
                  •
                {/if}
                <strong
                  >{phoneNumbers.filter((p) => p.status === "offline")
                    .length}</strong
                > 张SIM卡离线
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
    <div class="lg:hidden px-4 py-2 bg-gray-50 border-b">
      <div class="flex gap-2">
        <button
          on:click={() => (currentView = "dashboard")}
          class="flex-1 px-3 py-2 rounded-lg text-sm transition-colors {currentView ===
          'dashboard'
            ? 'bg-purple-100 text-purple-700'
            : 'text-gray-600 bg-white'}"
        >
          消息管理
        </button>
        <button
          on:click={() => (currentView = "iccid-mappings")}
          class="flex-1 px-3 py-2 rounded-lg text-sm transition-colors {currentView ===
          'iccid-mappings'
            ? 'bg-purple-100 text-purple-700'
            : 'text-gray-600 bg-white'}"
        >
          ICCID 映射
        </button>
      </div>
    </div>

    {#if currentView === "dashboard"}
      <!-- Mobile Stats (Horizontal Scroll) -->
      <div class="lg:hidden overflow-x-auto px-4 py-4">
        <div class="flex gap-3 min-w-max">
          <div
            class="bg-gradient-to-br from-blue-500 to-blue-600 text-white px-4 py-3 rounded-xl shadow-lg"
          >
            <div class="text-xs opacity-90">在线设备</div>
            <div class="text-xl font-bold">
              {phoneNumbers.filter((p) => p.status === "online")
                .length}/{phoneNumbers.length}
            </div>
          </div>
          <div
            class="bg-gradient-to-br from-green-500 to-green-600 text-white px-4 py-3 rounded-xl shadow-lg"
          >
            <div class="text-xs opacity-90">今日接收</div>
            <div class="text-xl font-bold">{stats.todayReceived}</div>
          </div>
          <div
            class="bg-gradient-to-br from-blue-500 to-indigo-600 text-white px-4 py-3 rounded-xl shadow-lg"
          >
            <div class="text-xs opacity-90">今日发送</div>
            <div class="text-xl font-bold">{stats.todaySent}</div>
          </div>
          <div
            class="bg-gradient-to-br from-purple-500 to-purple-600 text-white px-4 py-3 rounded-xl shadow-lg"
          >
            <div class="text-xs opacity-90">总接收</div>
            <div class="text-xl font-bold">{stats.totalReceived}</div>
          </div>
          <div
            class="bg-gradient-to-br from-indigo-500 to-indigo-600 text-white px-4 py-3 rounded-xl shadow-lg"
          >
            <div class="text-xs opacity-90">总发送</div>
            <div class="text-xl font-bold">{stats.totalSent}</div>
          </div>
          <div
            class="bg-gradient-to-br from-orange-500 to-orange-600 text-white px-4 py-3 rounded-xl shadow-lg"
          >
            <div class="text-xs opacity-90">提取成功率</div>
            <div class="text-xl font-bold">{stats.verificationRate}%</div>
          </div>
        </div>
      </div>
    {/if}

    {#if currentView === "dashboard"}
      <!-- Desktop Stats -->
      <div class="hidden lg:block px-8 py-6">
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-6">
          <StatsCard
            title="在线设备"
            value={phoneNumbers.filter((p) => p.status === "online").length}
            total={phoneNumbers.length}
            gradient="from-blue-500 to-blue-600"
            icon="📱"
          />
          <StatsCard
            title="今日接收"
            value={stats.todayReceived}
            gradient="from-green-500 to-green-600"
            icon="📥"
          />
          <StatsCard
            title="今日发送"
            value={stats.todaySent}
            gradient="from-blue-500 to-indigo-600"
            icon="📤"
          />
          <StatsCard
            title="验证码提取率"
            value={`${stats.verificationRate}%`}
            gradient="from-orange-500 to-orange-600"
            icon="✅"
          />
        </div>

        <!-- Second row for total stats -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-6 mt-6">
          <div class="lg:col-span-2">
            <StatsCard
              title="总接收消息"
              value={stats.totalReceived}
              gradient="from-purple-500 to-purple-600"
              icon="💬"
            />
          </div>
          <div class="lg:col-span-2">
            <StatsCard
              title="总发送消息"
              value={stats.totalSent}
              gradient="from-indigo-500 to-indigo-600"
              icon="📨"
            />
          </div>
        </div>
      </div>

      <!-- Main Content -->
      <div class="lg:px-8 lg:pb-6">
        <div class="lg:grid lg:grid-cols-4 lg:gap-6">
          <!-- Mobile Phone List Overlay -->
          {#if showPhoneList}
            <div
              class="lg:hidden fixed inset-0 z-50 bg-gray-900 bg-opacity-75 backdrop-blur-sm"
              on:click={() => (showPhoneList = false)}
              on:keydown={(e) => e.key === "Escape" && (showPhoneList = false)}
              role="button"
              tabindex="0"
              aria-label="关闭手机列表"
            >
              <div
                class="absolute left-0 top-0 bottom-0 w-80 max-w-full bg-white shadow-2xl"
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
          <div class="hidden lg:block lg:col-span-1">
            <PhoneList
              {phoneNumbers}
              {selectedPhone}
              bind:selectedPhoneIccid
              bind:selectedCountry
              bind:searchTerm
              onSetIccidMapping={handleSetIccidMapping}
              {daemonStatus}
              isLoading={dataLoading}
            />
          </div>

          <!-- Message View -->
          <div class="lg:col-span-2">
            {#if selectedPhone}
              <PhoneDetails
                phone={selectedPhone}
                mobile={false}
                {daemonStatus}
              />
              <div class="mt-4">
                <MessageView {messages} {selectedPhone} mobile={true} />
              </div>
            {:else}
              <MessageView {messages} {selectedPhone} mobile={true} />
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
    {:else if currentView === "iccid-mappings"}
      <!-- ICCID Mappings View -->
      <div class="px-4 lg:px-8 py-6">
        <IccidMappings />
      </div>
    {/if}
  </div>
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
