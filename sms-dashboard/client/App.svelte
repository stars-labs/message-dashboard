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
  import SwUpdatePrompt from "./lib/SwUpdatePrompt.svelte";
  import { resetServiceWorker } from "./lib/sw-reset.js";
  import DaemonHealthPanel from "./lib/DaemonHealthPanel.svelte";
  import BalanceQueryDetail from './lib/BalanceQueryDetail.svelte';
  import MessageDetail from './lib/MessageDetail.svelte';
  import BalanceManagement from './lib/BalanceManagement.svelte';
  import PullToRefresh from './lib/PullToRefresh.svelte';
  import { keywords as keywordsStore } from "./lib/tag-store.js";
  import { api } from "./lib/api.js";
  import { getPhoneFlag, mapStatsResponse } from "./lib/countries.js";
  import { auth } from "./lib/auth.js";
  import { isAnomalous } from "./lib/device-status.js";
  import { formatCardNumber } from "./lib/card-number.js";
  import { formatTimeAgo } from "./lib/time.js";
  import { getDaemonStatusMeta, isDaemonConnected } from "./lib/daemon-status.js";
  import {
    getMobileTabDragX,
    getMobileTabIndexAtPoint,
    getMobileTabOptics,
    getMobileTabs,
    getMobileTabState,
  } from "./lib/mobile-tab-state.js";
  import {
    MESSAGE_PAGE_SIZE,
    hasMoreMessages,
    mergeMessagePage,
    nextMessageOffset,
  } from "./lib/message-page.js";

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
  let messageTotal = $state(0);
  let loadingOlderMessages = $state(false);
  let balanceChecks = $state([]);
  let balanceDetailCheck = $state(null);
  // The message whose full body is open in the detail drawer, or null.
  let messageDetail = $state(null);
  let latestSelectedBalanceCheck = $derived(
    selectedPhoneIccid
      ? balanceChecks.find((check) => check.sim_iccid === selectedPhoneIccid) || null
      : null
  );
  let phoneNumbers = $state([]);
  let user = $state(null);
  let loading = $state(true);
  let dataLoading = $state(true); // Track data loading separately
  let currentView = $state("dashboard");
  let iccidMappingsFilter = $state("all");
  let showIccidMappingDialog = $state(false);
  let showMoreMenu = $state(false); // iOS bottom tab: 更多 sheet
  let showSendDrawer = $state(false); // desktop: send drawer (<1600px)
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
  let showDaemonDetails = $state(false);
  let swUpdatePrompt = $state(null);

  // Pull-to-refresh reuses loadData() rather than reloading the page: it refetches
  // phones, messages, stats and balance checks, and only ever sets dataLoading to
  // false, so re-running it updates in place without flashing the skeleton.
  let pullRefreshing = $state(false);

  // Clears the service worker and its caches, then hard-reloads so the next request
  // goes to the network. Reloading is the point, so there is no success toast to read.
  async function handleResetOfflineCache() {
    showMoreMenu = false;
    const result = await resetServiceWorker();
    if (!result.ok) {
      showToast('部分缓存未能清除，请重试', 'error');
      return;
    }
    window.location.reload();
  }

  async function handlePullRefresh() {
    if (pullRefreshing) return;
    pullRefreshing = true;
    try {
      await Promise.all([
        loadData(),
        swUpdatePrompt?.checkForUpdate?.(),
      ]);
    } finally {
      pullRefreshing = false;
    }
  }

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
    connected: false,
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

  // Anomaly counts for the health strip, derived from the live phone list.
  // Computed here (in App) so the same numbers feed both the health strip and
  // the status-alert banner without duplicating the filter logic.
  let anomalySimError    = $derived(phoneNumbers.filter(p => p.status === 'sim_error').length);
  let anomalyMismatch    = $derived(phoneNumbers.filter(p => p.status === 'iccid_mismatch').length);
  let anomalyOffline     = $derived(phoneNumbers.filter(p => p.status === 'offline').length);
  let anomalyTotal       = $derived(phoneNumbers.filter(p => isAnomalous(p.status)).length);
  let daemonMeta         = $derived(getDaemonStatusMeta(daemonStatus.status));
  let hasMoreMessagePages = $derived(hasMoreMessages(messageTotal, messages.length));

  // Permission gate. `user.permissions` comes from /api/auth/me, which derives it from
  // the caller's Auth0 roles. This is UX only — the server enforces the same rules on
  // every endpoint, so hiding a control is a convenience, never a security boundary.
  // Reading `user` inside the function body is enough for runes to re-track it.
  function can(permission) {
    return user?.permissions?.includes(permission) ?? false;
  }

  let canManagePhones = $derived(can('phones.write'));
  let mobileTabs = $derived(getMobileTabs(canManagePhones));
  let mobileTabState = $derived(getMobileTabState({
    currentView,
    showMoreMenu,
    canManagePhones,
  }));
  let mobileTabPointerId = $state(null);
  let mobileTabDragIndex = $state(null);
  let mobileTabDragX = $state(null);
  let mobileTabGlowX = $state(null);
  let mobileTabIconShiftX = $state(0);
  let suppressMobileTabClickUntil = 0;
  let mobileTabVisualIndex = $derived(mobileTabDragIndex ?? mobileTabState.index);
  let mobileTabVisualId = $derived(mobileTabs[mobileTabVisualIndex]);
  let mobileTabSelectionWidth = $derived(`${100 / mobileTabState.count}%`);
  let mobileTabSelectionX = $derived(
    mobileTabDragX !== null
      ? `${mobileTabDragX}px`
      : mobileTabState.index === 0
      ? '0%'
      : `calc(${mobileTabState.index * 100}% + ${mobileTabState.index * 8}px)`,
  );
  let mobileTabGlowPosition = $derived(
    mobileTabGlowX === null ? '50%' : `${mobileTabGlowX}px`,
  );

  function activateMobileTab(target) {
    if (target === 'more') {
      showMoreMenu = !showMoreMenu;
      return;
    }
    navigate(target);
  }

  function handleMobileTabClick(target) {
    if (Date.now() < suppressMobileTabClickUntil) return;
    activateMobileTab(target);
  }

  function updateMobileTabDrag(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const geometry = {
      clientX: event.clientX,
      left: rect.left,
      width: rect.width,
      count: mobileTabs.length,
    };
    mobileTabDragIndex = getMobileTabIndexAtPoint(geometry);
    mobileTabDragX = getMobileTabDragX(geometry);
    const optics = getMobileTabOptics(geometry);
    mobileTabGlowX = optics.glowX;
    mobileTabIconShiftX = optics.iconShiftX;
  }

  function handleMobileTabPointerDown(event) {
    const root = document.documentElement;
    if (
      event.pointerType !== 'touch'
      || event.button !== 0
      || !root.classList.contains('is-ios')
      || !root.classList.contains('is-standalone')
    ) return;

    event.preventDefault();
    mobileTabPointerId = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateMobileTabDrag(event);
  }

  function handleMobileTabPointerMove(event) {
    if (event.pointerId !== mobileTabPointerId) return;
    event.preventDefault();
    updateMobileTabDrag(event);
  }

  function finishMobileTabPointer(event, shouldActivate) {
    if (event.pointerId !== mobileTabPointerId) return;
    event.preventDefault();
    updateMobileTabDrag(event);
    const target = mobileTabs[mobileTabDragIndex];
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    mobileTabPointerId = null;
    mobileTabDragIndex = null;
    mobileTabDragX = null;
    mobileTabGlowX = null;
    mobileTabIconShiftX = 0;

    if (shouldActivate && target) {
      suppressMobileTabClickUntil = Date.now() + 500;
      activateMobileTab(target);
    }
  }

  // Which permission each view requires. Used both for nav visibility and for the hash
  // guard below, so the two cannot disagree.
  const VIEW_PERMISSION = {
    dashboard: 'messages.read',
    send: 'messages.send',
    'iccid-mappings': 'phones.write',
    balances: 'messages.read',
    keywords: 'keywords.read',
    filters: 'filters.read',
    users: 'users.read',
  };

  function navigate(view) {
    // Route changes own the whole visible surface. A detail drawer left mounted
    // above the new route makes a successful tab click look broken.
    messageDetail = null;
    balanceDetailCheck = null;
    showPhoneList = false;
    showMoreMenu = false;
    showSendDrawer = false;
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
      const [phonesResponse, messagesResponse, statsResponse, balanceResponse] =
        await Promise.all([
          auth.authenticatedFetch("/api/phones")
            .then((r) => r.json())
            .catch((err) => {
              console.error('[App] Failed to fetch phones:', err);
              return { success: false, data: [] };
            }),
          auth.authenticatedFetch(`/api/messages?limit=${MESSAGE_PAGE_SIZE}`)
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
          auth.authenticatedFetch("/api/balance-checks?limit=500")
            .then((r) => r.ok ? r.json() : { success: false, data: [] })
            .catch((err) => {
              console.error('[App] Failed to fetch balance checks:', err);
              return { success: false, data: [] };
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
        messages = mergeMessagePage([], messagesResponse.data, { replace: true });
        messageTotal = messagesResponse.pagination?.total ?? messages.length;
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
        messageTotal = 0;
      }

      balanceChecks = balanceResponse?.success && Array.isArray(balanceResponse.data)
        ? balanceResponse.data
        : [];
      
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
    } catch (error) {
      console.warn("Failed to load data:", error);
      // Use default values on error
      phoneNumbers = [];
      updateStatsFromPhones();
      messages = [];
      messageTotal = 0;
      balanceChecks = [];
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
    balanceDetailCheck = null;
    // Switching cards makes an open message from the previous card irrelevant.
    messageDetail = null;
    messages = [];
    messageTotal = 0;
    selectedPhoneIccid = phone?.iccid || null;
    handlePhoneSelection();
    showPhoneList = false;
  }
  
  // Load messages for a specific phone (race-condition safe)
  async function loadMessagesForPhone(phoneIccid, { replace = true } = {}) {
    if (!user) return;

    const requestId = ++messageRequestId;

    try {
      const [response, nextBalanceChecks] = await Promise.all([
        api.getMessages({
          ...(phoneIccid ? { phone_iccid: phoneIccid } : {}),
          limit: MESSAGE_PAGE_SIZE,
          ...(showFiltered ? { include_filtered: 1 } : {})
        }),
        api.getBalanceChecks({ limit: 500 }),
      ]);

      // Discard if user switched phones while we were loading
      if (requestId !== messageRequestId) return;
      balanceChecks = nextBalanceChecks;

      // Keep the badge count fresh even when the offline cache served the list.
      if (response?.pagination?.filtered_count !== undefined) {
        filteredCount = response.pagination.filtered_count;
      }

      if (response && response.data) {
        messageTotal = response.pagination?.total ?? response.data.length;
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
        // Polls merge into loaded history and preserve it on an empty incremental
        // response. Scope/filter changes replace the list, including with empty.
        if (response.data.length > 0) {
          messages = mergeMessagePage(messages, response.data, { replace });
        } else if (replace) {
          messages = [];
        }
      }
    } catch (error) {
      if (requestId !== messageRequestId) return;
      console.error('[App] Failed to load messages:', error);
      // Do not clear messages on poll failure — keep whatever is already loaded.
      // Clearing on transient errors (e.g. network blip, wrangler restart) blanks
      // the UI even though the previous data is still valid.
    }
  }

  async function loadOlderMessages() {
    if (!user || loadingOlderMessages || !hasMoreMessagePages) return;

    loadingOlderMessages = true;
    try {
      const response = await api.getMessages({
        ...(selectedPhoneIccid ? { phone_iccid: selectedPhoneIccid } : {}),
        ...(showFiltered ? { include_filtered: 1 } : {}),
        limit: MESSAGE_PAGE_SIZE,
        offset: nextMessageOffset(messages),
        force_refresh: true,
      });

      if (response?.data?.length) {
        messages = mergeMessagePage(messages, response.data);
      }
      messageTotal = response?.pagination?.total ?? messageTotal;
    } catch (error) {
      console.error('[App] Failed to load older messages:', error);
    } finally {
      loadingOlderMessages = false;
    }
  }

  function handleSetIccidMapping(phone) {
    phoneToMap = phone;
    showIccidMappingDialog = true;
  }

  async function handleIccidMappingSuccess(updated) {
    const { phone_iccid, phone_number, ...rest } = updated;

    // Update the phone in our local list. Spread the full response so
    // sim_role / primary_iccid / carrier / etc. stay in sync after an edit —
    // not just phone_number.
    const phoneIndex = phoneNumbers.findIndex((p) => p.iccid === phone_iccid);
    if (phoneIndex !== -1) {
      phoneNumbers[phoneIndex] = {
        ...phoneNumbers[phoneIndex],
        ...rest,
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
        return response;
      }
      throw new Error(response.error || "发送请求未被接受");
    } catch (error) {
      console.error("Failed to send message:", error);
      showToast("发送失败: " + error.message, 'error');
      throw error;
    }
  }

  async function checkDaemonStatus() {
    try {
      const response = await fetch('/api/daemon/status');
      if (response.ok) {
        const data = await response.json();
        daemonStatus = {
          ...data,
          connected: isDaemonConnected(data.status),
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

  async function openDaemonDetails() {
    showDaemonDetails = true;
    await handleRefreshDaemon();
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
      if (!user || !['dashboard', 'balances'].includes(currentView)) return;
      try {
        // Poll messages for current view
        await loadMessagesForPhone(selectedPhoneIccid, { replace: false });
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
  <!-- Loading: three breathing dots, matches the empty-state pattern -->
  <div class="min-h-screen flex items-center justify-center bg-[#F7F5F2]">
    <div class="flex gap-2">
      <span class="w-3 h-3 rounded-full bg-emerald-400 animate-pulse"></span>
      <span class="w-3 h-3 rounded-full bg-emerald-200 animate-pulse [animation-delay:.2s]"></span>
      <span class="w-3 h-3 rounded-full bg-emerald-100 animate-pulse [animation-delay:.4s]"></span>
    </div>
  </div>

{:else if !user}
  <!-- Login: product mark + tagline + button + daemon status footnote (§9) -->
  <div class="min-h-screen flex items-center justify-center bg-[#F7F5F2]">
    <div class="w-full max-w-[460px] mx-4">
      <div class="bg-white border border-stone-200 rounded-2xl p-10 shadow-raised text-center">
        <!-- Product mark: favicon + title -->
        <div class="flex items-center justify-center gap-2.5 mb-5">
          <img src="/favicon.svg" alt="" class="w-[52px] h-[52px] rounded-xl" />
        </div>
        <h1 class="text-lg font-semibold text-stone-900 tracking-tight">验证码中心</h1>
        <p class="text-sm text-stone-500 mt-2 mb-6 leading-relaxed">
          需要公司邮箱和 sms 角色。<br>首次登录后默认为查看者。
        </p>
        <button
          onclick={() => auth.login()}
          class="w-full px-6 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-xl
            transition-colors shadow-focus"
        >
          使用 Auth0 登录
        </button>
        <p class="mt-5 text-[11px] font-mono text-stone-400">
          95 modems ·
          采集服务{daemonMeta.label}
        </p>
      </div>
    </div>
  </div>
{:else}
  <div class="min-h-screen lg:h-screen lg:flex lg:flex-col lg:overflow-hidden bg-[#F7F5F2]">
    <!-- Header — matches design §一 exactly:
         product mark · title · nav (4 items) · daemon pill · send button · avatar -->
    <header class="bg-white border-b border-stone-200 sticky top-0 z-40 lg:flex-shrink-0">
      <div class="px-4 lg:px-5 flex items-center h-[52px] gap-3 lg:gap-6">

        <!-- Product mark + title -->
        <div class="flex items-center gap-2.5 shrink-0">
          <img src="/favicon.svg" alt="" class="w-[30px] h-[30px] rounded-[8px]" />
          <span class="text-[17px] leading-none font-semibold text-stone-900 tracking-[-0.01em]">验证码中心</span>
        </div>

        <!-- Nav — 4 items per design (desktop only) -->
        <nav class="hidden lg:flex items-center gap-0.5 flex-1">
          <button onclick={() => navigate("dashboard")}
            class="text-sm px-3 py-1.5 rounded-[7px] transition-all
              {currentView === 'dashboard'
                ? 'bg-stone-100 font-semibold text-stone-900'
                : 'text-stone-500 hover:text-stone-900 hover:bg-stone-50'}">
            消息
          </button>
          {#if can('phones.write')}
            <button onclick={() => { iccidMappingsFilter = 'all'; navigate('iccid-mappings'); }}
              class="text-sm px-3 py-1.5 rounded-[7px] transition-all
                {currentView === 'iccid-mappings'
                  ? 'bg-stone-100 font-semibold text-stone-900'
                  : 'text-stone-500 hover:text-stone-900 hover:bg-stone-50'}">
              设备与卡
            </button>
          {/if}
          <button onclick={() => navigate('balances')}
            class="text-sm px-3 py-1.5 rounded-[7px] transition-all
              {currentView === 'balances'
                ? 'bg-stone-100 font-semibold text-stone-900'
                : 'text-stone-500 hover:text-stone-900 hover:bg-stone-50'}">
            余额
          </button>
          {#if can('keywords.read') || can('filters.read')}
            <button onclick={() => navigate(can('filters.read') ? 'filters' : 'keywords')}
              class="text-sm px-3 py-1.5 rounded-[7px] transition-all
                {(currentView === 'keywords' || currentView === 'filters')
                  ? 'bg-stone-100 font-semibold text-stone-900'
                  : 'text-stone-500 hover:text-stone-900 hover:bg-stone-50'}">
              规则
            </button>
          {/if}
          {#if can('users.read')}
            <button onclick={() => navigate('users')}
              class="text-sm px-3 py-1.5 rounded-[7px] transition-all
                {currentView === 'users'
                  ? 'bg-stone-100 font-semibold text-stone-900'
                  : 'text-stone-500 hover:text-stone-900 hover:bg-stone-50'}">
              用户
            </button>
          {/if}
        </nav>

        <!-- Right side: daemon pill + send button + avatar -->
        <div class="hidden lg:flex items-center gap-3 ml-auto shrink-0">

          <!-- Daemon status pill -->
          <button onclick={openDaemonDetails}
            aria-haspopup="dialog"
            aria-expanded={showDaemonDetails}
            class="flex items-center gap-1.5 px-2.5 py-[5px] bg-stone-50 border border-stone-200
              rounded-[7px] text-xs transition-colors hover:bg-stone-100 {daemonRefreshing ? 'opacity-60' : ''}">
            <span class="w-1.5 h-1.5 rounded-full shrink-0 {daemonMeta.dotClass}"></span>
            <span class="font-medium {daemonMeta.textClass}">采集服务{daemonMeta.label}</span>
            {#if daemonStatus.reasons?.[0]}
              <span class="max-w-[180px] truncate text-stone-500" title={daemonStatus.reasons[0]}>
                · {daemonStatus.reasons[0]}
              </span>
            {/if}
            {#if daemonStatus.last_heartbeat}
              <span class="text-stone-400">· {formatTimeAgo(daemonStatus.last_heartbeat)}</span>
            {/if}
          </button>

          <!-- Send button — only on <1600px (≥1600px has resident 3rd column) -->
          {#if can('messages.send')}
            <button onclick={() => showSendDrawer = !showSendDrawer}
              class="2xl:hidden flex items-center gap-1.5 px-3.5 py-[7px] bg-orange-500
                hover:bg-orange-600 text-white text-sm font-medium rounded-[8px] transition-colors">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
              </svg>
              发送短信
            </button>
          {/if}

          <!-- Avatar -->
          {#if user}
            {@const initials = (user.name || user.email || '?')[0].toUpperCase()}
            <button onclick={() => auth.logout()} title="退出登录"
              class="w-[26px] h-[26px] rounded-full bg-stone-200 hover:bg-stone-300 flex items-center
                justify-center text-[11px] font-semibold text-stone-700 transition-colors shrink-0">
              {initials}
            </button>
          {/if}
        </div>

        <!-- Mobile: this is a receiver selector, not global navigation. -->
        {#if currentView === 'dashboard'}
          <button
            class="lg:hidden ml-auto min-w-0 max-w-[190px] h-9 px-2.5 flex items-center gap-1.5
              border border-stone-200 bg-stone-50 text-stone-700 rounded-lg transition-colors
              hover:bg-stone-100 active:bg-stone-200"
            onclick={() => { showMoreMenu = false; showPhoneList = true; }}
            aria-haspopup="dialog"
            aria-expanded={showPhoneList}
            aria-label={selectedPhone ? `切换接收卡，当前为${selectedPhone.number || formatCardNumber(selectedPhone.sim_index)}` : '选择接收卡'}
          >
            <svg class="w-4 h-4 text-stone-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="7" y="2" width="10" height="20" rx="2" stroke-width="2"/>
              <path stroke-linecap="round" stroke-width="2" d="M10 5h4M11 18h2"/>
            </svg>
            <span class="truncate text-xs font-medium">
              {#if selectedPhone}
                <span class="font-mono">{formatCardNumber(selectedPhone.sim_index)}</span>
                <span class="text-stone-300 px-0.5">·</span>
                {selectedPhone.flag || ''}{selectedPhone.number || '未设置号码'}
              {:else}
                全部设备
              {/if}
            </span>
            <svg class="w-3.5 h-3.5 text-stone-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 9l6 6 6-6"/>
            </svg>
          </button>
        {/if}

      </div>
    </header>
    <!-- Content below header fills remaining height on desktop. The mobile padding
         uses the same safe-area-aware height as the fixed bottom tab bar. -->
    <!-- Pull-to-refresh wraps the whole content area so every mobile view gets it.
         Standalone (home-screen) launches hide Safari's own pull-to-refresh, so the
         gesture has to come from the app. Desktop binds no listeners. -->
    <PullToRefresh onRefresh={handlePullRefresh}>
    <div class="pb-[var(--mobile-tab-bar-height)] lg:pb-0 lg:flex-1 lg:min-h-0 lg:flex lg:flex-col lg:overflow-hidden">

    <!-- Daemon offline / error banner (§9 error state).
         "下面显示的是那时的数据" — reassures users the existing data is still visible.
         No "查看硬件诊断" button — that page doesn't exist. -->
    {#if daemonStatus.status === 'offline' || daemonStatus.status === 'error'}
      <div class="bg-red-50 border-b border-red-200 px-4 py-3">
        <div class="flex items-start gap-3">
          <span class="mt-0.5 shrink-0">
            <span class="inline-block w-2.5 h-2.5 rounded-full bg-red-500"></span>
          </span>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-red-800">
              守护进程{daemonStatus.status === 'error' ? '错误' : '离线'}
            </p>
            <p class="text-xs text-red-600 mt-0.5 leading-relaxed">
              {#if daemonStatus.last_heartbeat}
                最后一次心跳是 <strong>{formatTimeAgo(daemonStatus.last_heartbeat)}</strong>。
                下面显示的是那时的数据，新短信不会进来。
              {:else}
                {daemonStatus.message || '设备数据可能不是最新的。历史消息仍可查看。'}
              {/if}
            </p>
            <p class="text-xs text-red-500 mt-1">通常是 Orange Pi 掉线或 USB 集线器断电。</p>
          </div>
          <button onclick={() => window.location.reload()}
            class="shrink-0 px-3 py-1.5 text-xs font-medium text-red-700 border border-red-300
              rounded-lg hover:bg-red-100 transition-colors">
            重新连接
          </button>
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

    <!-- Mobile nav: bottom tab bar (rendered at the bottom of the outer div).
         The old horizontal button row crammed 5 items into 390px with ~32px
         tap targets (below the 44px iOS minimum) and wrapped on narrow screens.
         Replaced by a 4-tab bottom bar: 验证码 / 设备 / 发送 / 更多.
         "更多" is a sheet that lists 规则 and 用户管理 per permission. -->


    {#if currentView === "dashboard"}
      <ErrorBoundary componentName="Dashboard">
        <!-- Health Strip — flat full-width bar, 40px, matches design §一 exactly. -->
        <div class="lg:flex-shrink-0 bg-white border-b border-stone-200 flex-shrink-0">
          <div class="flex items-center gap-6 px-5 h-10 overflow-x-auto">

            <!-- Online count: 22px bold mono + /95 small + label -->
            <div class="flex items-baseline gap-1.5 shrink-0">
              <span class="font-mono text-[22px] font-semibold text-stone-900 leading-none tabular-nums tracking-[-0.02em]">
                {stats.onlineDevices}
              </span>
              <span class="font-mono text-sm text-stone-400">/ {stats.totalDevices || phoneNumbers.length}</span>
              <span class="text-xs text-stone-600">张卡在线</span>
            </div>

            <!-- Anomaly chips — only rendered when the count is non-zero so the
                 strip stays uncluttered when everything is healthy. Each links to
                 the ICCID page pre-filtered to the anomaly group. -->
            {#if anomalySimError > 0 || anomalyMismatch > 0 || anomalyOffline > 0}
              <div class="h-4 w-px bg-stone-200 shrink-0"></div>
              <div class="flex items-center gap-3 shrink-0">
                {#if anomalySimError > 0}
                  <span class="flex items-center gap-1.5 text-xs text-stone-600">
                    <span class="inline-block w-2 h-2 rounded-sm bg-red-500 shrink-0"></span>
                    读卡失败 <strong class="font-mono tabular-nums">{anomalySimError}</strong>
                  </span>
                {/if}
                {#if anomalyMismatch > 0}
                  <span class="flex items-center gap-1.5 text-xs text-stone-600">
                    <span class="inline-block w-2 h-2 rounded-sm bg-amber-500 shrink-0"></span>
                    ICCID 不匹配 <strong class="font-mono tabular-nums">{anomalyMismatch}</strong>
                  </span>
                {/if}
                {#if anomalyOffline > 0}
                  <span class="flex items-center gap-1.5 text-xs text-stone-600">
                    <span class="inline-block w-2 h-2 rounded-sm bg-stone-300 shrink-0"></span>
                    离线 <strong class="font-mono tabular-nums">{anomalyOffline}</strong>
                  </span>
                {/if}
              </div>

              {#if can('phones.write')}
                <button
                  onclick={() => { iccidMappingsFilter = "error"; navigate("iccid-mappings"); }}
                  class="text-xs text-action-text font-medium border-b border-[#fdba74] hover:border-orange-400 transition-colors shrink-0"
                >
                  处理 →
                </button>
              {/if}
            {:else if phoneNumbers.length > 0}
              <div class="h-4 w-px bg-stone-200 shrink-0"></div>
              <span class="flex items-center gap-1.5 text-xs text-emerald-600">
                <span class="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0"></span>
                全部正常
              </span>
            {/if}

          </div>
        </div>

      <!-- Main Content.
           Desktop grid: 2xl (≥1600px) = 3 cols (phone · messages · send),
           lg-2xl (<1600px) = 2 cols (phone · messages), send is a drawer. -->
      <div class="px-0 sm:px-4 lg:px-5 lg:pt-4 lg:pb-4 lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
        <div class="lg:grid lg:gap-4 lg:flex-1 lg:min-h-0 lg:grid-cols-[288px_1fr] {can('messages.send') ? '2xl:grid-cols-[288px_1fr_352px]' : ''}">
          <!-- Mobile receiver picker: a bottom sheet keeps the message context visible. -->
          {#if showPhoneList}
            <div
              class="lg:hidden fixed inset-0 z-50"
              onkeydown={(e) => e.key === "Escape" && (showPhoneList = false)}
              role="presentation"
            >
              <button
                class="absolute inset-0 bottom-[var(--mobile-tab-bar-height)] w-full bg-stone-900/35"
                onclick={() => (showPhoneList = false)}
                aria-label="关闭接收卡选择"
              ></button>
              <div
                class="absolute left-0 right-0 bottom-[var(--mobile-tab-bar-height)] h-[min(68dvh,620px)] max-h-[calc(100dvh_-_52px_-_var(--mobile-tab-bar-height))]
                  bg-white rounded-t-2xl shadow-[0_-12px_36px_rgba(28,25,23,.2)] overflow-hidden
                  flex flex-col"
                role="dialog"
                aria-modal="true"
                aria-labelledby="receiver-picker-title"
              >
                <div class="flex-shrink-0 border-b border-stone-200">
                  <div class="flex justify-center pt-2 pb-1" aria-hidden="true">
                    <span class="w-9 h-1 rounded-full bg-stone-300"></span>
                  </div>
                  <div class="h-11 px-4 flex items-center gap-2">
                    <div class="min-w-0 flex-1">
                      <h2 id="receiver-picker-title" class="text-sm font-semibold text-stone-900">选择接收卡</h2>
                      <p class="text-[11px] text-stone-400 mt-0.5">共 {phoneNumbers.length} 台设备</p>
                    </div>
                    <button
                      class="w-9 h-9 -mr-1 flex items-center justify-center rounded-lg text-stone-500
                        hover:bg-stone-100 active:bg-stone-200"
                      onclick={() => (showPhoneList = false)}
                      aria-label="关闭"
                    >
                      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                      </svg>
                    </button>
                  </div>
                </div>
                <div class="flex-1 min-h-0">
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

          <!-- Desktop Phone List — fixed 288px column -->
          <div class="hidden lg:flex lg:flex-col h-full min-h-0">
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

          <!-- Message View Column — fills remaining space -->
          <div class="flex flex-col h-full min-h-0 {selectedPhone ? 'lg:grid lg:grid-rows-[minmax(300px,1fr)_auto] lg:gap-3' : ''}">
            <div class="min-h-0 flex flex-col">
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
                {balanceChecks}
                onOpenBalance={(check) => balanceDetailCheck = check}
                onOpenMessage={(message) => messageDetail = message}
                hasMore={hasMoreMessagePages}
                onLoadMore={loadOlderMessages}
                loadingMore={loadingOlderMessages}
              />
            </div>
            {#if selectedPhone}
              <div class="hidden lg:block min-h-0">
                <PhoneDetails
                  phone={selectedPhone}
                  mobile={false}
                  {daemonStatus}
                  balanceCheck={latestSelectedBalanceCheck}
                  onOpenBalance={(check) => balanceDetailCheck = check}
                  phones={phoneNumbers}
                />
              </div>
            {/if}
          </div>

          <!-- Send panel: resident 3rd column at ≥1600px, hidden below -->
          {#if can('messages.send')}
            <div class="hidden 2xl:flex 2xl:flex-col h-full min-h-0">
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
    {:else if currentView === "send"}
      <ErrorBoundary componentName="MessageComposer">
        <div class="lg:flex-1 lg:min-h-0 lg:overflow-auto lg:px-8 lg:py-6">
          <div class="lg:max-w-[420px] lg:h-full lg:mx-auto">
            <MessageComposer
              {selectedPhone}
              {phoneNumbers}
              {messages}
              mobilePage={true}
              onmessagesent={handleMessageSent}
            />
          </div>
        </div>
      </ErrorBoundary>
    {:else if currentView === "iccid-mappings"}
      <ErrorBoundary componentName="IccidMappings">
        <!-- ICCID Mappings View -->
        <div class="px-0 py-0 sm:px-4 sm:py-6 lg:px-8 lg:flex-1 lg:min-h-0 lg:overflow-hidden">
          <IccidMappings initialStatusFilter={iccidMappingsFilter} />
        </div>
      </ErrorBoundary>
    {:else if currentView === "balances"}
      <ErrorBoundary componentName="BalanceManagement">
        <div class="lg:flex-1 lg:min-h-0 lg:overflow-hidden">
          <BalanceManagement
            {phoneNumbers}
            {balanceChecks}
            canQueryBalances={can('balances.query')}
            canWriteBills={can('bills.write')}
            onQueriesChanged={() => loadMessagesForPhone(selectedPhoneIccid)}
            onOpenBalance={(check) => balanceDetailCheck = check}
          />
        </div>
      </ErrorBoundary>
    {:else if currentView === "keywords" || currentView === "filters"}
      <div class="px-0 py-0 lg:px-8 lg:py-6 lg:flex-1 lg:min-h-0 lg:overflow-auto bg-white lg:bg-transparent">
        {#if can('keywords.read') && can('filters.read')}
          <div class="flex items-center p-1 m-3 lg:inline-flex lg:m-0 lg:mb-5 bg-stone-200/70 rounded-lg" aria-label="规则类型">
            <button
              onclick={() => navigate('filters')}
              class="flex-1 lg:flex-none px-3 py-1.5 rounded-md text-sm transition-colors
                {currentView === 'filters'
                  ? 'bg-white text-stone-900 font-semibold shadow-sm'
                  : 'text-stone-500 hover:text-stone-800'}"
            >垃圾过滤</button>
            <button
              onclick={() => navigate('keywords')}
              class="flex-1 lg:flex-none px-3 py-1.5 rounded-md text-sm transition-colors
                {currentView === 'keywords'
                  ? 'bg-white text-stone-900 font-semibold shadow-sm'
                  : 'text-stone-500 hover:text-stone-800'}"
            >关键词高亮</button>
          </div>
        {/if}

        {#if currentView === "filters"}
          <ErrorBoundary componentName="FilterRules">
            <FilterRules />
          </ErrorBoundary>
        {:else}
          <ErrorBoundary componentName="Keywords">
            <KeywordConfig />
          </ErrorBoundary>
        {/if}
      </div>
    {:else if currentView === "users"}
      <ErrorBoundary componentName="UserManagement">
        <div class="px-0 py-0 lg:px-8 lg:py-6 lg:flex-1 lg:min-h-0 lg:overflow-auto">
          <UserManagement currentUserId={user?.id ?? null} />
        </div>
      </ErrorBoundary>
    {/if}
    </div><!-- end content wrapper -->
    </PullToRefresh>

    <!-- ── Send drawer (<1600px, desktop only) ──────────────────────────── -->
    {#if showSendDrawer && can('messages.send')}
      <div class="hidden lg:block 2xl:hidden fixed inset-0 z-30 bg-stone-900/28"
        onclick={() => showSendDrawer = false}
        role="presentation">
      </div>
      <div class="hidden lg:flex 2xl:hidden fixed top-0 right-0 bottom-0 z-40 w-[400px] flex-col
        bg-white border-l border-stone-200"
        style="box-shadow: -16px 0 40px rgba(28,25,23,.16);">
        <div class="flex items-center justify-between px-5 py-4 border-b border-stone-200 flex-shrink-0">
          <h3 class="text-sm font-semibold text-stone-900">发送短信</h3>
          <button onclick={() => showSendDrawer = false}
            class="p-1.5 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-lg transition-colors">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto">
          <MessageComposer
            {selectedPhone}
            {phoneNumbers}
            {messages}
            onmessagesent={handleMessageSent}
          />
        </div>
      </div>
    {/if}

    {#if balanceDetailCheck}
      <BalanceQueryDetail
        check={balanceDetailCheck}
        onClose={() => balanceDetailCheck = null}
      />
    {/if}

    {#if messageDetail}
      <MessageDetail
        message={messageDetail}
        {selectedPhone}
        {filterRules}
        keywords={$keywordsStore}
        onClose={() => messageDetail = null}
      />
    {/if}

    <!-- ── iOS bottom tab bar ────────────────────────────────────────────── -->
    <!-- lg:hidden: desktop uses the top nav. The safe-area padding keeps controls
         clear of both Safari chrome and the home indicator. -->
    <nav class="mobile-tab-bar lg:hidden fixed bottom-0 left-0 right-0 z-40
      bg-white border-t border-stone-200
      flex items-stretch touch-manipulation isolate"
      style="box-shadow: 0 -1px 0 rgba(28,25,23,.06); padding-bottom: var(--mobile-tab-safe-area); --mobile-tab-selection-width: {mobileTabSelectionWidth}; --mobile-tab-selection-x: {mobileTabSelectionX}; --mobile-tab-glow-x: {mobileTabGlowPosition}; --mobile-tab-icon-shift-x: {mobileTabIconShiftX}px;"
      data-mobile-tab-dragging={mobileTabPointerId !== null}
      onpointerdown={handleMobileTabPointerDown}
      onpointermove={handleMobileTabPointerMove}
      onpointerup={(event) => finishMobileTabPointer(event, true)}
      onpointercancel={(event) => finishMobileTabPointer(event, false)}>

      <span class="mobile-tab-selection" data-mobile-tab-selection aria-hidden="true"></span>

      <!-- 验证码 tab -->
      <button onclick={() => handleMobileTabClick('dashboard')}
        data-mobile-tab-active={mobileTabVisualId === 'dashboard'}
        class="mobile-tab-button relative z-[1] flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[var(--mobile-tab-content-height)]
          touch-manipulation active:bg-stone-100 transition-colors
          {mobileTabVisualId === 'dashboard' ? 'text-[#c2410c]' : 'text-stone-400'}">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M7 8h10M7 12h6m-6 4h10M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"/>
        </svg>
        <span class="text-[10px] font-semibold leading-none">验证码</span>
      </button>

      <!-- 设备 tab — links to iccid-mappings; gated to phones.write -->
      {#if canManagePhones}
        <button onclick={() => handleMobileTabClick('iccid-mappings')}
          data-mobile-tab-active={mobileTabVisualId === 'iccid-mappings'}
          class="mobile-tab-button relative z-[1] flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[var(--mobile-tab-content-height)]
            touch-manipulation active:bg-stone-100 transition-colors
            {mobileTabVisualId === 'iccid-mappings' ? 'text-[#c2410c]' : 'text-stone-400'}">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="5" width="14" height="14" rx="2"/>
            <rect x="9" y="9" width="6" height="6" rx="1"/>
            <path stroke-linecap="round" d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/>
          </svg>
          <span class="text-[10px] font-semibold leading-none">设备</span>
        </button>
      {/if}

      <!-- 余额 tab -->
      <button onclick={() => handleMobileTabClick('balances')}
        data-mobile-tab-active={mobileTabVisualId === 'balances'}
        class="mobile-tab-button relative z-[1] flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[var(--mobile-tab-content-height)]
          touch-manipulation active:bg-stone-100 transition-colors
          {mobileTabVisualId === 'balances' ? 'text-[#c2410c]' : 'text-stone-400'}">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 7.5A2.5 2.5 0 016.5 5H19a1 1 0 011 1v12a1 1 0 01-1 1H6.5A2.5 2.5 0 014 16.5v-9z"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 8h13m0 3h4v4h-4a2 2 0 010-4z"/>
        </svg>
        <span class="text-[10px] font-semibold leading-none">余额</span>
      </button>

      <!-- 发送 tab — a first-class route, like the other primary tabs. -->
      <button onclick={() => handleMobileTabClick('send')}
        data-mobile-tab-active={mobileTabVisualId === 'send'}
        class="mobile-tab-button relative z-[1] flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[var(--mobile-tab-content-height)]
          touch-manipulation active:bg-stone-100 transition-colors
          {mobileTabVisualId === 'send' ? 'text-[#c2410c]' : 'text-stone-400 hover:text-stone-600'}">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M5 5h9a3 3 0 013 3v1M5 5a3 3 0 00-3 3v5a3 3 0 003 3h2l3.5 3v-3H13"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M14 12h8m-3-3 3 3-3 3"/>
        </svg>
        <span class="text-[10px] font-semibold leading-none">发送</span>
      </button>

      <!-- 更多 tab — reveals a sheet with 规则 + 用户管理 -->
      <button onclick={() => handleMobileTabClick('more')}
        data-mobile-tab-active={mobileTabVisualId === 'more'}
        class="mobile-tab-button relative z-[1] flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[var(--mobile-tab-content-height)]
          touch-manipulation active:bg-stone-100 transition-colors
          {mobileTabVisualId === 'more' ? 'text-[#c2410c]' : 'text-stone-400'}">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M4 6h16M4 12h16M4 18h16"/>
        </svg>
        <span class="text-[10px] font-semibold leading-none">更多</span>
      </button>
    </nav>

    <!-- ── 更多 bottom sheet ────────────────────────────────────────────── -->
    {#if showMoreMenu}
      <div class="lg:hidden fixed inset-0 z-[35] bg-stone-900/20"
        onclick={() => showMoreMenu = false}
        role="presentation">
      </div>
      <div class="lg:hidden fixed bottom-[var(--mobile-tab-bar-height)] left-0 right-0 z-40 bg-white border-t border-stone-200 rounded-t-2xl
        shadow-[0_-8px_30px_rgba(28,25,23,.18)]">
        <div class="p-4 space-y-1">
          <p class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest px-3 mb-2">运行状态</p>
          <button onclick={() => { showMoreMenu = false; openDaemonDetails(); }}
            class="w-full flex items-center justify-between px-3 py-3 rounded-lg hover:bg-stone-50 transition-colors text-left">
            <div class="flex items-center gap-2.5">
              <span class="w-2 h-2 rounded-full {daemonMeta.dotClass}"></span>
              <div>
                <div class="text-sm font-medium text-stone-800">采集服务{daemonMeta.label}</div>
                <div class="text-xs text-stone-400 mt-0.5">心跳 {formatTimeAgo(daemonStatus.last_heartbeat)}</div>
              </div>
            </div>
            <svg class="w-4 h-4 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
            </svg>
          </button>

          <div class="border-t border-stone-100 my-2"></div>
          <p class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest px-3 mb-2">规则</p>

          {#if can('filters.read')}
            <button onclick={() => navigate('filters')}
              class="w-full flex items-center justify-between px-3 py-3 rounded-xl hover:bg-stone-50 transition-colors text-left">
              <div>
                <div class="text-sm font-medium text-stone-800">垃圾过滤</div>
                <div class="text-xs text-stone-400 mt-0.5">隐藏非验证码推广短信</div>
              </div>
              <svg class="w-4 h-4 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
              </svg>
            </button>
          {/if}

          {#if can('keywords.read')}
            <button onclick={() => navigate('keywords')}
              class="w-full flex items-center justify-between px-3 py-3 rounded-xl hover:bg-stone-50 transition-colors text-left">
              <div>
                <div class="text-sm font-medium text-stone-800">关键词高亮</div>
                <div class="text-xs text-stone-400 mt-0.5">标色识别验证码类型</div>
              </div>
              <svg class="w-4 h-4 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
              </svg>
            </button>
          {/if}

          {#if can('users.read')}
            <div class="border-t border-stone-100 my-2"></div>
            <p class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest px-3 mb-2">管理</p>
            <button onclick={() => navigate('users')}
              class="w-full flex items-center justify-between px-3 py-3 rounded-xl hover:bg-stone-50 transition-colors text-left">
              <div>
                <div class="text-sm font-medium text-stone-800">用户管理</div>
                <div class="text-xs text-stone-400 mt-0.5">管理员 / 查看者角色</div>
              </div>
              <svg class="w-4 h-4 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
              </svg>
            </button>
          {/if}

          <div class="border-t border-stone-100 my-2"></div>
          <p class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest px-3 mb-2">账户</p>
          <!-- Recovery path for a bad service worker. Reverting the deployment does not
               uninstall a worker already on the device, and iOS Safari offers no
               discoverable way to clear one, so this is the only self-service fix. -->
          <button onclick={handleResetOfflineCache}
            class="w-full flex items-center justify-between px-3 py-3 rounded-xl hover:bg-stone-50 transition-colors text-left">
            <div>
              <div class="text-sm font-medium text-stone-700">重置离线缓存</div>
              <div class="text-xs text-stone-400 mt-0.5">页面异常或版本卡住时使用</div>
            </div>
            <svg class="w-4 h-4 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
            </svg>
          </button>
          <button onclick={() => auth.logout()}
            class="w-full flex items-center justify-between px-3 py-3 rounded-xl hover:bg-stone-50 transition-colors text-left">
            <div class="text-sm font-medium text-stone-700">退出登录</div>
            <svg class="w-4 h-4 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
            </svg>
          </button>
        </div>
      </div>
    {/if}

  </div><!-- end outer -->
{/if}

{#if showDaemonDetails}
  <DaemonHealthPanel
    status={daemonStatus}
    refreshing={daemonRefreshing}
    onRefresh={handleRefreshDaemon}
    onClose={() => showDaemonDetails = false}
  />
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

<!-- Service worker update prompt. Outside the main layout because it is a fixed
     overlay and must not participate in the app's flex chain. -->
<SwUpdatePrompt bind:this={swUpdatePrompt} />
