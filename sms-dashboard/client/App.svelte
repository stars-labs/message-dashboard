<script>
  import { onMount, onDestroy } from "svelte";
  import PhoneList from "./lib/PhoneList.svelte";
  import MessageView from "./lib/MessageView.svelte";
  import MessageComposer from "./lib/MessageComposer.svelte";
  import StatsCard from "./lib/StatsCard.svelte";
  import IccidMappings from "./lib/IccidMappings.svelte";
  import PhoneDetails from "./lib/PhoneDetails.svelte";
  import IccidMappingDialog from "./lib/IccidMappingDialog.svelte";
  import WebGPUBackground from "./lib/WebGPUBackground.svelte";
  import ChatAssistant from "./lib/ChatAssistant.svelte";
  import SemanticSearch from "./lib/SemanticSearch.svelte";
  import KeywordConfig from "./lib/KeywordConfig.svelte";
  import { api } from "./lib/api.js";
  import { pollingService } from "./lib/polling-service.js";
  import { auth } from "./lib/auth.js";
  import config from "./lib/config.js";
  import { applyDataStreamEffect, applyNeonGlow, createMatrixRain, applyHeaderEffect } from "./lib/webgpu-effects.js";

  let selectedPhoneIccid = null;
  $: selectedPhone = selectedPhoneIccid
    ? phoneNumbers.find((p) => p.iccid === selectedPhoneIccid)
    : null;
  
  // When phone is selected, load messages for that specific phone
  $: if (selectedPhoneIccid) {
    loadMessagesForPhone(selectedPhoneIccid);
  }
  
  // Centralized function to calculate online devices
  function calculateOnlineDevices(phones) {
    if (!phones || phones.length === 0) return 0;
    
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    const onlinePhones = phones.filter(p => {
      const hasOnlineStatus = p?.status && ["online", "active", "registered"].includes(p.status);
      if (!hasOnlineStatus) {
        console.debug(`[calculateOnline] Phone ${p?.iccid} excluded - status: ${p?.status}`);
        return false;
      }
      if (!p.updated_at) {
        console.debug(`[calculateOnline] Phone ${p?.iccid} excluded - no updated_at`);
        return false;
      }
      
      try {
        const updateTime = new Date(p.updated_at).getTime();
        const isRecent = !isNaN(updateTime) && updateTime > fiveMinutesAgo;
        if (!isRecent) {
          console.debug(`[calculateOnline] Phone ${p?.iccid} excluded - too old: ${p.updated_at}`);
        }
        return isRecent;
      } catch (e) {
        console.warn('Invalid date for phone:', p.iccid, p.updated_at);
        return false;
      }
    });
    
    console.log(`[calculateOnline] Result: ${onlinePhones.length}/${phones.length} online (sample phone status: ${phones[0]?.status}, updated_at: ${phones[0]?.updated_at})`);
    return onlinePhones.length;
  }
  
  // Centralized function to calculate SIM missing devices
  function calculateSimMissingDevices(phones) {
    if (!phones || phones.length === 0) return 0;
    
    const simMissingPhones = phones.filter(p => {
      return p?.status === 'sim-missing' || (!p?.iccid && !p?.number);
    });
    
    console.log(`[calculateSimMissing] Result: ${simMissingPhones.length}/${phones.length} need SIM cards`);
    return simMissingPhones.length;
  }
  
  // Track if we've loaded stats from backend (to prevent race conditions)
  let backendStatsLoaded = false;
  
  // Single reactive statement for stats updates
  // ONLY recalculate if we haven't received stats from backend
  // Backend has authoritative data about online devices
  $: if (phoneNumbers && phoneNumbers.length > 0 && !dataLoading && !backendStatsLoaded) {
    // Only calculate if backend hasn't provided stats yet
    const onlineCount = calculateOnlineDevices(phoneNumbers);
    const simMissingCount = calculateSimMissingDevices(phoneNumbers);
    console.log('[App] No backend stats, calculating from phones:', onlineCount, '/', phoneNumbers.length, '(', simMissingCount, 'need SIM)');
    if (onlineCount !== stats.onlineDevices || simMissingCount !== stats.simMissingDevices) {
      console.log('[App] Updating stats from', {online: stats.onlineDevices, simMissing: stats.simMissingDevices}, 'to', {online: onlineCount, simMissing: simMissingCount});
      stats = { ...stats, onlineDevices: onlineCount, simMissingDevices: simMissingCount };
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
  let pollingConnected = false;
  let pollingUnsubscribers = [];
  let currentView = "dashboard"; // 'dashboard', 'iccid-mappings', or 'keywords'
  let showIccidMappingDialog = false;
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
  
  // Debug: log whenever stats changes
  $: console.log('[App] Stats changed:', { 
    online: stats.onlineDevices, 
    total: stats.totalDevices,
    backendLoaded: backendStatsLoaded,
    phonesLength: phoneNumbers.length 
  });
  
  // Hash routing handler
  function handleHashChange() {
    const hash = window.location.hash.slice(1);
    if (hash === 'keywords') {
      console.log('[App] Hash routing: switching to keywords view');
      currentView = 'keywords';
    } else if (hash === 'iccid-mappings') {
      console.log('[App] Hash routing: switching to ICCID mappings view');
      currentView = 'iccid-mappings';
    } else if (hash === 'dashboard' || hash === '') {
      console.log('[App] Hash routing: switching to dashboard view');
      currentView = 'dashboard';
    }
  }

  // Load data using HTTP API directly for better performance
  async function loadData() {
    try {
      // Use HTTP API directly for initial load to avoid WebSocket timeout delays
      const token = auth.token || "anonymous";
      const headers = {
        Authorization: token !== "anonymous" ? `Bearer ${token}` : undefined,
        "Content-Type": "application/json",
      };

      // Make direct HTTP requests in parallel with error handling
      const [phonesResponse, messagesResponse, statsResponse] =
        await Promise.all([
          fetch("/api/phones", { headers })
            .then((r) => r.json())
            .catch((err) => {
              console.error('[App] Failed to fetch phones:', err);
              return { success: false, data: [] };
            }),
          fetch("/api/messages?limit=2000", { headers })
            .then((r) => r.json())
            .catch((err) => {
              console.error('[App] Failed to fetch messages:', err);
              return { success: false, data: [] };
            }),
          fetch("/api/stats", { headers })
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
      } else if (Array.isArray(phonesResponse)) {
        phoneNumbers = phonesResponse.map(phone => ({
          ...phone,
          flag: getPhoneFlag(phone)
        }));
      } else {
        phoneNumbers = [];
      }
      
      console.log('[App] Loaded phones:', phoneNumbers.length);
      console.log('[App] Phone ICCIDs:', phoneNumbers.map(p => p.iccid));

      // Safely handle messages response
      if (messagesResponse && messagesResponse.data) {
        // Handle both array and object with results
        if (Array.isArray(messagesResponse.data)) {
          messages = messagesResponse.data;
        } else if (messagesResponse.data.results && Array.isArray(messagesResponse.data.results)) {
          messages = messagesResponse.data.results;
        } else {
          console.warn('[App] Unexpected messages response format:', messagesResponse);
          messages = [];
        }
      } else {
        console.warn('[App] Invalid messages response:', messagesResponse);
        messages = [];
      }
      
      console.log('[App] Initial messages loaded:', messages.length);
      if (messages.length > 0) {
        console.log('[App] First message:', messages[0]);
        console.log('[App] Message ICCIDs:', [...new Set(messages.map(m => m.phone_iccid))]);
        console.log('[App] Message IDs:', messages.slice(0, 5).map(m => m.id));
        
        // Update polling service with latest message info
        const sortedMessages = [...messages].sort((a, b) => 
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        if (sortedMessages[0]) {
          pollingService.updateLatestMessage(sortedMessages[0].id, sortedMessages[0].timestamp);
        }
      }

      // Map API stats to component format
      if (statsResponse) {
        console.log('[App] Stats API Response:', statsResponse);
        
        // Use stats from API which already accounts for daemon's modem count
        stats = {
          totalMessages: statsResponse.total_messages || 0,
          todayMessages: statsResponse.today_messages || 0,
          totalSent: statsResponse.total_sent || 0,
          totalReceived: statsResponse.total_received || 0,
          todaySent: statsResponse.today_sent || 0,
          todayReceived: statsResponse.today_received || 0,
          onlineDevices: statsResponse.online_devices || 0,
          totalDevices: statsResponse.total_devices || 0,
          verificationRate: Math.round(
            (statsResponse.verification_rate || 0) * 100,
          ),
        };
        console.log('[App] Stats from backend - online:', stats.onlineDevices, 'total:', stats.totalDevices);
        
        // Mark that we've loaded stats from backend
        backendStatsLoaded = true;
        
        // Check daemon status
        await checkDaemonStatus();
        
        // The reactive statement will automatically update online device count if needed
        
        console.log('[App] Stats after updates:', stats);
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

  // Helper function to start HTTP polling
  async function startPolling() {
    if (pollingService.isConnected) {
      console.log("[App] Polling already active, skipping");
      return;
    }

    const token = auth.token || "anonymous";
    console.log(
      "[App] Starting polling with token:",
      !!auth.token ? "authenticated" : "anonymous",
    );

    try {
      await pollingService.connect(token);
      setupPollingListeners();
      console.log("[App] Polling started successfully");
    } catch (error) {
      console.error("[App] Failed to start polling:", error);
    }
  }

  let daemonInterval;

  onMount(async () => {
    // Start periodic daemon status checks (initial check happens in loadAllData)
    // Check every 30 seconds
    daemonInterval = setInterval(checkDaemonStatus, 30000);
    
    // Don't fetch stats here - it will be fetched after authentication in loadAllData
    // await fetchStats();
    
    // Apply matrix rain effect to body
    const removeMatrixRain = createMatrixRain(document.body);
    
    // Apply header effects after a small delay to ensure DOM is ready
    setTimeout(() => {
      // Apply to main headers
      const headers = document.querySelectorAll('.header-effect-target');
      headers.forEach(header => {
        applyHeaderEffect(header);
      });
    }, 100);
    
    // Check if returning from Auth0 callback
    if (window.location.search.includes("token=")) {
      await auth.handleCallback();
    }
    
    // Set initial view based on hash
    handleHashChange();
    
    // Listen for hash changes
    window.addEventListener('hashchange', handleHashChange);

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

    // Load data and start polling in the background
    if (user) {
      // Mark daemon as initially connected to prevent "数据过期" message
      daemonStatus.connected = true;
      daemonStatus.lastDataUpdate = Date.now();

      // Load data and polling in parallel without blocking
      Promise.all([
        loadData().finally(() => {
          dataLoading = false;
        }),
        startPolling(),
      ]).catch((error) => {
        console.error("Failed to load data or start polling:", error);
      });
      
      // Set up periodic daemon health check
      const healthCheckInterval = setInterval(() => {
        updateDaemonHealthStatus();
      }, 60000); // Check every minute
      
      // Store interval for cleanup
      window._daemonHealthInterval = healthCheckInterval;
      
      // Store matrix rain cleanup
      window._removeMatrixRain = removeMatrixRain;
    } else {
      // Still try to start polling for anonymous users
      startPolling().catch((error) => {
        console.error("Failed to start polling:", error);
      });
    }
  });

  function setupPollingListeners() {
    // Listen for new messages
    pollingUnsubscribers.push(
      pollingService.on("message:created", (msg) => {
        // New message received
        messages = [msg.data, ...messages];
        // Update stats
        stats.totalMessages++;
        stats.todayMessages++;
      }),
    );

    // Listen for message updates
    pollingUnsubscribers.push(
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
    pollingUnsubscribers.push(
      pollingService.on("messages:bulk_created", (msg) => {
        console.log('[App] Received bulk messages event:', msg);
        
        if (!msg.data || !Array.isArray(msg.data)) {
          console.warn('[App] Invalid message data received');
          return;
        }
        
        // Get incoming messages
        const incomingMessages = msg.data.filter(m => m && m.id);
        console.log('[App] Processing', incomingMessages.length, 'messages from polling');
        
        // Create a map of existing messages by ID for quick lookup and update
        const existingMessagesMap = new Map(messages.map(m => [m.id, m]));
        
        // Track which messages are truly new
        const newMessages = [];
        const updatedMessages = [];
        
        // Process each incoming message
        incomingMessages.forEach(incomingMsg => {
          const existingMsg = existingMessagesMap.get(incomingMsg.id);
          
          if (!existingMsg) {
            // This is a new message
            newMessages.push(incomingMsg);
          } else {
            // Check if this is actually an update to an existing message
            // Compare timestamps to avoid false updates
            const existingTime = new Date(existingMsg.timestamp).getTime();
            const incomingTime = new Date(incomingMsg.timestamp).getTime();
            
            if (Math.abs(existingTime - incomingTime) > 1000 || 
                existingMsg.content !== incomingMsg.content) {
              // This looks like an actual update
              updatedMessages.push(incomingMsg);
              existingMessagesMap.set(incomingMsg.id, incomingMsg);
            }
          }
        });
        
        if (newMessages.length > 0) {
          console.log('[App] Found', newMessages.length, 'NEW messages:');
          newMessages.forEach(m => {
            console.log(`  - ${m.id}: "${m.content.substring(0, 30)}..." at ${m.timestamp}`);
          });
          
          // Build new messages array: new messages first, then existing
          const allMessageIds = new Set();
          const deduplicatedMessages = [];
          
          // Add new messages first
          newMessages.forEach(m => {
            if (!allMessageIds.has(m.id)) {
              allMessageIds.add(m.id);
              deduplicatedMessages.push(m);
            }
          });
          
          // Then add existing messages (including any updates)
          messages.forEach(m => {
            const updatedMsg = existingMessagesMap.get(m.id);
            if (!allMessageIds.has(m.id)) {
              allMessageIds.add(m.id);
              deduplicatedMessages.push(updatedMsg || m);
            }
          });
          
          // Update messages array
          messages = deduplicatedMessages;
          
          // Keep only the most recent 200 messages to prevent memory issues
          if (messages.length > 200) {
            messages = messages.slice(0, 200);
          }
          
          // Update stats
          stats.totalMessages += newMessages.length;
          stats.todayMessages += newMessages.length;
          
          // Auto-select phone if no phone is selected
          if (!selectedPhoneIccid && newMessages.length > 0) {
            const firstNewMessage = newMessages[0];
            const matchingPhone = phoneNumbers.find(p => p.iccid === firstNewMessage.phone_iccid);
            if (matchingPhone) {
              console.log('[App] Auto-selecting phone:', matchingPhone.iccid);
              selectedPhoneIccid = matchingPhone.iccid;
            }
          }
          
          // Show notification
          console.log(`[App] ✅ ${newMessages.length} new message(s) received!`);
        } else if (updatedMessages.length > 0) {
          console.log('[App] Updated', updatedMessages.length, 'existing message(s)');
          // Trigger reactive update
          messages = messages;
        } else {
          console.log('[App] No new messages in this update');
        }
      }),
    );

    // Listen for phone updates
    pollingUnsubscribers.push(
      pollingService.on("phones:updated", (msg) => {
        // Phones updated
        console.log("Polling update - phones:", msg?.data);

        // Safety check - ensure msg exists and has data
        if (!msg || !msg.data) {
          console.warn("[App] Invalid phone update message:", msg);
          return;
        }

        // Update daemon status when we receive phone data
        daemonStatus.lastPhoneUpdate = Date.now();
        daemonStatus.lastDataUpdate = Date.now();

        // Only update phones if we have valid data
        if (Array.isArray(msg.data) && msg.data.length > 0) {
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
                `Phone update - ${updatedPhone.iccid}: signal=${updatedPhone.signal}, status=${updatedPhone.status}`,
              );
              // Ensure we have the proper structure
              return {
                ...updatedPhone,
                flag: getPhoneFlag(updatedPhone)
              };
            });

          console.log("Updated phoneNumbers:", phoneNumbers);

          // Update total devices from daemon count
          const daemonModemCount = daemonStatus.modem_count || phoneNumbers.length;
          if (stats.totalDevices !== daemonModemCount) {
            stats = { ...stats, totalDevices: daemonModemCount };
          }
          // The reactive statement will automatically update online device count
          
          // Update daemon health status
          updateDaemonHealthStatus();
        }
      }),
    );

    // Listen for connection status
    pollingUnsubscribers.push(
      pollingService.on("connected", () => {
        pollingConnected = true;
        console.log("Polling connected");
      }),
    );

    // Listen for message sent responses
    pollingUnsubscribers.push(
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
    pollingUnsubscribers.push(
      pollingService.on("disconnected", () => {
        pollingConnected = false;
        console.log("Polling disconnected");
      }),
    );
  }

  // Using HTTP polling for real-time updates (every 5 seconds)

  onDestroy(() => {
    // Cleanup daemon status interval
    if (daemonInterval) clearInterval(daemonInterval);
    
    // Cleanup realtime service
    pollingUnsubscribers.forEach((unsubscribe) => unsubscribe());
    pollingService.disconnect();
    
    // Cleanup health check interval
    if (window._daemonHealthInterval) {
      clearInterval(window._daemonHealthInterval);
    }
    
    // Remove matrix rain
    if (window._removeMatrixRain) {
      window._removeMatrixRain();
    }
    
    // Remove hash change listener
    window.removeEventListener('hashchange', handleHashChange);
  });

  async function selectPhone(phone) {
    selectedPhoneIccid = phone?.iccid || null;
    showPhoneList = false;
    
    // Load all messages for the selected phone
    if (phone?.iccid) {
      try {
        console.log('[App] Loading messages for phone:', phone.iccid);
        const token = auth.token || "anonymous";
        const headers = {
          Authorization: token !== "anonymous" ? `Bearer ${token}` : undefined,
          "Content-Type": "application/json",
        };
        
        const response = await fetch(`/api/messages?phone_iccid=${phone.iccid}&limit=2000`, { headers });
        const result = await response.json();
        
        console.log('[App] API Response:', {
          success: result.success,
          dataLength: result.data?.length,
          sampleData: result.data?.slice(0, 2)
        });
        
        if (result.success && result.data) {
          // Check data format - handle both array and object responses
          const messageData = Array.isArray(result.data) ? result.data : (result.data.results || []);
          console.log('[App] Extracted message data:', messageData.length, 'messages');
          
          // Merge with existing messages, avoiding duplicates
          const existingIds = new Set(messages.map(m => m.id));
          const phoneMessages = messageData.filter(m => !existingIds.has(m.id));
          
          console.log('[App] Messages for phone:', {
            iccid: phone.iccid,
            totalInResponse: messageData.length,
            newMessages: phoneMessages.length,
            existingMessages: messages.length
          });
          
          if (phoneMessages.length > 0) {
            messages = [...messages, ...phoneMessages];
            console.log(`[App] Updated total messages: ${messages.length}`);
          } else if (messageData.length > 0) {
            console.log('[App] All messages were already loaded');
          } else {
            console.log('[App] No messages found for this phone');
          }
        }
      } catch (err) {
        console.error('[App] Failed to load messages for phone:', err);
      }
    }
  }
  
  // Load messages for a specific phone
  async function loadMessagesForPhone(phoneIccid) {
    if (!phoneIccid) return;
    
    try {
      console.log(`[App] Loading messages for phone ICCID: ${phoneIccid}`);
      
      const response = await api.getMessages({ 
        phone_iccid: phoneIccid,
        limit: 500 // Load up to 500 messages for this specific phone
      });
      
      if (response && response.data) {
        console.log(`[App] Loaded ${response.data.length} messages for phone ${phoneIccid}`);
        
        // Merge with existing messages, avoiding duplicates
        const existingIds = new Set(messages.map(m => m.id));
        const newMessages = response.data.filter(m => !existingIds.has(m.id));
        
        if (newMessages.length > 0) {
          console.log(`[App] Adding ${newMessages.length} new messages for phone ${phoneIccid}`);
          messages = [...messages, ...newMessages];
          
          // Sort messages by timestamp (newest first)
          messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        }
      }
    } catch (error) {
      console.error('[App] Failed to load messages for phone:', error);
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
    
    // Only log if we have the variables defined
    if (daemonStatus.lastHeartbeat) {
      console.log('Daemon health check:', {
        connected: daemonStatus.connected,
        heartbeatBased: true,
        phoneCount: phoneNumbers.length,
        lastHeartbeat: new Date(daemonStatus.lastHeartbeat).toLocaleString()
      });
    } else {
      const dataIsRecent = daemonStatus.lastDataUpdate > fiveMinutesAgo;
      const hasActivePhones = phoneNumbers.length > 0 && phoneNumbers.some(phone => {
        return phone.status === 'active' || phone.status === 'online' || phone.status === 'registered';
      });
      
      console.log('Daemon health check:', {
        connected: daemonStatus.connected,
        dataIsRecent,
        hasActivePhones,
        phoneCount: phoneNumbers.length,
        lastDataUpdate: new Date(daemonStatus.lastDataUpdate).toLocaleString()
      });
    }
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
      'online': 'text-green-400',
      'warning': 'text-yellow-400',
      'offline': 'text-red-400',
      'error': 'text-red-400',
      'unknown': 'text-gray-400'
    };
    return classMap[daemonStatus.status] || 'text-gray-400';
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
        console.log('[App] Daemon status response:', data);
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
        if (user && user.token) {
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
    try {
      // Get auth headers if user is authenticated
      const headers = {};
      if (user && user.token) {
        headers['Authorization'] = `Bearer ${user.token}`;
      }
      
      const response = await fetch('/api/stats', { headers });
      if (response.ok) {
        const data = await response.json();
        console.log('[App] Fetched stats from API:', data);
        
        // Update all stats from API response
        stats = {
          totalMessages: data.total_messages || 0,
          todayMessages: data.today_messages || 0,
          totalSent: data.total_sent || 0,
          totalReceived: data.total_received || 0,
          todaySent: data.today_sent || 0,
          todayReceived: data.today_received || 0,
          onlineDevices: data.online_devices || 0,
          totalDevices: data.total_devices || 0,
          verificationRate: Math.round((data.verification_rate || 0) * 100)
        };
        
        console.log('[App] Updated stats from API:', stats);
        
        // Mark that we've loaded stats from backend
        backendStatsLoaded = true;
      } else if (response.status === 401) {
        console.log('[App] Stats API requires authentication, skipping for now');
      }
    } catch (error) {
      console.error('Failed to fetch stats from API:', error);
    }
  }

  function getPhoneFlag(phone) {
    // First check if phone has country from ICCID mapping
    if (phone.country) {
      const countryFlags = {
        CN: "🇨🇳",
        HK: "🇭🇰",
        SG: "🇸🇬",
        US: "🇺🇸",
        UK: "🇬🇧",
        JP: "🇯🇵",
        KR: "🇰🇷",
        MY: "🇲🇾",
        TH: "🇹🇭",
        VN: "🇻🇳",
        PH: "🇵🇭",
        ID: "🇮🇩",
        IN: "🇮🇳",
        AU: "🇦🇺",
        NZ: "🇳🇿",
        CA: "🇨🇦",
        DE: "🇩🇪",
        FR: "🇫🇷",
        IT: "🇮🇹",
        ES: "🇪🇸",
        RU: "🇷🇺",
        BR: "🇧🇷",
        MX: "🇲🇽",
      };
      return countryFlags[phone.country] || "📱";
    }

    // Otherwise, try to determine from phone number
    if (!phone.number) return "📱";
    
    const number = phone.number.toString();
    
    // China (+86)
    if (number.startsWith("86") || number.startsWith("+86") || 
        (number.startsWith("1") && number.length === 11)) {
      return "🇨🇳";
    }
    
    // Hong Kong (+852)
    if (number.startsWith("852") || number.startsWith("+852") || 
        number.startsWith("00852")) {
      return "🇭🇰";
    }
    
    // Singapore (+65)
    if (number.startsWith("65") || number.startsWith("+65") || 
        (number.length === 8 && (number.startsWith("8") || number.startsWith("9")))) {
      return "🇸🇬";
    }
    
    // USA (+1) - be careful as +1 is shared by many countries
    if (number.startsWith("+1") || (number.length === 10 && !number.startsWith("1"))) {
      return "🇺🇸";
    }
    
    // Japan (+81)
    if (number.startsWith("81") || number.startsWith("+81")) {
      return "🇯🇵";
    }
    
    // Korea (+82)
    if (number.startsWith("82") || number.startsWith("+82")) {
      return "🇰🇷";
    }
    
    // Malaysia (+60)
    if (number.startsWith("60") || number.startsWith("+60")) {
      return "🇲🇾";
    }
    
    // Thailand (+66)
    if (number.startsWith("66") || number.startsWith("+66")) {
      return "🇹🇭";
    }
    
    // Default
    return "📱";
  }
</script>

{#if loading}
  <div class="min-h-screen flex items-center justify-center bg-black">
    <WebGPUBackground />
    <div class="text-center z-10">
      <div class="inline-flex items-center">
        <svg
          class="animate-spin h-8 w-8 text-cyan-400 mr-3"
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
        <span class="text-xl text-cyan-300 cyber-text" data-text="加载中...">加载中...</span>
      </div>
    </div>
  </div>
{:else if !user}
  <div
    class="min-h-screen flex items-center justify-center bg-black"
  >
    <WebGPUBackground />
    <div class="text-center tech-card holo-card p-8 z-10">
      <h1 class="text-3xl font-bold mb-4 cyber-text header-effect-target" data-text="短信验证码管理系统">短信验证码管理系统</h1>
      <p class="text-cyan-300 mb-6">请登录以继续</p>
      <button
        on:click={() => auth.login()}
        class="inline-block tech-button"
      >
        使用 Auth0 登录
      </button>
    </div>
  </div>
{:else}
  <div class="min-h-screen bg-black relative">
    <WebGPUBackground />
    <!-- Mobile Header -->
    <header class="bg-gray-900/95 backdrop-blur-xl shadow-lg sticky top-0 z-40 border-b border-cyan-500/30">
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
            class="text-xl font-bold bg-gradient-to-r from-green-400 to-emerald-500 bg-clip-text text-transparent animate-gradient-x header-effect-target"
          >
            短信验证码管理系统
          </h1>

          <!-- Navigation -->
          <div class="hidden lg:flex items-center gap-4 flex-1 justify-center">
            <button
              on:click={() => {
                currentView = "dashboard";
                window.location.hash = 'dashboard';
              }}
              class="px-4 py-2 rounded-lg transition-all {currentView ===
              'dashboard'
                ? 'tech-button'
                : 'text-cyan-400 hover:text-cyan-300 hover:bg-cyan-900/20'}"
            >
              消息管理
            </button>
            <button
              on:click={() => {
                console.log("[App] Switching to ICCID mappings view");
                currentView = "iccid-mappings";
                window.location.hash = 'iccid-mappings';
              }}
              class="px-4 py-2 rounded-lg transition-all {currentView ===
              'iccid-mappings'
                ? 'tech-button'
                : 'text-cyan-400 hover:text-cyan-300 hover:bg-cyan-900/20'}"
            >
              ICCID 映射
            </button>
            <button
              on:click={() => {
                console.log("[App] Switching to keywords view");
                currentView = "keywords";
                window.location.hash = 'keywords';
              }}
              class="px-4 py-2 rounded-lg transition-all {currentView ===
              'keywords'
                ? 'tech-button'
                : 'text-cyan-400 hover:text-cyan-300 hover:bg-cyan-900/20'}"
            >
              关键词高亮
            </button>
          </div>

          <div class="hidden lg:flex items-center gap-4">
            {#if user}
              <span class="text-sm text-cyan-300"
                >欢迎, {user.name || user.email}</span
              >
              <button
                on:click={() => auth.logout()}
                class="text-sm px-3 py-1 tech-button"
              >
                退出
              </button>
            {/if}
            <div class="flex items-center gap-4 text-sm text-gray-600">
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
                  class="text-xs text-cyan-400/60 hover:text-cyan-400 transition-colors ml-2"
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
    {#if phoneNumbers.some((p) => p.status !== "online" && p.status !== "active" && p.status !== "registered")}
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
    <div class="lg:hidden px-4 py-2 glassmorphism border-b border-cyan-900/30">
      <div class="flex gap-2">
        <button
          on:click={() => (currentView = "dashboard")}
          class="flex-1 px-3 py-2 rounded-lg text-sm transition-all {currentView ===
          'dashboard'
            ? 'tech-button'
            : 'text-cyan-400 bg-cyan-900/20'}"
        >
          消息管理
        </button>
        <button
          on:click={() => {
            console.log("[App] Switching to ICCID mappings view (mobile)");
            currentView = "iccid-mappings";
          }}
          class="flex-1 px-3 py-2 rounded-lg text-sm transition-all {currentView ===
          'iccid-mappings'
            ? 'tech-button'
            : 'text-cyan-400 bg-cyan-900/20'}"
        >
          ICCID 映射
        </button>
        <button
          on:click={() => {
            console.log("[App] Switching to keywords view (mobile)");
            currentView = "keywords";
          }}
          class="flex-1 px-3 py-2 rounded-lg text-sm transition-all {currentView ===
          'keywords'
            ? 'tech-button'
            : 'text-cyan-400 bg-cyan-900/20'}"
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
            class="tech-card holo-card text-white px-4 py-3"
          >
            <div class="text-xs text-cyan-300 font-bold tech-text">在线设备</div>
            <div class="text-xl font-bold data-value high-contrast" title="Online: {stats.onlineDevices}, Total: {stats.totalDevices}, Phones: {phoneNumbers.length}">
              {#key stats.onlineDevices + ':' + stats.totalDevices}
                {stats.onlineDevices}/{stats.totalDevices}
              {/key}
            </div>
          </div>
          <div
            class="tech-card holo-card text-white px-4 py-3"
          >
            <div class="text-xs text-cyan-300 font-bold tech-text">今日接收</div>
            <div class="text-xl font-bold data-value high-contrast">{stats.todayReceived || 0}</div>
          </div>
          <div
            class="tech-card holo-card text-white px-4 py-3"
          >
            <div class="text-xs text-cyan-300 font-bold tech-text">今日发送</div>
            <div class="text-xl font-bold data-value high-contrast">{stats.todaySent || 0}</div>
          </div>
          <div
            class="tech-card holo-card text-white px-4 py-3"
          >
            <div class="text-xs text-cyan-300 font-bold tech-text">总接收</div>
            <div class="text-xl font-bold data-value high-contrast">{stats.totalReceived || 0}</div>
          </div>
          <div
            class="tech-card holo-card text-white px-4 py-3"
          >
            <div class="text-xs text-cyan-300 font-bold tech-text">总发送</div>
            <div class="text-xl font-bold data-value high-contrast">{stats.totalSent || 0}</div>
          </div>
          <div
            class="tech-card holo-card text-white px-4 py-3"
          >
            <div class="text-xs text-cyan-300 font-bold tech-text">提取成功率</div>
            <div class="text-xl font-bold data-value high-contrast">{stats.verificationRate || 0}%</div>
          </div>
        </div>
      </div>
    {/if}

    {#if currentView === "dashboard"}
      <!-- Desktop Stats -->
      <div class="hidden lg:block px-8 py-6">
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-6 hex-pattern">
          <StatsCard
            title="在线设备"
            value={stats.onlineDevices}
            total={stats.totalDevices}
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
            title="需要SIM卡"
            value={stats.simMissingDevices}
            gradient="from-orange-500 to-red-600"
            icon="📵"
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
        
        <!-- AI-Powered Semantic Search -->
        <div class="mt-6">
          <SemanticSearch 
            {selectedPhoneIccid}
            on:messageSelected={(e) => {
              // Handle message selection from search
              const message = e.detail;
              // You might want to scroll to the message or highlight it
              console.log('Selected message from search:', message);
            }}
          />
        </div>
        
        <!-- Daemon Status removed - now shown in header only -->
      </div>

      <!-- Main Content -->
      <div class="lg:px-8 lg:pb-6">
        <div class="lg:grid lg:grid-cols-4 lg:gap-6 lg:items-start lg:content-start">
          <!-- Mobile Phone List Overlay -->
          {#if showPhoneList}
            <div
              class="lg:hidden fixed inset-0 z-50 bg-black/90 backdrop-blur-md"
              on:click={() => (showPhoneList = false)}
              on:keydown={(e) => e.key === "Escape" && (showPhoneList = false)}
              role="button"
              tabindex="0"
              aria-label="关闭手机列表"
            >
              <div
                class="absolute left-0 top-0 bottom-0 w-80 max-w-full bg-black/95 shadow-2xl shadow-cyan-500/20 border-r border-cyan-900/50"
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

          <!-- Message View Column -->
          <div class="lg:col-span-2">
            <!-- Always show MessageView at the top -->
            <MessageView {messages} {selectedPhone} mobile={false} />
            <!-- Show PhoneDetails below if selected -->
            {#if selectedPhone}
              <div class="mt-4">
                <PhoneDetails
                  phone={selectedPhone}
                  mobile={false}
                  {daemonStatus}
                />
              </div>
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
    {:else if currentView === "keywords"}
      <!-- Keywords Configuration View -->
      <div class="px-4 lg:px-8 py-6">
        <KeywordConfig />
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

<!-- AI Chat Assistant -->
{#if user}
  <ChatAssistant {user} />
{/if}
