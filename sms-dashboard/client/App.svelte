<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import IccidMappings from './lib/IccidMappings.svelte';
  import MessageComposer from './lib/MessageComposer.svelte';
  import IccidMappingDialog from './lib/IccidMappingDialog.svelte';
  import UserManagement from './lib/UserManagement.svelte';
  import ErrorBoundary from './lib/ErrorBoundary.svelte';
  import SwUpdatePrompt from './lib/SwUpdatePrompt.svelte';
  import ConfirmHost from './lib/ConfirmHost.svelte';
  import DaemonHealthPanel from './lib/DaemonHealthPanel.svelte';
  import BalanceQueryDetail from './lib/BalanceQueryDetail.svelte';
  import MessageDetail from './lib/MessageDetail.svelte';
  import BalanceManagement from './lib/BalanceManagement.svelte';
  import PullToRefresh from './lib/PullToRefresh.svelte';
  import { keywords as keywordsStore } from './lib/tag-store.js';
  import { ApiError, api, contractApi, errorMessage } from './lib/api.js';
  import { getPhoneFlag } from './lib/countries.js';
  import { auth } from './lib/auth.js';
  import { getDaemonStatusMeta, isDaemonConnected, type DaemonView } from './lib/daemon-status.js';
  import { MESSAGE_PAGE_SIZE } from './lib/message-page.js';
  import { toEpochMilliseconds } from './lib/time.js';
  import type { MeResponse } from '../shared/api/auth.js';
  import type { D1QuotaExceeded } from '../shared/api/d1-quota.js';
  import type { CreateIccidMappingResponse } from '../shared/api/iccid-mappings.js';
  import type { ApiMessage } from '../shared/api/messages.js';
  import type { Phone } from '../shared/api/phones.js';
  import { textOr } from '../shared/text.js';
  import { isView, VIEW_PERMISSION, type View } from '../shared/views.js';
  import AuthGate from './app/AuthGate.svelte';
  import { intervalMs } from '../shared/recurring.js';
  import { BalanceChecks } from './app/balance-checks.svelte.js';
  import { CallController } from './app/call-controller.svelte.js';
  import CallLayer from './app/CallLayer.svelte';
  import DashboardView from './app/DashboardView.svelte';
  import DesktopHeader from './app/DesktopHeader.svelte';
  import { MessageFeed } from './app/message-feed.svelte.js';
  import MobileTabBar from './app/MobileTabBar.svelte';
  import MoreMenu from './app/MoreMenu.svelte';
  import { resetLocalCache } from './app/reset-cache.js';
  import RulesView from './app/RulesView.svelte';
  import SendDrawer from './app/SendDrawer.svelte';
  import StatusBanners from './app/StatusBanners.svelte';
  import { ToastQueue } from './app/toasts.svelte.js';
  import ToastStack from './app/ToastStack.svelte';
  import type { ViewPhone } from './app/types.js';

  type SavedMapping = CreateIccidMappingResponse['data'] & { phone_iccid: string };

  let selectedPhoneIccid = $state<string | null>(null);
  let selectedPhone = $state<ViewPhone | null>(null);

  function updateSelectedPhone() {
    selectedPhone = selectedPhoneIccid
      ? (phoneNumbers.find((p) => p.iccid === selectedPhoneIccid) ?? null)
      : null;
  }

  let selectedCountry = $state('all');
  let searchTerm = $state('');
  let showPhoneList = $state(false);
  let messageDetail = $state<ApiMessage | null>(null);
  let phoneNumbers = $state<ViewPhone[]>([]);
  let phoneInventoryRevision = 0;
  let user = $state<MeResponse['user'] | null>(null);
  let loading = $state(true);
  let dataLoading = $state(true);
  let currentView = $state<View>('dashboard');
  let iccidMappingsFilter = $state<'all' | 'error'>('all');
  let showIccidMappingDialog = $state(false);
  let showMoreMenu = $state(false);
  let showSendDrawer = $state(false);
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let pollInFlight = false;
  const POLL_INTERVAL_MS = intervalMs('dashboardMessages');
  const DAEMON_POLL_INTERVAL_MS = intervalMs('dashboardDaemonStatus');
  let lastDaemonPollAt = 0;
  let daemonStatusRequest: Promise<boolean> | null = null;
  let daemonRefreshing = $state(false);
  let d1Quota = $state<D1QuotaExceeded | null>(null);
  let awaitingD1Write = $state(false);
  let databasePollingPaused = $derived(d1Quota !== null && !awaitingD1Write);
  let showDaemonDetails = $state(false);
  let swUpdatePrompt = $state<{ checkForUpdate(): Promise<unknown> } | null>(null);
  let authError = $state<string | null>(null);
  let pullRefreshing = $state(false);
  let phoneToMap = $state<ViewPhone | null>(null);
  let daemonStatus = $state<DaemonView>({
    status: 'unknown',
    message: '正在检查采集服务状态…',
    snapshot: null,
    connected: false,
  });

  const toasts = new ToastQueue();
  const feed = new MessageFeed({
    isSignedIn: () => user !== null,
    selectedIccid: () => selectedPhoneIccid,
    senderPhone: (iccid) => phoneNumbers.find((phone) => phone.iccid === iccid),
    notify: toasts.show,
  });
  const balances = new BalanceChecks({
    isSignedIn: () => user !== null,
    view: () => currentView,
    selectedIccid: () => selectedPhoneIccid,
  });
  const calls = new CallController({
    isSignedIn: () => user !== null,
    can,
    allowHistoryRead: () => !databasePollingPaused,
  });

  async function handleResetLocalCache() {
    showMoreMenu = false;
    await resetLocalCache(toasts.show);
  }

  async function handlePullRefresh() {
    if (pullRefreshing) return;
    pullRefreshing = true;
    try {
      await Promise.all([refreshData(), swUpdatePrompt?.checkForUpdate()]);
    } finally {
      pullRefreshing = false;
    }
  }

  let daemonMeta = $derived(getDaemonStatusMeta(daemonStatus.status));
  // UX only: the server enforces the same permissions on every endpoint.
  function can(permission: string) {
    return user?.permissions.includes(permission) ?? false;
  }

  let canManagePhones = $derived(can('phones.write'));

  function navigate(view: View) {
    // A drawer left open above the new route makes the tab click look broken.
    messageDetail = null;
    balances.closeDetail();
    showPhoneList = false;
    showMoreMenu = false;
    showSendDrawer = false;
    currentView = view;
    window.location.hash = view;
    if (view === 'balances' && !databasePollingPaused) void balances.refresh();
  }

  function openIccidMappings(filter: 'all' | 'error') {
    iccidMappingsFilter = filter;
    navigate('iccid-mappings');
  }

  function handleHashChange() {
    const hash = window.location.hash.slice(1);
    const requested = hash === '' ? 'dashboard' : hash;

    if (!isView(requested)) return;

    // Otherwise a viewer typing #keywords lands on a page whose API calls all 403.
    if (user && !can(VIEW_PERMISSION[requested])) {
      currentView = 'dashboard';
      window.location.hash = 'dashboard';
      return;
    }

    currentView = requested;
  }

  // onMount runs handleHashChange before getUser() resolves; re-validate deep links once `user` is known.
  $effect(() => {
    if (user) handleHashChange();
  });

  function setPhoneNumbers(phones: readonly Phone[]) {
    phoneNumbers = phones.map((phone) => ({ ...phone, flag: getPhoneFlag(phone) }));
    updateSelectedPhone();
  }

  async function refreshPhoneNumbers() {
    const revision = ++phoneInventoryRevision;
    try {
      const { data } = await contractApi.messages.phones();
      if (revision === phoneInventoryRevision) setPhoneNumbers(data);
    } catch (error) {
      toasts.show(errorMessage(error, '卡片列表刷新失败'), 'error');
    }
  }

  async function loadData() {
    if (!user || databasePollingPaused) {
      dataLoading = false;
      return;
    }

    const inventoryRevision = phoneInventoryRevision;
    try {
      const balanceRequest =
        currentView === 'balances' ? api.getBalanceChecks({ limit: 100 }) : Promise.resolve([]);
      const [phonesResponse, messagesResponse, nextBalanceChecks] = await Promise.all([
        api.getPhones(),
        api.getMessages({ limit: MESSAGE_PAGE_SIZE }),
        balanceRequest,
      ]);

      if (inventoryRevision === phoneInventoryRevision) setPhoneNumbers(phonesResponse);

      feed.applyFirstPage(messagesResponse);

      balances.checks = nextBalanceChecks;

      dataLoading = false;
    } catch (error) {
      console.warn('Failed to load data:', error);
      // Keep what was on screen: zeroed counters would read as an offline fleet.
      feed.loadError = errorMessage(error, '数据加载失败');
      dataLoading = false;
    }
  }

  async function refreshData() {
    if (databasePollingPaused) {
      await handleRefreshDaemon();
      return;
    }
    await checkDaemonStatus();
    await loadData();
  }

  onMount(async () => {
    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);

    // The session is an HttpOnly cookie, so asking the server is the only check.
    try {
      user = await auth.getUser();
      authError = null;
    } catch (error) {
      // Not signed out: a login button would just bounce.
      authError = errorMessage(error, '无法连接服务器');
    }

    loading = false;

    if (user) {
      refreshData()
        .finally(() => {
          dataLoading = false;
          startPolling();
          calls.startPolling();
          void calls.loadHistory();
        })
        .catch((error: unknown) => {
          console.error('Failed to load data:', error);
        });
    } else {
      dataLoading = false;
    }
  });

  onDestroy(() => {
    stopPolling();
    window.removeEventListener('hashchange', handleHashChange);
  });

  function selectPhone(phone: Pick<Phone, 'iccid'> | null) {
    balances.closeDetail();
    messageDetail = null;
    feed.clear();
    selectedPhoneIccid = textOr(phone?.iccid, null);
    updateSelectedPhone();
    void feed.load(selectedPhoneIccid);
    void balances.refresh();
    showPhoneList = false;
  }

  function handleSetIccidMapping(phone: Pick<Phone, 'iccid'>) {
    const listed = phoneNumbers.find((p) => p.iccid === phone.iccid);
    if (!listed) return;
    phoneToMap = listed;
    showIccidMappingDialog = true;
  }

  function handleIccidMappingSuccess(updated: SavedMapping) {
    const { phone_iccid, phone_number, ...rest } = updated;

    // Spread the full response so sim_role, primary_iccid and carrier stay in sync.
    const phoneIndex = phoneNumbers.findIndex((p) => p.iccid === phone_iccid);
    const current = phoneNumbers[phoneIndex];
    if (current) {
      phoneNumbers[phoneIndex] = {
        ...current,
        ...rest,
        number: phone_number,
      };
      updateSelectedPhone();
    }
  }

  function checkDaemonStatus(): Promise<boolean> {
    daemonStatusRequest ??= readDaemonStatus()
      .then(() => !databasePollingPaused)
      .finally(() => {
        daemonStatusRequest = null;
      });
    return daemonStatusRequest;
  }

  async function readDaemonStatus() {
    lastDaemonPollAt = Date.now();
    try {
      const data = await contractApi.health.daemonStatus();
      daemonStatus = {
        status: data.status,
        reasons: data.reasons,
        snapshot: data.snapshot,
        connected: isDaemonConnected(data.status),
        ...(data.message === undefined ? {} : { message: data.message }),
        ...('last_heartbeat' in data ? { last_heartbeat: data.last_heartbeat } : {}),
      };
      if (d1Quota?.quota === 'rows_written') {
        const heartbeat = toEpochMilliseconds(daemonStatus.last_heartbeat);
        awaitingD1Write = heartbeat === null || heartbeat <= Date.parse(d1Quota.timestamp);
        if (awaitingD1Write) return;
      }
      d1Quota = null;
      awaitingD1Write = false;
    } catch (error) {
      if (error instanceof ApiError && error.d1Quota !== null) {
        awaitingD1Write = false;
        d1Quota = error.d1Quota;
        return;
      }
      if (error instanceof ApiError) {
        daemonStatus = {
          ...daemonStatus,
          status: 'error',
          message: '采集服务状态检查失败',
          connected: false,
        };
        return;
      }
      console.error('Failed to check daemon status:', error);
      daemonStatus = {
        ...daemonStatus,
        status: 'error',
        message: '无法连接服务器',
        connected: false,
      };
    }
  }

  async function handleRefreshDaemon() {
    if (daemonRefreshing) return;
    daemonRefreshing = true;
    try {
      const wasPaused = databasePollingPaused;
      const readsAvailable = await checkDaemonStatus();
      if (wasPaused && readsAvailable) {
        await loadData();
        void calls.loadHistory();
      }
    } finally {
      daemonRefreshing = false;
    }
  }

  async function openDaemonDetails() {
    showDaemonDetails = true;
    await handleRefreshDaemon();
  }

  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(async () => {
      if (document.visibilityState !== 'visible' || !user || pollInFlight) return;
      pollInFlight = true;
      try {
        const now = Date.now();
        if (databasePollingPaused && d1Quota !== null) {
          if (now >= Date.parse(d1Quota.retry_at) && now - lastDaemonPollAt >= POLL_INTERVAL_MS) {
            await handleRefreshDaemon();
          }
          return;
        }
        if (d1Quota === null && !['dashboard', 'balances'].includes(currentView)) return;
        if (now - lastDaemonPollAt >= DAEMON_POLL_INTERVAL_MS) {
          await checkDaemonStatus();
        }
        if (currentView === 'dashboard' && !databasePollingPaused) {
          await feed.load(selectedPhoneIccid, { replace: false });
        }
      } catch {
        // The next tick retries.
      } finally {
        pollInFlight = false;
      }
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
      pollInFlight = false;
    }
    calls.stopPolling();
  }
