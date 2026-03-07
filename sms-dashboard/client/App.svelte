<script>
  import { onMount, onDestroy } from "svelte";
  import PhoneList from "./lib/PhoneList.svelte";
  import SimpleMessageView from "./lib/SimpleMessageView.svelte";
  import MessageComposer from "./lib/MessageComposer.svelte";
  import StatsCard from "./lib/StatsCard.svelte";
  import IccidMappings from "./lib/IccidMappings.svelte";
  import PhoneDetails from "./lib/PhoneDetails.svelte";
  import IccidMappingDialog from "./lib/IccidMappingDialog.svelte";
  import KeywordConfig from "./lib/KeywordConfig.svelte";
  import ErrorBoundary from "./lib/ErrorBoundary.svelte";
  import { api } from "./lib/api.js";
  import { getPhoneFlag, mapStatsResponse } from "./lib/countries.js";
  // All real-time updates disabled to save costs - manual refresh only
  // import { RealtimeService } from "./lib/websocket-with-fallback.js";
  import { auth } from "./lib/auth.js";
  import config from "./lib/config.js";

  let selectedPhoneIccid = null;
  let messageViewRef = null;
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
    
    console.debug(`[calculateOnline] Result: ${onlinePhones.length}/${phones.length} online (sample phone status: ${phones[0]?.status}, updated_at: ${phones[0]?.updated_at})`);
    return onlinePhones.length;
  }
  
  // Centralized function to calculate SIM missing devices
  function calculateSimMissingDevices(phones) {
    if (!phones || phones.length === 0) return 0;
    
    const simMissingPhones = phones.filter(p => {
      return p?.status === 'sim-missing' || (!p?.iccid && !p?.number);
    });
    
    console.debug(`[calculateSimMissing] Result: ${simMissingPhones.length}/${phones.length} need SIM cards`);
    return simMissingPhones.length;
  }
  
  // Track if we've loaded stats from backend (to prevent race conditions)
  let backendStatsLoaded = false;
  
  // Manual function to update stats - no reactive statements to avoid circular dependencies
  function updateStatsFromPhones() {
    if (phoneNumbers && phoneNumbers.length > 0 && !dataLoading && !backendStatsLoaded) {
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
  // Real-time connections disabled - manual refresh only
  // let wsConnected = false;
  // let wsUnsubscribers = [];
  // let wsConnection = null;
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
  
  
  // Hash routing handler
  function handleHashChange() {
    const hash = window.location.hash.slice(1);
    const previousView = currentView;
    
    if (hash === 'keywords') {
      console.debug('[App] Hash routing: switching to keywords view');
      currentView = 'keywords';
    } else if (hash === 'iccid-mappings') {
      console.debug('[App] Hash routing: switching to ICCID mappings view');
      currentView = 'iccid-mappings';
    } else if (hash === 'dashboard' || hash === '') {
      console.debug('[App] Hash routing: switching to dashboard view');
      currentView = 'dashboard';
    }
    
  }

  // Load data using HTTP API directly for better performance
  async function loadData() {
    // Only proceed if user is authenticated
    if (!user || !auth.token) {
      console.debug("[App] loadData called but user not authenticated, skipping");
      dataLoading = false;
      return;
    }
    
    try {
      // Use HTTP API directly for initial load to avoid WebSocket timeout delays
      const token = auth.token;
      const headers = {
        Authorization: `Bearer ${token}`,
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
            .then(async (r) => {
              console.debug('[App] Messages API response status:', r.status, r.statusText);
              if (!r.ok) {
                console.error('[App] Messages API response not ok:', r.status, r.statusText);
                return { success: false, data: [], error: `HTTP ${r.status}` };
              }
              const data = await r.json();
              console.debug('[App] Raw messages API response:', data);
              return data;
            })
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
      
      console.debug('[App] Loaded phones:', phoneNumbers.length);
      console.debug('[App] Phone ICCIDs:', phoneNumbers.map(p => p.iccid));

      // Safely handle messages response
      console.debug('[App] Processing messages response:', {
        hasResponse: !!messagesResponse,
        hasData: !!(messagesResponse && messagesResponse.data),
        success: messagesResponse?.success,
        isDataArray: Array.isArray(messagesResponse?.data),
        dataLength: messagesResponse?.data?.length,
        hasResults: !!(messagesResponse?.data?.results),
        resultsLength: messagesResponse?.data?.results?.length
      });
      
      if (messagesResponse && messagesResponse.success && messagesResponse.data) {
        // Handle both array and object with results
        if (Array.isArray(messagesResponse.data)) {
          messages = messagesResponse.data;
          console.debug('[App] Using direct data array:', messages.length, 'messages');
        } else if (messagesResponse.data.results && Array.isArray(messagesResponse.data.results)) {
          messages = messagesResponse.data.results;
          console.debug('[App] Using data.results array:', messages.length, 'messages');
        } else {
          console.warn('[App] Unexpected messages response format:', messagesResponse);
          messages = [];
        }
      } else {
        console.error('[App] CRITICAL: Messages API failed!', {
          response: messagesResponse,
          success: messagesResponse?.success,
          hasData: !!(messagesResponse && messagesResponse.data),
          error: messagesResponse?.error,
          authToken: !!auth.token
        });
        
        // If this is an auth error, try to re-authenticate
        if (messagesResponse?.error && messagesResponse.error.includes('HTTP 401')) {
          console.error('[App] Authentication error detected, forcing logout');
          auth.logout();
          return;
        }
        
        messages = [];
      }
      
      console.debug('[App] Initial messages loaded:', messages.length);
      if (messages.length > 0) {
        console.debug('[App] First message:', messages[0]);
        console.debug('[App] Message ICCIDs:', [...new Set(messages.map(m => m.phone_iccid))]);
        console.debug('[App] Message IDs:', messages.slice(0, 5).map(m => m.id));
        
        // Update polling service with latest message info
        const sortedMessages = [...messages].sort((a, b) => 
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        if (sortedMessages[0]) {
          // No need to track latest message for WebSocket - it handles all messages
        }
      }

      // Map API stats to component format
      if (statsResponse) {
        console.debug('[App] Stats API Response:', statsResponse);
        
        stats = mapStatsResponse(statsResponse);
        
        // Mark that we've loaded stats from backend
        backendStatsLoaded = true;
        
        // Check daemon status
        await checkDaemonStatus();
        
        // The reactive statement will automatically update online device count if needed
        
        console.debug('[App] Stats after updates:', stats);
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

  // Real-time updates disabled - users must manually refresh
  // async function startRealtime() {
  //   // Disabled to save API costs
  // }

  let daemonInterval;

  onMount(async () => {
    // All real-time connections and periodic checks disabled
    // Users must manually refresh the page for updates
    
    // No WebSocket/SSE connection
    // No periodic daemon status checks
    // No automatic updates
    
    // Don't fetch stats here - it will be fetched after authentication in loadAllData
    // await fetchStats();
    
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

    // Load data and start polling ONLY for authenticated users
    if (user) {
      // Mark daemon as initially connected to prevent "数据过期" message
      daemonStatus.connected = true;
      daemonStatus.lastDataUpdate = Date.now();

      // Load data once on page load - no real-time updates
      loadData().finally(() => {
        dataLoading = false;
      }).catch((error) => {
        console.error("Failed to load data:", error);
      });
      
      // Disable periodic daemon health check to reduce API calls
      // Health status will be updated via WebSocket events
      // const healthCheckInterval = setInterval(() => {
      //   updateDaemonHealthStatus();
      // }, 60000); // Check every minute
      
      // Store interval for cleanup
      // window._daemonHealthInterval = healthCheckInterval;
      
    } else {
      // For anonymous users, don't make any API calls
      console.debug("[App] User not authenticated, skipping data loading and polling");
      dataLoading = false; // Mark data loading as complete
    }
  });

  // All real-time listeners removed - manual refresh only
  /*
  function setupRealtimeListeners() {
    // Listen for new messages via WebSocket/SSE
    wsUnsubscribers.push(
      wsConnection.on("message:created", (msg) => {
        // New message received - only add if it belongs to the selected phone
        if (selectedPhoneIccid && msg.data.phone_iccid === selectedPhoneIccid) {
          messages = [msg.data, ...messages];
        }
        // Update stats regardless of which phone it's for
        stats.totalMessages++;
        stats.todayMessages++;
      }),
    );

    // Listen for message updates
    wsUnsubscribers.push(
      wsConnection.on("message:updated", (msg) => {
        // Message updated
        const index = messages.findIndex((m) => m.id === msg.data.id);
        if (index !== -1) {
          messages[index] = msg.data;
          messages = [...messages];
        }
      }),
    );

    // Listen for bulk message creation
    wsUnsubscribers.push(
      wsConnection.on("messages:bulk_created", (msg) => {
        console.debug('[App] Received bulk messages event:', msg);
        
        if (!msg.data || !Array.isArray(msg.data)) {
          console.warn('[App] Invalid message data received');
          return;
        }
        
        // Get incoming messages - filter by selected phone if one is selected
        const allIncomingMessages = msg.data.filter(m => m && m.id);
        const incomingMessages = selectedPhoneIccid 
          ? allIncomingMessages.filter(m => m.phone_iccid === selectedPhoneIccid)
          : allIncomingMessages;
        
        if (incomingMessages.length === 0) {
          // No messages for the selected phone
          return;
        }
        
        console.debug('[App] Processing', incomingMessages.length, 'messages from polling for phone', selectedPhoneIccid || 'all');
        
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
          console.debug('[App] Found', newMessages.length, 'NEW messages:');
          newMessages.forEach(m => {
            console.debug(`  - ${m.id}: "${m.content.substring(0, 30)}..." at ${m.timestamp}`);
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
              console.debug('[App] Auto-selecting phone:', matchingPhone.iccid);
              selectedPhoneIccid = matchingPhone.iccid;
              handlePhoneSelection();
            }
          }
          
          // Show notification
          console.log(`[App] ✅ ${newMessages.length} new message(s) received!`);
        } else if (updatedMessages.length > 0) {
          console.debug('[App] Updated', updatedMessages.length, 'existing message(s)');
          // Trigger reactive update
          messages = messages;
        } else {
          console.debug('[App] No new messages in this update');
        }
      }),
    );

    // Listen for phone updates
    wsUnsubscribers.push(
      wsConnection.on("phones:updated", (msg) => {
        // Phones updated
        console.debug("Polling update - phones:", msg?.data);

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
              console.debug(
                `Phone update - ${updatedPhone.iccid}: signal=${updatedPhone.signal}, status=${updatedPhone.status}`,
              );
              // Ensure we have the proper structure
              return {
                ...updatedPhone,
                flag: getPhoneFlag(updatedPhone)
              };
            });

          console.debug("Updated phoneNumbers:", phoneNumbers);

          // Update total devices from daemon count
          const daemonModemCount = daemonStatus.modem_count || phoneNumbers.length;
          if (stats.totalDevices !== daemonModemCount) {
            stats = { ...stats, totalDevices: daemonModemCount };
          }
          // Update stats manually (was reactive statement)
          updateStatsFromPhones();
          updateSelectedPhone();
          
          // Update daemon health status
          updateDaemonHealthStatus();
        }
      }),
    );

    // Listen for connection status
    wsUnsubscribers.push(
      wsConnection.on("connected", () => {
        pollingConnected = true;
        console.debug("Polling connected");
      }),
    );

    // Listen for message sent responses
    wsUnsubscribers.push(
      wsConnection.on("message:sent", (msg) => {
        // Message sent result received
        console.debug("Message sent result:", msg.data);
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
    wsUnsubscribers.push(
      wsConnection.on("disconnected", () => {
        pollingConnected = false;
        console.debug("Polling disconnected");
      }),
    );
  }
  */

  // All real-time updates disabled - manual refresh only

  onDestroy(() => {
    // Cleanup daemon status interval
    if (daemonInterval) clearInterval(daemonInterval);
    
    // Cleanup realtime service
    wsUnsubscribers.forEach((unsubscribe) => unsubscribe());
    if (wsConnection) wsConnection.disconnect();
    
    // Cleanup health check interval
    if (window._daemonHealthInterval) {
      clearInterval(window._daemonHealthInterval);
    }
    
    // Remove hash change listener
    window.removeEventListener('hashchange', handleHashChange);
  });

  async function selectPhone(phone) {
    console.log('[App] selectPhone called with:', phone);
    selectedPhoneIccid = phone?.iccid || null;
    handlePhoneSelection();
    console.log('[App] selectedPhone after update:', selectedPhone);
    showPhoneList = false;
    
    // Load all messages for the selected phone
    if (phone?.iccid && user && auth.token) {
      try {
        console.debug('[App] Loading messages for phone:', phone.iccid);
        const token = auth.token;
        const headers = {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        };
        
        const response = await fetch(`/api/messages?phone_iccid=${phone.iccid}&limit=2000`, { headers });
        const result = await response.json();
        
        console.debug('[App] API Response:', {
          success: result.success,
          dataLength: result.data?.length,
          sampleData: result.data?.slice(0, 2)
        });
        
        if (result.success && result.data) {
          // Check data format - handle both array and object responses
          const messageData = Array.isArray(result.data) ? result.data : (result.data.results || []);
          console.debug('[App] Extracted message data:', messageData.length, 'messages');
          
          // Merge with existing messages, avoiding duplicates
          const existingIds = new Set(messages.map(m => m.id));
          const phoneMessages = messageData.filter(m => !existingIds.has(m.id));
          
          console.debug('[App] Messages for phone:', {
            iccid: phone.iccid,
            totalInResponse: messageData.length,
            newMessages: phoneMessages.length,
            existingMessages: messages.length
          });
          
          if (phoneMessages.length > 0) {
            messages = [...messages, ...phoneMessages];
            console.debug(`[App] Updated total messages: ${messages.length}`);
          } else if (messageData.length > 0) {
            console.debug('[App] All messages were already loaded');
          } else {
            console.debug('[App] No messages found for this phone');
          }
        }
      } catch (err) {
        console.error('[App] Failed to load messages for phone:', err);
      }
    }
  }
  
  // Load messages for a specific phone
  async function loadMessagesForPhone(phoneIccid) {
    // Only proceed if user is authenticated
    if (!user || !auth.token) {
      console.debug("[App] loadMessagesForPhone called but user not authenticated, skipping");
      return;
    }
    
    if (!phoneIccid) {
      // No phone selected, load ALL messages from all devices
      console.debug('[App] No phone selected, loading all messages from all devices');
      try {
        const response = await api.getMessages({ 
          limit: 2000 // Load messages from all devices
        });
        
        if (response && response.data) {
          console.debug(`[App] API returned ${response.data.length} messages from all devices`);
          
          // Debug: Show unique ICCIDs in the messages
          const uniqueIccids = [...new Set(response.data.map(m => m.phone_iccid))];
          console.debug(`[App] Messages from ${uniqueIccids.length} different devices:`, uniqueIccids);
          
          messages = response.data;
          
          // Sort messages by timestamp (newest first)
          messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
          
          console.debug(`[App] Now displaying ${messages.length} messages from ALL devices`);
        }
      } catch (error) {
        console.error('[App] Failed to load all messages:', error);
        messages = [];
      }
      return;
    }
    
    try {
      console.debug(`[App] Loading messages for phone ICCID: ${phoneIccid}`);
      
      const response = await api.getMessages({ 
        phone_iccid: phoneIccid,
        limit: 500 // Load up to 500 messages for this specific phone
      });
      
      if (response && response.data) {
        console.debug(`[App] API returned ${response.data.length} messages for ICCID ${phoneIccid}`);
        
        // DEBUG: Verify all messages have the correct ICCID
        const wrongIccidMessages = response.data.filter(msg => msg.phone_iccid !== phoneIccid);
        if (wrongIccidMessages.length > 0) {
          console.error('[App] WARNING: API returned messages with wrong ICCIDs!');
          console.error('Expected ICCID:', phoneIccid);
          console.error('Wrong ICCID messages:', wrongIccidMessages.map(m => ({
            id: m.id,
            phone_iccid: m.phone_iccid,
            content: m.content?.substring(0, 50) + '...'
          })));
        }
        
        // DEBUG: Log first few messages to verify content
        console.debug('[App] First 3 messages from API:');
        response.data.slice(0, 3).forEach((msg, idx) => {
          console.debug(`  ${idx + 1}. ID: ${msg.id}, ICCID: ${msg.phone_iccid}, Content: "${msg.content?.substring(0, 50)}..."`);
        });
        
        // Replace all messages with the new phone's messages
        // Don't merge - we want only this phone's messages
        messages = response.data;
        
        // Sort messages by timestamp (newest first)
        messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        console.debug(`[App] Now showing ${messages.length} messages for phone ${phoneIccid}`);
        console.debug('[App] Messages array after update:', messages.slice(0, 3).map(m => ({
          id: m.id,
          phone_iccid: m.phone_iccid,
          content: m.content?.substring(0, 30) + '...'
        })));
      }
    } catch (error) {
      console.error('[App] Failed to load messages for phone:', error);
      // Clear messages on error to avoid showing wrong phone's messages
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
      console.debug('Daemon health check:', {
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
      
      console.debug('Daemon health check:', {
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
        console.debug('[App] Daemon status response:', data);
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
    // Only proceed if user is authenticated
    if (!user || !auth.token) {
      console.debug("[App] fetchStats called but user not authenticated, skipping");
      return;
    }
    
    try {
      // Get auth headers
      const headers = {
        'Authorization': `Bearer ${auth.token}`
      };
      
      const response = await fetch('/api/stats', { headers });
      if (response.ok) {
        const data = await response.json();
        console.debug('[App] Fetched stats from API:', data);
        
        stats = mapStatsResponse(data);
        
        // Mark that we've loaded stats from backend
        backendStatsLoaded = true;
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
                console.debug("[App] Switching to ICCID mappings view");
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
                console.debug("[App] Switching to keywords view");
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
            console.debug("[App] Switching to ICCID mappings view (mobile)");
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
            console.debug("[App] Switching to keywords view (mobile)");
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
              <SimpleMessageView {messages} {selectedPhone} />
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

