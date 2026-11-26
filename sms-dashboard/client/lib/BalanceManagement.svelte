<script lang="ts">
  import { confirmAction } from './confirm.svelte.js';
  import { onMount, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { formatCardNumber } from '../../shared/card-number.js';
  import { buildCarrierOptions, carrierKey } from './carrier.js';
  import { contractApi, errorMessage } from './api.js';
  import { getSimServiceTypeLabel } from './sim-service-type.js';
  import { groupByPrimary } from './group-by-primary.js';
  import { buildBalanceRows, countBalanceHealth } from './balance-overview.js';
  import { activeBalanceCheckIds, balancePollDelay } from './balance-polling.js';
  import {
    type BalanceQueryPreviewResponse,
    BATCH_METHODS,
    type BalanceCheck,
    type BalanceQueryPreflightResponse,
  } from '../../shared/api/balance-checks.js';
  import type { BalanceRunnersResponse } from '../../shared/api/balance-runners.js';
  import type { CarrierBill } from '../../shared/api/carrier-bills.js';
  import { textOr } from '../../shared/text.js';
  import BalanceHeader from './balance/BalanceHeader.svelte';
  import StatusBanners from './balance/StatusBanners.svelte';
  import BatchQueryDialog from './balance/BatchQueryDialog.svelte';
  import BillDetailDialog from './balance/BillDetailDialog.svelte';
  import BillsTab from './balance/BillsTab.svelte';
  import HistoryTab from './balance/HistoryTab.svelte';
  import OverviewFilters from './balance/OverviewFilters.svelte';
  import OverviewTable from './balance/OverviewTable.svelte';
  import RunnerAdminDialog from './balance/RunnerAdminDialog.svelte';
  import RunnerStatus from './balance/RunnerStatus.svelte';
  import SingleQueryDialog from './balance/SingleQueryDialog.svelte';
  import { buildFilterTabs, currentFilterLabel, matchesStatusFilter } from './balance/filters.js';
  import { checkCarrier } from './balance/presentation.js';
  import { compareOverviewRows } from './balance/sort.js';
  import type {
    BalancePhone,
    BalanceRow,
    BatchMethod,
    BillAccount,
    BillAction,
    BillDetail,
    HistorySortKey,
    Notice,
    OverviewSortKey,
    SortDirection,
    StatusFilter,
  } from './balance/types.js';

  interface QueriesChange {
    queuedChecks?: BalanceCheck[];
    activeIds?: string[];
  }

  interface Props {
    phoneNumbers?: readonly BalancePhone[];
    balanceChecks?: readonly BalanceCheck[];
    onOpenBalance?: ((check: BalanceCheck) => void) | null;
    canQueryBalances?: boolean;
    canWriteBills?: boolean;
    canManageRunners?: boolean;
    databasePollingPaused?: boolean;
    onQueriesChanged?: ((change: QueriesChange) => Promise<void>) | null;
  }

  let {
    phoneNumbers = [],
    balanceChecks = [],
    onOpenBalance = null,
    canQueryBalances = false,
    canWriteBills = false,
    canManageRunners = false,
    databasePollingPaused = false,
    onQueriesChanged = null,
  }: Props = $props();

  let activeTab: 'overview' | 'bills' | 'history' = $state('overview');
  let managingRunners = $state(false);
  let statusFilter: StatusFilter = $state('all');
  let carrierFilter = $state('all');
  let searchQuery = $state('');
  let overviewSortKey: OverviewSortKey | null = $state(null);
  let overviewSortDirection: SortDirection = $state('asc');
  let historySortKey: HistorySortKey = $state('time');
  let historySortDirection: SortDirection = $state('desc');
  let queryingIccid: string | null = $state(null);
  let loadingPreview = $state(false);
  let batchSubmitting = $state(false);
  let batchPreview: BalanceQueryPreviewResponse | null = $state(null);
  let batchMethods: Record<BatchMethod, boolean> = $state({
    direct_sms: true,
    sms_ai: false,
    browser: false,
  });
  let batchScope: { phoneIccids: string[]; label: string } | null = $state(null);
  let selectedIccids: string[] = $state([]);
  let singlePreview: { row: BalanceRow; preflight: BalanceQueryPreflightResponse } | null =
    $state(null);
  let notice: Notice | null = $state(null);
  let runnerStatus: BalanceRunnersResponse | null = $state(null);
  let runnerStatusLoading = $state(true);
  let billAccounts: BillAccount[] = $state([]);
  // When set, unpaid bills cannot be trusted.
  let billAccountsError: string | null = $state(null);
  let bills: CarrierBill[] = $state([]);
  let billsLoaded = $state(false);
  let billsLoading = $state(false);
  let billError: string | null = $state(null);
  let selectedBill: BillDetail | null = $state(null);
  let billDetailLoading = $state(false);
  let billActionBusy = $state(false);
  let activePollTimer: ReturnType<typeof setTimeout> | undefined;
  let fastPollingUntil = Date.now() + 15_000;

  let rows = $derived(buildBalanceRows(phoneNumbers, balanceChecks));
  let carrierOptions = $derived.by(() =>
    buildCarrierOptions([
      ...rows.map((row) => ({
        carrier: row.phone.carrier,
        country: row.phone.country,
      })),
      ...balanceChecks.map(checkCarrier),
    ]),
  );
  let carrierRows = $derived(
    rows.filter(
      (row) =>
        carrierFilter === 'all' ||
        carrierKey({ carrier: row.phone.carrier, country: row.phone.country }) === carrierFilter,
    ),
  );
  let billingAccountBySim = $derived.by(() => {
    const map = new SvelteMap<string, BillAccount>();
    for (const account of billAccounts) {
      for (const sim of account.linked_sims) map.set(sim.iccid, account);
    }
    return map;
  });
  let paymentDueAccountBySim = $derived.by(() => {
    const map = new SvelteMap<string, BillAccount>();
    for (const account of billAccounts) {
      if (account.payment_due_count > 0 && account.notification_sim.iccid !== '') {
        map.set(account.notification_sim.iccid, account);
      }
    }
    return map;
  });
  function requiresPayment(row: BalanceRow): boolean {
    return (
      ['zero_or_negative_balance', 'low_balance'].includes(row.health) ||
      paymentDueAccountBySim.has(row.phone.iccid)
    );
  }
  function postpaidPaymentCount(row: BalanceRow): number {
    return paymentDueAccountBySim.get(row.phone.iccid)?.payment_due_count ?? 0;
  }
  let counts = $derived(countBalanceHealth(carrierRows));
  let filterTabs = $derived(buildFilterTabs(carrierRows, counts, requiresPayment));

  let filteredRows = $derived.by(() => {
    const query = searchQuery.trim().toLowerCase();
    return carrierRows
      .filter((row) => matchesStatusFilter(row, statusFilter, requiresPayment))
      .filter((row) => {
        if (!query) return true;
        const phone = row.phone;
        return [
          formatCardNumber(phone.sim_index),
          phone.number,
          phone.iccid,
          phone.carrier,
          getSimServiceTypeLabel(phone.service_type),
        ].some((value) => textOr(value, '').toLowerCase().includes(query));
      })
      .sort((left, right) =>
        compareOverviewRows(left, right, overviewSortKey, overviewSortDirection),
      );
  });
  // Grouped after filtering, so an orphan secondary renders at depth 0 instead of hiding.
  let groupedRows = $derived(groupByPrimary(filteredRows, (row) => row.phone));
  // Backs the "余额随主卡" pointer on secondary rows; absent for an orphan secondary.
  let primaryRowByIccid = $derived.by(() => {
    const map = new SvelteMap<string, BalanceRow>();
    for (const row of filteredRows) {
      if (row.phone.sim_role === 'primary') map.set(row.phone.iccid, row);
    }
    return map;
  });
  function primaryOf(row: BalanceRow): BalanceRow | null {
    const iccid = row.phone.primary_iccid;
    return iccid === null ? null : (primaryRowByIccid.get(iccid) ?? null);
  }
  function isBalanceQueryableRow(row: BalanceRow): boolean {
    return row.phone.sim_role !== 'secondary' && row.phone.service_type !== 'postpaid';
  }
  let selectedIccidSet = $derived(new Set(selectedIccids));
  let filteredIccids = $derived(
    filteredRows.filter(isBalanceQueryableRow).map((row) => row.phone.iccid),
  );
  let allFilteredSelected = $derived(
    filteredIccids.length > 0 && filteredIccids.every((iccid) => selectedIccidSet.has(iccid)),
  );
  let someFilteredSelected = $derived(filteredIccids.some((iccid) => selectedIccidSet.has(iccid)));

  async function loadRunnerStatus() {
    try {
      runnerStatus = await contractApi.balanceRunners.status();
    } catch {
      runnerStatus = null;
    } finally {
      runnerStatusLoading = false;
    }
  }

  $effect(() => {
    if (databasePollingPaused) return;
    untrack(() => {
      void loadRunnerStatus();
      void loadBillingAccounts();
    });
  });

  onMount(() => {
    const interval = setInterval(() => {
      if (!databasePollingPaused) void loadRunnerStatus();
    }, 30_000);
    async function pollActiveQueries() {
      try {
        const activeIds = activeBalanceCheckIds(balanceChecks);
        if (!databasePollingPaused && activeIds.length && document.visibilityState === 'visible') {
          await onQueriesChanged?.({ activeIds });
        }
      } catch (error) {
        console.warn('Failed to refresh active balance queries:', error);
      } finally {
        const delay = balancePollDelay(Date.now(), fastPollingUntil);
        activePollTimer = setTimeout(() => {
          void pollActiveQueries();
        }, delay);
      }
    }
    activePollTimer = setTimeout(() => {
      void pollActiveQueries();
    }, 2_000);
    return () => {
      clearInterval(interval);
      clearTimeout(activePollTimer);
    };
  });

  async function loadBillingAccounts() {
    try {
      const result = await contractApi.carrierBills.accounts();
      billAccounts = result.accounts;
      billAccountsError = null;
    } catch (error) {
      // Must be surfaced: swallowing it renders a failed fetch as "nothing owed".
      billAccounts = [];
      billAccountsError = errorMessage(error, '账单账户加载失败');
    }
  }

  async function loadBills(force = false) {
    if (billsLoading || (billsLoaded && !force)) return;
    billsLoading = true;
    billError = null;
    try {
      const [billResult, accountResult] = await Promise.all([
        contractApi.carrierBills.list({ query: {} }),
        contractApi.carrierBills.accounts(),
      ]);
      bills = billResult.bills;
      billAccounts = accountResult.accounts;
      billsLoaded = true;
    } catch (error) {
      billError = errorMessage(error, '账单加载失败');
    } finally {
      billsLoading = false;
    }
  }

  function openBillsTab() {
    activeTab = 'bills';
    void loadBills();
  }

  async function openBillFromOverview(row: BalanceRow) {
    const account = billingAccountBySim.get(row.phone.iccid);
    if (!account) return;
    try {
      const result = await contractApi.carrierBills.list({ query: { account_id: account.id } });
      const accountBills = result.bills;
      const bill =
        accountBills.find((candidate) =>
          ['unpaid', 'payment_planned', 'needs_review'].includes(candidate.action_status),
        ) ??
        accountBills.slice().sort((left, right) => right.due_date.localeCompare(left.due_date))[0];
      if (bill) await openBill(bill);
      else openBillsTab();
    } catch (error) {
      notice = { type: 'error', message: errorMessage(error, '账单加载失败') };
    }
  }

  async function openBill(bill: CarrierBill) {
    billDetailLoading = true;
    try {
      const result = await contractApi.carrierBills.get({ params: { id: bill.id } });
      selectedBill = result.bill;
    } catch (error) {
      notice = { type: 'error', message: errorMessage(error, '账单详情加载失败') };
    } finally {
      billDetailLoading = false;
    }
  }

  async function recordBillAction(action: BillAction, label: string) {
    if (!selectedBill || billActionBusy || !canWriteBills) return;
    if (
      !(await confirmAction({
        message: `确认${label}？此操作会写入账单审计记录。`,
        confirmLabel: '确认',
      }))
    )
      return;
    billActionBusy = true;
    try {
      const result = await contractApi.carrierBills[action]({
        params: { id: selectedBill.id },
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: { expected_version: selectedBill.version },
      });
      selectedBill = result.bill;
      bills = bills.map((bill) => (bill.id === result.bill.id ? result.bill : bill));
      notice = { type: 'success', message: `账单已${label}` };
    } catch (error) {
      notice = { type: 'error', message: errorMessage(error, '账单状态更新失败') };
    } finally {
      billActionBusy = false;
    }
  }

  function openRow(row: BalanceRow) {
    const check = row.latestCheck ?? row.balanceCheck;
    if (check) onOpenBalance?.(check);
  }

  async function queryPhone(row: BalanceRow, event: Event | null = null) {
    event?.stopPropagation();
    if (!canQueryBalances || queryingIccid || !isBalanceQueryableRow(row)) return;
    queryingIccid = row.phone.iccid;
    notice = null;
    try {
      const preflight = await contractApi.balanceChecks.preflight({
        query: { phone_iccid: row.phone.iccid },
      });
      if (!preflight.eligible) throw new Error(textOr(preflight.reason, '当前 SIM 暂时不能查询'));
      if (
        (preflight.runner.required && !preflight.runner.available) ||
        preflight.method.interactive
      ) {
        singlePreview = { row, preflight };
      } else {
        await submitSingle(row, false);
      }
    } catch (error) {
      notice = { type: 'error', message: errorMessage(error, '余额查询创建失败') };
    } finally {
      queryingIccid = null;
    }
  }

  async function submitSingle(
    row: BalanceRow | undefined = singlePreview?.row,
    manageLoading = true,
  ) {
    if (!row || (manageLoading && queryingIccid)) return;
    if (manageLoading) queryingIccid = row.phone.iccid;
    notice = null;
    try {
      const { body: result } = await contractApi.balanceChecks.query({
        phone_iccid: row.phone.iccid,
      });
      singlePreview = null;
      notice = {
        type: 'success',
        message: `${formatCardNumber(row.phone.sim_index)} 已加入余额查询队列`,
      };
      fastPollingUntil = Date.now() + 15_000;
      await onQueriesChanged?.({ queuedChecks: [result.check] });
      await loadRunnerStatus();
    } catch (error) {
      notice = { type: 'error', message: errorMessage(error, '余额查询创建失败') };
    } finally {
      if (manageLoading) queryingIccid = null;
    }
  }

  async function openBatchPreview() {
    if (!canQueryBalances || loadingPreview) return;
    const selectedRows = rows.filter((row) => selectedIccidSet.has(row.phone.iccid));
    const scopeRows = (selectedRows.length ? selectedRows : filteredRows).filter(
      isBalanceQueryableRow,
    );
    const phoneIccids = scopeRows.map((row) => row.phone.iccid);
    if (!phoneIccids.length) {
      notice = { type: 'error', message: '当前范围内没有可查询的 SIM' };
      return;
    }
    loadingPreview = true;
    notice = null;
    try {
      batchScope = {
        phoneIccids,
        label: selectedRows.length
          ? `手动选择 ${selectedRows.length} 张卡`
          : filterLabel(scopeRows.length),
      };
      const preview = await contractApi.balanceChecks.preview({ phone_iccids: phoneIccids });
      batchPreview = preview;
      batchMethods = {
        direct_sms: true,
        sms_ai: preview.runner_capabilities.sms_ai.available,
        browser: false,
      };
    } catch (error) {
      batchScope = null;
      notice = { type: 'error', message: errorMessage(error, '无法生成批量查询预览') };
    } finally {
      loadingPreview = false;
    }
  }

  function selectedBatchMethods(): BatchMethod[] {
    return BATCH_METHODS.filter((method) => batchMethods[method]);
  }

  async function submitBatch() {
    const methods = selectedBatchMethods();
    if (
      !canQueryBalances ||
      batchSubmitting ||
      !batchPreview ||
      !batchScope?.phoneIccids.length ||
      methods.length === 0
    )
      return;
    batchSubmitting = true;
    try {
      const { body: result } = await contractApi.balanceChecks.queryBatch({
        methods,
        phone_iccids: batchScope.phoneIccids,
      });
      batchPreview = null;
      batchScope = null;
      selectedIccids = [];
      notice = {
        type: result.summary.failed_to_queue ? 'error' : 'success',
        message: `已加入 ${result.summary.queued} 张卡${result.summary.failed_to_queue ? `，${result.summary.failed_to_queue} 张失败` : ''}`,
      };
      fastPollingUntil = Date.now() + 15_000;
      await onQueriesChanged?.({ queuedChecks: result.checks });
      await loadRunnerStatus();
    } catch (error) {
      notice = { type: 'error', message: errorMessage(error, '批量查询创建失败') };
    } finally {
      batchSubmitting = false;
    }
  }

  function selectedBatchCount(): number {
    if (!batchPreview) return 0;
    const summary = batchPreview.method_summary;
    return selectedBatchMethods().reduce((total, method) => total + summary[method], 0);
  }

  function filterLabel(count: number): string {
    return currentFilterLabel(
      count,
      carrierFilter === 'all'
        ? null
        : (carrierOptions.find((carrier) => carrier.key === carrierFilter)?.label ?? '当前运营商'),
      statusFilter === 'all'
        ? null
        : (filterTabs.find(([value]) => value === statusFilter)?.[1] ?? '当前状态'),
      searchQuery.trim(),
    );
  }

  function toggleCardSelection(iccid: string, checked: boolean) {
    if (checked) selectedIccids = [...new Set([...selectedIccids, iccid])];
    else selectedIccids = selectedIccids.filter((value) => value !== iccid);
  }

  function toggleFilteredSelection(checked: boolean) {
    if (checked) selectedIccids = [...new Set([...selectedIccids, ...filteredIccids])];
    else {
      const visible = new Set(filteredIccids);
      selectedIccids = selectedIccids.filter((iccid) => !visible.has(iccid));
    }
  }

  function closeBatchPreview() {
    batchPreview = null;
    batchScope = null;
  }
</script>

<div class="h-full min-h-0 bg-white lg:bg-transparent lg:px-8 lg:py-6 lg:overflow-hidden">
  <div
    class="w-full bg-white lg:h-full lg:min-h-0 lg:flex lg:flex-col lg:border lg:border-stone-200 lg:rounded-xl lg:shadow-raised overflow-hidden"
  >
    <BalanceHeader
      bind:activeTab
      showBatchButton={canQueryBalances && activeTab === 'overview' && filteredIccids.length > 0}
      {loadingPreview}
      onOpenBills={openBillsTab}
      onBatch={openBatchPreview}
    />

    {#if activeTab !== 'bills'}
      <RunnerStatus
        {runnerStatus}
        loading={runnerStatusLoading}
        onManage={canManageRunners
          ? () => {
              managingRunners = true;
            }
          : undefined}
      />
    {/if}

    <StatusBanners {billAccountsError} bind:notice onRetryAccounts={() => loadBillingAccounts()} />

    {#if activeTab === 'overview'}
      <OverviewFilters
        bind:searchQuery
        bind:statusFilter
        bind:carrierFilter
        {filterTabs}
        {carrierOptions}
        selectedCount={canQueryBalances ? selectedIccids.length : 0}
        onClearSelection={() => {
          selectedIccids = [];
        }}
      />
      <OverviewTable
        rows={groupedRows}
        {canQueryBalances}
        {selectedIccidSet}
        {allFilteredSelected}
        {someFilteredSelected}
        {queryingIccid}
        bind:sortKey={overviewSortKey}
        bind:sortDirection={overviewSortDirection}
        {primaryOf}
        {postpaidPaymentCount}
        hasBillingAccount={(iccid: string) => billingAccountBySim.has(iccid)}
        onToggleCard={toggleCardSelection}
        onToggleAll={toggleFilteredSelection}
        onOpenRow={openRow}
        onOpenBill={openBillFromOverview}
        onQuery={queryPhone}
        onClearFilters={() => {
          statusFilter = 'all';
          carrierFilter = 'all';
          searchQuery = '';
        }}
      />
    {:else if activeTab === 'bills'}
      <BillsTab
        {bills}
        {billsLoading}
        {billsLoaded}
        {billError}
        {billDetailLoading}
        onRefresh={() => loadBills(true)}
        onOpenBill={openBill}
      />
    {:else}
      <HistoryTab
        {balanceChecks}
        {carrierOptions}
        bind:carrierFilter
        bind:sortKey={historySortKey}
        bind:sortDirection={historySortDirection}
        {onOpenBalance}
      />
    {/if}
  </div>
</div>

{#if selectedBill}
  <BillDetailDialog
    bill={selectedBill}
    {canWriteBills}
    actionBusy={billActionBusy}
    onClose={() => {
      selectedBill = null;
    }}
    onAction={recordBillAction}
  />
{/if}

{#if singlePreview}
  <SingleQueryDialog
    row={singlePreview.row}
    preflight={singlePreview.preflight}
    querying={!!queryingIccid}
    onClose={() => {
      singlePreview = null;
    }}
    onSubmit={() => submitSingle()}
  />
{/if}

{#if managingRunners}
  <RunnerAdminDialog
    onClose={() => {
      managingRunners = false;
      void loadRunnerStatus();
    }}
  />
{/if}

{#if batchPreview}
  <BatchQueryDialog
    preview={batchPreview}
    scopeLabel={batchScope?.label}
    bind:methods={batchMethods}
    selectedCount={selectedBatchCount()}
    submitting={batchSubmitting}
    onClose={closeBatchPreview}
    onDismiss={() => {
      batchPreview = null;
    }}
    onSubmit={submitBatch}
  />
{/if}