</script>

{#if loading || authError !== null || !user}
  <AuthGate {loading} {authError} daemonLabel={daemonMeta.label} />
{:else}
  <div class="min-h-screen lg:h-screen lg:flex lg:flex-col lg:overflow-hidden bg-[#F7F5F2]">
    <DesktopHeader
      {user}
      {currentView}
      {can}
      {calls}
      {daemonStatus}
      {daemonRefreshing}
      {showDaemonDetails}
      {showPhoneList}
      {selectedPhone}
      onNavigate={navigate}
      onOpenIccidMappings={openIccidMappings}
      onOpenDaemonDetails={openDaemonDetails}
      onOpenPhoneList={() => {
        showMoreMenu = false;
        showPhoneList = true;
      }}
      onToggleSendDrawer={() => (showSendDrawer = !showSendDrawer)}
      onResetCache={handleResetLocalCache}
    />
    <!-- Mobile bottom padding matches the fixed tab bar height. Pull-to-refresh binds no listeners on desktop. -->
    <PullToRefresh onRefresh={handlePullRefresh}>
      <div
        class="pb-[var(--mobile-tab-bar-height)] lg:pb-0 lg:flex-1 lg:min-h-0 lg:flex lg:flex-col lg:overflow-hidden"
      >
        <StatusBanners
          {daemonStatus}
          {daemonRefreshing}
          {d1Quota}
          {awaitingD1Write}
          onCheckD1={handleRefreshDaemon}
          {phoneNumbers}
          {can}
          onOpenIccidMappings={openIccidMappings}
        />

        {#if currentView === 'dashboard'}
          <ErrorBoundary componentName="Dashboard">
            <DashboardView
              {phoneNumbers}
              {selectedPhone}
              bind:selectedPhoneIccid
              bind:selectedCountry
              bind:searchTerm
              bind:showPhoneList
              {dataLoading}
              {can}
              {feed}
              {balances}
              {daemonStatus}
              onSelectPhone={selectPhone}
              onSetIccidMapping={handleSetIccidMapping}
              onOpenIccidMappings={openIccidMappings}
              onOpenMessage={(message: ApiMessage) => {
                messageDetail = message;
              }}
              onRetry={() => {
                dataLoading = true;
                void refreshData().finally(() => {
                  dataLoading = false;
                });
              }}
            />
          </ErrorBoundary>
        {:else if currentView === 'send'}
          <ErrorBoundary componentName="MessageComposer">
            <div class="lg:flex-1 lg:min-h-0 lg:overflow-auto lg:px-8 lg:py-6">
              <div class="lg:max-w-[420px] lg:h-full lg:mx-auto">
                <MessageComposer
                  {selectedPhone}
                  {phoneNumbers}
                  messages={feed.messages}
                  mobilePage={true}
                  onmessagesent={feed.send}
                />
              </div>
            </div>
          </ErrorBoundary>
        {:else if currentView === 'iccid-mappings'}
          <ErrorBoundary componentName="IccidMappings">
            <div class="px-0 py-0 sm:px-4 sm:py-6 lg:px-8 lg:flex-1 lg:min-h-0 lg:overflow-hidden">
              <IccidMappings
                initialStatusFilter={iccidMappingsFilter}
                onMappingsChanged={refreshPhoneNumbers}
              />
            </div>
          </ErrorBoundary>
        {:else if currentView === 'balances'}
          <ErrorBoundary componentName="BalanceManagement">
            <div class="lg:flex-1 lg:min-h-0 lg:overflow-hidden">
              <BalanceManagement
                {phoneNumbers}
                balanceChecks={balances.checks}
                {databasePollingPaused}
                canQueryBalances={can('balances.query')}
                canWriteBills={can('bills.write')}
                canManageRunners={can('runners.write')}
                onQueriesChanged={balances.refresh}
                onOpenBalance={balances.open}
              />
            </div>
          </ErrorBoundary>
        {:else if currentView === 'keywords' || currentView === 'filters'}
          <RulesView {currentView} {can} onNavigate={navigate} />
        {:else}
          <ErrorBoundary componentName="UserManagement">
            <div class="px-0 py-0 lg:px-8 lg:py-6 lg:flex-1 lg:min-h-0 lg:overflow-auto">
              <UserManagement currentUserId={user.id} />
            </div>
          </ErrorBoundary>
        {/if}
      </div>
    </PullToRefresh>

    {#if showSendDrawer && can('messages.send')}
      <SendDrawer
        {selectedPhone}
        {phoneNumbers}
        messages={feed.messages}
        onSend={feed.send}
        onClose={() => (showSendDrawer = false)}
      />
    {/if}

    {#if balances.detailCheck}
      <BalanceQueryDetail
        check={balances.detailCheck}
        detail={balances.detail}
        onClose={balances.closeDetail}
      />
    {/if}

    {#if messageDetail}
      <MessageDetail
        message={messageDetail}
        {selectedPhone}
        filterRules={feed.filterRules}
        keywords={$keywordsStore}
        onClose={() => (messageDetail = null)}
      />
    {/if}

    <MobileTabBar
      {currentView}
      {showMoreMenu}
      {canManagePhones}
      onNavigate={navigate}
      onToggleMore={() => (showMoreMenu = !showMoreMenu)}
    />

    {#if showMoreMenu}
      <MoreMenu
        {can}
        {calls}
        {daemonStatus}
        onClose={() => (showMoreMenu = false)}
        onNavigate={navigate}
        onOpenDaemonDetails={openDaemonDetails}
        onResetCache={handleResetLocalCache}
      />
    {/if}
  </div>
{/if}

{#if showDaemonDetails}
  <DaemonHealthPanel
    status={daemonStatus}
    refreshing={daemonRefreshing}
    onRefresh={handleRefreshDaemon}
    onClose={() => (showDaemonDetails = false)}
  />
{/if}

<CallLayer {user} {can} {calls} {phoneNumbers} daemonStatus={daemonStatus.status} />

<IccidMappingDialog
  phone={phoneToMap}
  bind:show={showIccidMappingDialog}
  onsuccess={handleIccidMappingSuccess}
  onclose={() => {
    phoneToMap = null;
    showIccidMappingDialog = false;
  }}
/>

<ToastStack queue={toasts} />

<ConfirmHost />

<!-- Fixed overlay: kept outside the main layout so it stays out of the flex chain. -->
<SwUpdatePrompt bind:this={swUpdatePrompt} />
