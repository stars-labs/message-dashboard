<script>
  import { onMount } from 'svelte';
  import { formatCardNumber } from './card-number.js';
  import { buildCarrierOptions, carrierKey } from './carrier.js';
  import { getCountryFlag } from './countries.js';
  import { api } from './api.js';
  import { getSimServiceTypeLabel } from './sim-service-type.js';
  import { getSimRoleLabel } from './sim-role.js';
  import { groupByPrimary } from './group-by-primary.js';
  import {
    formatBalanceMetric,
    getBalanceStatusMeta,
    getBalanceTimestamp,
    normalizeUtcTimestamp,
  } from './balance-query.js';
  import {
    BALANCE_HEALTH_META,
    buildBalanceRows,
    countBalanceHealth,
  } from './balance-overview.js';

  let {
    phoneNumbers = [],
    balanceChecks = [],
    onOpenBalance = null,
    canQueryBalances = false,
    canWriteBills = false,
    onQueriesChanged = null,
  } = $props();

  let activeTab = $state('overview');
  let statusFilter = $state('all');
  let carrierFilter = $state('all');
  let searchQuery = $state('');
  let overviewSortKey = $state(null);
  let overviewSortDirection = $state('asc');
  let historySortKey = $state('time');
  let historySortDirection = $state('desc');
  let queryingIccid = $state(null);
  let loadingPreview = $state(false);
  let batchSubmitting = $state(false);
  let batchPreview = $state(null);
  let batchMethods = $state({ direct_sms: true, sms_ai: false, browser: false });
  let batchScope = $state(null);
  let selectedIccids = $state([]);
  let singlePreview = $state(null);
  let notice = $state(null);
  let runnerStatus = $state(null);
  let runnerStatusLoading = $state(true);
  let billAccounts = $state([]);
  let bills = $state([]);
  let billsLoaded = $state(false);
  let billsLoading = $state(false);
  let billError = $state(null);
  let selectedBill = $state(null);
  let billDetailLoading = $state(false);
  let billActionBusy = $state(false);

  let rows = $derived(buildBalanceRows(phoneNumbers, balanceChecks));
  let carrierOptions = $derived.by(() => buildCarrierOptions([
    ...rows.map((row) => ({
      carrier: row.phone.carrier,
      country: row.phone.country,
    })),
    ...(balanceChecks || []).map((check) => ({
      carrier: check.profile_carrier || check.sim_carrier,
      country: check.sim_country || check.country_code,
    })),
  ]));
  let carrierRows = $derived(rows.filter((row) => carrierFilter === 'all'
    || carrierKey({ carrier: row.phone.carrier, country: row.phone.country }) === carrierFilter));
  let counts = $derived(countBalanceHealth(carrierRows));
  // Counts live on the filter tabs (device-page pattern) instead of a separate summary bar.
  let filterTabs = $derived([
    ['all', '全部', carrierRows.length],
    ['healthy', '正常', counts.healthy],
    ['recharge', '需充值', counts.zero_or_negative_balance + counts.low_balance],
    ['expiry', '到期处理', counts.expired + counts.expiring_soon],
    ['verification_pending', '待验证', counts.verification_pending],
    ['stale', '数据过期', counts.stale],
    ['query_failed', '查询失败', counts.query_failed],
    ['missing', '未取得', counts.never_observed + counts.expiry_unknown],
    ['not_applicable', '后付费', counts.not_applicable],
  ]);

  function matchesStatusFilter(row) {
    if (statusFilter === 'all') return true;
    if (statusFilter === 'recharge') {
      return ['zero_or_negative_balance', 'low_balance'].includes(row.health);
    }
    if (statusFilter === 'expiry') return ['expired', 'expiring_soon'].includes(row.health);
    if (statusFilter === 'missing') return ['never_observed', 'expiry_unknown'].includes(row.health);
    return row.health === statusFilter;
  }

  let filteredRows = $derived.by(() => {
    const query = searchQuery.trim().toLowerCase();
    return carrierRows
      .filter(matchesStatusFilter)
      .filter((row) => {
        if (!query) return true;
        const phone = row.phone;
        return [
          formatCardNumber(phone.sim_index),
          phone.number,
          phone.phone_number,
          phone.iccid,
          phone.carrier,
          getSimServiceTypeLabel(phone.service_type),
        ].some((value) => String(value || '').toLowerCase().includes(query));
      })
      .sort(compareOverviewRows);
  });
  // Re-order the filtered rows so each secondary sits under its primary, with
  // a depth marker for indentation. Applied after filtering so a carrier or
  // status filter that excludes the primary renders an orphan secondary at
  // depth 0 rather than hiding it.
  let groupedRows = $derived(groupByPrimary(filteredRows, (row) => row.phone));
  // Map of primary_iccid -> its row, for the "余额随主卡 → NN" pointer on
  // secondary rows. Built from filteredRows (pre-grouping) so the primary is
  // found even though grouping re-orders rows. Absent when the primary has
  // been filtered out (orphan secondary).
  let primaryRowByIccid = $derived.by(() => {
    const map = new Map();
    for (const row of filteredRows) {
      if (row.phone.sim_role === 'primary') map.set(row.phone.iccid, row);
    }
    return map;
  });
  // Resolve the primary row for a secondary; null if orphaned.
  function primaryOf(row) {
    const iccid = row.phone.primary_iccid;
    return iccid ? primaryRowByIccid.get(iccid) ?? null : null;
  }
  function isBalanceQueryableRow(row) {
    return row.phone.sim_role !== 'secondary' && row.phone.service_type !== 'postpaid';
  }
  let selectedIccidSet = $derived(new Set(selectedIccids));
  let filteredIccids = $derived(filteredRows
    .filter(isBalanceQueryableRow)
    .map((row) => row.phone.iccid));
  let allFilteredSelected = $derived(filteredIccids.length > 0
    && filteredIccids.every((iccid) => selectedIccidSet.has(iccid)));
  let someFilteredSelected = $derived(filteredIccids.some((iccid) => selectedIccidSet.has(iccid)));
  let sortedChecks = $derived((balanceChecks || [])
    .filter((check) => carrierFilter === 'all'
      || carrierKey({
        carrier: check.profile_carrier || check.sim_carrier,
        country: check.sim_country || check.country_code,
      }) === carrierFilter)
    .slice()
    .sort(compareHistoryChecks));
  let latestUpdate = $derived(
    rows
      .map((row) => row.balanceTimestamp)
      .filter(Boolean)
      .sort((a, b) => new Date(normalizeUtcTimestamp(b)) - new Date(normalizeUtcTimestamp(a)))[0] || null
  );
  let billingAccountBySim = $derived.by(() => {
    const map = new Map();
    for (const account of billAccounts) {
      for (const sim of account.linked_sims || []) map.set(sim.iccid, account);
    }
    return map;
  });

  const overviewColumns = [
    { key: 'sim', label: 'SIM' },
    { key: 'carrier', label: '运营商' },
    { key: 'sim_role', label: '主副卡' },
    { key: 'service_type', label: '计费类型' },
    { key: 'balance', label: '当前余额' },
    { key: 'expiry', label: '有效期' },
    { key: 'health', label: '状态' },
    { key: 'threshold', label: '阈值' },
    { key: 'updated', label: '最近更新' },
    { key: 'query', label: '最近查询' },
    { key: null, label: '操作' },
  ];

  const historyColumns = [
    { key: 'time', label: '时间' },
    { key: 'sim', label: 'SIM' },
    { key: 'carrier', label: '运营商' },
    { key: 'method', label: '查询方式' },
    { key: 'status', label: '结果' },
    { key: 'balance', label: '当前余额' },
    { key: null, label: '操作' },
  ];

  const capabilityLabels = {
    sms_ai: 'AI 短信',
    carrier_browser: '浏览器查询',
  };

  function capabilityPresentation(capability) {
    if (runnerStatusLoading) return { label: '检测中', dot: 'bg-stone-300', text: 'text-stone-400' };
    if (!capability || capability.state === 'offline') {
      return { label: '未运行', dot: 'bg-stone-300', text: 'text-stone-500' };
    }
    if (capability.state === 'degraded') {
      return { label: '连接异常', dot: 'bg-amber-500', text: 'text-amber-700' };
    }
    if (capability.state === 'configuration_required') {
      return { label: '需要配置', dot: 'bg-amber-500', text: 'text-amber-700' };
    }
    if (capability.state === 'busy') {
      return {
        label: capability.detail_code === 'human_verification_required' ? '需要人工验证' : '查询中',
        dot: capability.detail_code === 'human_verification_required' ? 'bg-orange-500' : 'bg-emerald-500',
        text: capability.detail_code === 'human_verification_required' ? 'text-orange-700' : 'text-emerald-700',
      };
    }
    if (capability.available) return { label: '已就绪', dot: 'bg-emerald-500', text: 'text-emerald-700' };
    return { label: '未运行', dot: 'bg-stone-300', text: 'text-stone-500' };
  }

  async function loadRunnerStatus() {
    try {
      runnerStatus = await api.get('/api/balance-runners');
    } catch {
      runnerStatus = null;
    } finally {
      runnerStatusLoading = false;
    }
  }

  onMount(() => {
    loadRunnerStatus();
    if (phoneNumbers.some((phone) => phone.service_type === 'postpaid')) loadBillingAccounts();
    const interval = setInterval(loadRunnerStatus, 30_000);
    return () => clearInterval(interval);
  });

  async function loadBillingAccounts() {
    try {
      const result = await api.get('/api/carrier-billing/accounts');
      billAccounts = result.accounts || [];
    } catch {
      billAccounts = [];
    }
  }

  async function loadBills(force = false) {
    if (billsLoading || (billsLoaded && !force)) return;
    billsLoading = true;
    billError = null;
    try {
      const [billResult, accountResult] = await Promise.all([
        api.get('/api/carrier-bills'),
        api.get('/api/carrier-billing/accounts'),
      ]);
      bills = billResult.bills || [];
      billAccounts = accountResult.accounts || [];
      billsLoaded = true;
    } catch (error) {
      billError = error.message || '账单加载失败';
    } finally {
      billsLoading = false;
    }
  }

  function openBillsTab() {
    activeTab = 'bills';
    loadBills();
  }

  async function openBill(bill) {
    billDetailLoading = true;
    try {
      const result = await api.get(`/api/carrier-bills/${encodeURIComponent(bill.id)}`);
      selectedBill = result.bill;
    } catch (error) {
      notice = { type: 'error', message: error.message || '账单详情加载失败' };
    } finally {
      billDetailLoading = false;
    }
  }

  async function recordBillAction(action, label) {
    if (!selectedBill || billActionBusy || !canWriteBills) return;
    if (!window.confirm(`确认${label}？此操作会写入账单审计记录。`)) return;
    billActionBusy = true;
    try {
      const result = await api.post(
        `/api/carrier-bills/${encodeURIComponent(selectedBill.id)}/${action}`,
        { expected_version: selectedBill.version },
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
      );
      selectedBill = result.bill;
      bills = bills.map((bill) => bill.id === result.bill.id ? result.bill : bill);
      notice = { type: 'success', message: `账单已${label}` };
    } catch (error) {
      notice = { type: 'error', message: error.message || '账单状态更新失败' };
    } finally {
      billActionBusy = false;
    }
  }

  function formatBillAmount(bill) {
    return `${bill.currency} ${(Number(bill.amount_minor || 0) / 100).toFixed(2)}`;
  }

  function billUrgencyMeta(bill) {
    return ({
      needs_review: { label: '需要复核', className: 'bg-red-50 text-red-700 border-red-200' },
      overdue: { label: `逾期 ${Math.abs(bill.days_remaining)} 天`, className: 'bg-red-50 text-red-700 border-red-200' },
      due_soon: { label: bill.days_remaining === 0 ? '今天到期' : `${bill.days_remaining} 天后到期`, className: 'bg-amber-50 text-amber-700 border-amber-200' },
      open: { label: `${bill.days_remaining} 天后到期`, className: 'bg-stone-50 text-stone-600 border-stone-200' },
      paid: { label: '已付款', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
      waived: { label: '已豁免', className: 'bg-stone-50 text-stone-500 border-stone-200' },
    })[bill.urgency] || { label: bill.action_status || '待处理', className: 'bg-stone-50 text-stone-600 border-stone-200' };
  }

  function billActionLabel(status) {
    return ({
      unpaid: '待付款',
      payment_planned: '已计划付款',
      paid: '已付款',
      waived: '已豁免',
      needs_review: '需要复核',
    })[status] || status;
  }

  function billEventLabel(type) {
    return ({
      detected: '检测到账单',
      duplicate_detected: '检测到重复通知',
      parse_conflict: '金额冲突',
      payment_planned: '计划付款',
      paid: '标记已付款',
      waived: '标记豁免',
      reopened: '重新打开',
    })[type] || type;
  }

  function compareValues(left, right) {
    const leftMissing = left == null || left === '' || Number.isNaN(left);
    const rightMissing = right == null || right === '' || Number.isNaN(right);
    if (leftMissing || rightMissing) {
      if (leftMissing && rightMissing) return 0;
      return leftMissing ? 1 : -1;
    }
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right), 'zh-CN', { numeric: true, sensitivity: 'base' });
  }

  function compareMoney(leftMetric, rightMetric) {
    const currency = compareValues(leftMetric?.currency, rightMetric?.currency);
    return currency || compareValues(Number(leftMetric?.value), Number(rightMetric?.value));
  }

  function overviewValue(row, key) {
    if (key === 'sim') return Number(row.phone.sim_index);
    if (key === 'carrier') return row.phone.carrier || '';
    if (key === 'service_type') return getSimServiceTypeLabel(row.phone.service_type);
    if (key === 'health') return healthOrder(row.health);
    if (key === 'expiry') return row.expiryDate || null;
    if (key === 'updated') return row.balanceTimestamp ? new Date(normalizeUtcTimestamp(row.balanceTimestamp)).getTime() : null;
    if (key === 'query') return row.latestCheck?.status || '';
    return null;
  }

  function compareOverviewRows(left, right) {
    if (!overviewSortKey) {
      return healthOrder(left.health) - healthOrder(right.health)
        || Number(left.phone.sim_index || 999) - Number(right.phone.sim_index || 999);
    }
    let comparison;
    if (overviewSortKey === 'balance') comparison = compareMoney(left.balanceMetric, right.balanceMetric);
    else if (overviewSortKey === 'threshold') {
      comparison = compareValues(left.threshold?.currency, right.threshold?.currency)
        || compareValues(left.threshold?.value, right.threshold?.value);
    } else comparison = compareValues(overviewValue(left, overviewSortKey), overviewValue(right, overviewSortKey));
    if (comparison === 0) comparison = Number(left.phone.sim_index || 999) - Number(right.phone.sim_index || 999);
    return overviewSortDirection === 'asc' ? comparison : -comparison;
  }

  function healthOrder(status) {
    return ({
      expired: 0,
      zero_or_negative_balance: 1,
      query_failed: 2,
      verification_pending: 3,
      stale: 4,
      low_balance: 5,
      expiring_soon: 6,
      never_observed: 7,
      expiry_unknown: 8,
      not_applicable: 9,
      healthy: 10,
    })[status] ?? 99;
  }

  function historyValue(check, key) {
    if (key === 'time') return timestampValue(check);
    if (key === 'sim') return Number(check.sim_index);
    if (key === 'carrier') return check.profile_carrier || check.sim_carrier || '';
    if (key === 'method') return check.method || '';
    if (key === 'status') return check.status || '';
    return null;
  }

  function compareHistoryChecks(left, right) {
    let comparison;
    if (historySortKey === 'balance') {
      comparison = compareMoney(
        left.metrics?.find((metric) => metric.metric_type === 'cash_balance'),
        right.metrics?.find((metric) => metric.metric_type === 'cash_balance'),
      );
    } else comparison = compareValues(historyValue(left, historySortKey), historyValue(right, historySortKey));
    if (comparison === 0) comparison = String(left.id).localeCompare(String(right.id));
    return historySortDirection === 'asc' ? comparison : -comparison;
  }

  function toggleOverviewSort(key) {
    if (overviewSortKey === key) overviewSortDirection = overviewSortDirection === 'asc' ? 'desc' : 'asc';
    else {
      overviewSortKey = key;
      overviewSortDirection = 'asc';
    }
  }

  function toggleHistorySort(key) {
    if (historySortKey === key) historySortDirection = historySortDirection === 'asc' ? 'desc' : 'asc';
    else {
      historySortKey = key;
      historySortDirection = key === 'time' ? 'desc' : 'asc';
    }
  }

  function timestampValue(check) {
    const value = getBalanceTimestamp(check);
    const time = value ? new Date(normalizeUtcTimestamp(value)).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
  }

  function formatTime(value, compact = false) {
    if (!value) return '—';
    const date = new Date(normalizeUtcTimestamp(value));
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit', day: '2-digit',
      ...(compact ? {} : { year: 'numeric' }),
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });
  }

  function formatThreshold(threshold) {
    if (!threshold) return '—';
    return `${threshold.value} ${threshold.currency}`;
  }

  function openRow(row) {
    const check = row.latestCheck || row.balanceCheck;
    if (check) onOpenBalance?.(check);
  }

  async function queryPhone(row, event = null) {
    event?.stopPropagation();
    if (!canQueryBalances || queryingIccid || !isBalanceQueryableRow(row)) return;
    queryingIccid = row.phone.iccid;
    notice = null;
    try {
      const preflight = await api.get(
        `/api/balance-checks/query-preflight?phone_iccid=${encodeURIComponent(row.phone.iccid)}`,
      );
      if (!preflight.eligible) throw new Error(preflight.reason || '当前 SIM 暂时不能查询');
      if ((preflight.runner?.required && !preflight.runner.available)
        || preflight.method?.interactive) {
        singlePreview = { row, preflight };
      } else {
        await submitSingle(row, false);
      }
    } catch (error) {
      notice = { type: 'error', message: error.message || '余额查询创建失败' };
    } finally {
      queryingIccid = null;
    }
  }

  async function submitSingle(row = singlePreview?.row, manageLoading = true) {
    if (!row || (manageLoading && queryingIccid)) return;
    if (manageLoading) queryingIccid = row.phone.iccid;
    notice = null;
    try {
      await api.post('/api/balance-checks/query', { phone_iccid: row.phone.iccid });
      singlePreview = null;
      notice = { type: 'success', message: `${formatCardNumber(row.phone.sim_index)} 已加入余额查询队列` };
      await onQueriesChanged?.();
    } catch (error) {
      notice = { type: 'error', message: error.message || '余额查询创建失败' };
    } finally {
      if (manageLoading) queryingIccid = null;
    }
  }

  async function openBatchPreview() {
    if (!canQueryBalances || loadingPreview) return;
    const selectedRows = rows.filter((row) => selectedIccidSet.has(row.phone.iccid));
    const scopeRows = (selectedRows.length ? selectedRows : filteredRows)
      .filter(isBalanceQueryableRow);
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
          : currentFilterLabel(scopeRows.length),
      };
      batchPreview = await api.post('/api/balance-checks/query-preview', {
        phone_iccids: phoneIccids,
      });
      batchMethods = {
        direct_sms: true,
        sms_ai: Boolean(batchPreview.runner_capabilities?.sms_ai?.available),
        browser: false,
      };
    } catch (error) {
      batchScope = null;
      notice = { type: 'error', message: error.message || '无法生成批量查询预览' };
    } finally {
      loadingPreview = false;
    }
  }

  async function submitBatch() {
    const methods = Object.entries(batchMethods).filter(([, selected]) => selected).map(([method]) => method);
    if (!canQueryBalances || batchSubmitting || !batchPreview
      || !batchScope?.phoneIccids?.length || methods.length === 0) return;
    batchSubmitting = true;
    try {
      const result = await api.post('/api/balance-checks/query-batch', {
        methods,
        phone_iccids: batchScope.phoneIccids,
      });
      batchPreview = null;
      batchScope = null;
      selectedIccids = [];
      notice = {
        type: result.summary?.failed_to_queue ? 'error' : 'success',
        message: `已加入 ${result.summary?.queued || 0} 张卡${result.summary?.failed_to_queue ? `，${result.summary.failed_to_queue} 张失败` : ''}`,
      };
      await onQueriesChanged?.();
    } catch (error) {
      notice = { type: 'error', message: error.message || '批量查询创建失败' };
    } finally {
      batchSubmitting = false;
    }
  }

  function selectedBatchCount() {
    if (!batchPreview?.method_summary) return 0;
    return Object.entries(batchMethods)
      .filter(([, selected]) => selected)
      .reduce((total, [method]) => total + Number(batchPreview.method_summary[method] || 0), 0);
  }

  function currentFilterLabel(count) {
    const parts = [];
    if (carrierFilter !== 'all') {
      parts.push(carrierOptions.find((carrier) => carrier.key === carrierFilter)?.label || '当前运营商');
    }
    if (statusFilter !== 'all') {
      parts.push(filterTabs.find(([value]) => value === statusFilter)?.[1] || '当前状态');
    }
    if (searchQuery.trim()) parts.push(`搜索“${searchQuery.trim()}”`);
    return `${parts.length ? `当前筛选：${parts.join(' · ')}` : '当前全部卡片'}（${count} 张）`;
  }

  function toggleCardSelection(iccid, checked) {
    if (checked) selectedIccids = [...new Set([...selectedIccids, iccid])];
    else selectedIccids = selectedIccids.filter((value) => value !== iccid);
  }

  function toggleFilteredSelection(checked) {
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
  <div class="w-full bg-white lg:h-full lg:min-h-0 lg:flex lg:flex-col lg:border lg:border-stone-200 lg:rounded-xl lg:shadow-raised overflow-hidden">
    <header class="px-4 py-3 lg:px-6 lg:py-5 border-b border-stone-100 lg:flex-none">
      <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2.5 sm:gap-4">
        <div class="flex items-baseline justify-between gap-3 sm:block">
          <h2 class="text-lg lg:text-xl font-bold text-stone-900 shrink-0">余额管理</h2>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <div class="inline-flex flex-1 sm:flex-none items-center bg-stone-100 rounded-lg p-0.5 text-xs">
            <button
              type="button"
              onclick={() => { activeTab = 'overview'; }}
              class="flex-1 sm:flex-none px-3 py-1.5 rounded-md transition-all {activeTab === 'overview'
                ? 'bg-white shadow-sm font-semibold text-stone-800'
                : 'text-stone-500'}"
            >余额概览</button>
            <button
              type="button"
              onclick={openBillsTab}
              class="flex-1 sm:flex-none px-3 py-1.5 rounded-md transition-all {activeTab === 'bills'
                ? 'bg-white shadow-sm font-semibold text-stone-800'
                : 'text-stone-500'}"
            >后付费账单</button>
            <button
              type="button"
              onclick={() => { activeTab = 'history'; }}
              class="flex-1 sm:flex-none px-3 py-1.5 rounded-md transition-all {activeTab === 'history'
                ? 'bg-white shadow-sm font-semibold text-stone-800'
                : 'text-stone-500'}"
            >查询记录</button>
          </div>
          {#if canQueryBalances && activeTab === 'overview' && filteredIccids.length}
            <button type="button" onclick={openBatchPreview} disabled={loadingPreview}
              class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-orange-500 hover:bg-orange-600
                disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M4 12h16M4 17h10"/>
              </svg>
              {loadingPreview ? '计算中' : '批量查询'}
            </button>
          {/if}
        </div>
      </div>
    </header>

    {#if activeTab !== 'bills'}
    <section class="px-4 py-2.5 lg:px-6 border-b border-stone-100 bg-stone-50/60 flex flex-wrap items-center gap-x-4 gap-y-2 lg:flex-none" aria-label="余额查询助手状态">
      <span class="text-xs font-semibold text-stone-700">查询助手</span>
      {#each Object.entries(capabilityLabels) as [name, label]}
        {@const capability = runnerStatus?.capabilities?.[name]}
        {@const presentation = capabilityPresentation(capability)}
        <span class="inline-flex items-center gap-1.5 text-xs {presentation.text}" title={capability?.detail_code || ''}>
          <span class="w-1.5 h-1.5 rounded-full {presentation.dot}" aria-hidden="true"></span>
          <span class="text-stone-500">{label}</span>
          <strong class="font-medium">{presentation.label}</strong>
        </span>
      {/each}
      <span class="text-[11px] text-stone-400 sm:ml-auto">浏览器任务逐张处理</span>
    </section>
    {/if}

    {#if notice}
      <div class="px-4 lg:px-5 py-2.5 border-b text-sm flex items-center justify-between gap-3 lg:flex-none
        {notice.type === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-red-50 text-red-700 border-red-100'}">
        <span>{notice.message}</span>
        <button type="button" onclick={() => { notice = null; }} aria-label="关闭提示" class="text-current opacity-60 hover:opacity-100">&times;</button>
      </div>
    {/if}

    {#if activeTab === 'overview'}
      <!-- Toolbar: [filter tabs with counts] | [carrier] [search] — one line -->
      <div class="px-4 py-2.5 lg:px-5 border-b border-stone-100 flex items-center gap-2 overflow-x-auto lg:flex-none">
        <div class="flex items-center gap-2 min-w-max shrink-0">
          <!-- filter tabs; count follows the label, same as the device page -->
          {#each filterTabs as [value, label, count]}
            <button
              type="button"
              onclick={() => { statusFilter = value; }}
              class="shrink-0 px-2.5 py-1.5 text-sm rounded-lg font-medium transition-colors tabular-nums
                {statusFilter === value
                  ? value === 'recharge' || value === 'query_failed' || value === 'expiry'
                    ? 'bg-red-600 text-white'
                    : 'bg-stone-800 text-white'
                  : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}"
            >{label} {count}</button>
          {/each}
          <span class="w-px h-5 bg-stone-200 mx-1 shrink-0"></span>
          <!-- carrier select -->
          <label class="sr-only" for="balance-carrier-filter">运营商筛选</label>
          <select
            id="balance-carrier-filter"
            value={carrierFilter}
            onchange={(event) => { carrierFilter = event.currentTarget.value; }}
            aria-label="运营商筛选"
            class="shrink-0 w-[130px] px-2.5 py-1.5 text-sm bg-stone-50 border border-stone-200 rounded-lg
              focus:outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
          >
            <option value="all">全部运营商</option>
            {#each carrierOptions as carrier}
              <option value={carrier.key}>{carrier.label}</option>
            {/each}
          </select>
          <!-- search -->
          <div class="relative w-[220px]">
            <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke-width="2" stroke-linecap="round"/>
            </svg>
            <input
              bind:value={searchQuery}
              type="search"
              aria-label="搜索 SIM"
              placeholder="卡号 / 手机号 / ICCID"
              class="w-full pl-9 pr-3 py-1.5 text-sm bg-stone-50 border border-stone-200 rounded-lg
                focus:outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
            />
          </div>
        </div>
      </div>

      {#if canQueryBalances && selectedIccids.length}
        <div class="px-4 py-2 lg:px-5 border-b border-orange-100 bg-orange-50 flex items-center gap-3 text-xs lg:flex-none">
          <strong class="text-orange-800">已选 {selectedIccids.length} 张</strong>
          <span class="text-orange-600">批量查询将仅处理已选卡</span>
          <button type="button" onclick={() => { selectedIccids = []; }} class="ml-auto font-medium text-orange-700 hover:underline">清空选择</button>
        </div>
      {/if}

      {#if filteredRows.length === 0}
        <div class="py-16 text-center">
          <p class="text-sm text-stone-400">没有匹配的 SIM</p>
          <button type="button" onclick={() => { statusFilter = 'all'; carrierFilter = 'all'; searchQuery = ''; }} class="mt-2 text-xs text-action-text hover:underline">清除筛选</button>
        </div>
      {:else}
        <div class="hidden lg:block lg:flex-1 lg:min-h-0 lg:overflow-auto" data-desktop-balance-scroll>
          <table class="w-full text-sm">
            <thead class="sticky top-0 z-10 bg-stone-50">
              <tr class="bg-stone-50 border-b border-stone-200">
                {#if canQueryBalances}
                  <th class="w-12 px-4 py-2.5 text-left">
                    <input type="checkbox" checked={allFilteredSelected}
                      aria-checked={someFilteredSelected && !allFilteredSelected ? 'mixed' : allFilteredSelected}
                      aria-label="选择当前筛选结果"
                      onchange={(event) => toggleFilteredSelection(event.currentTarget.checked)}
                      class="rounded border-stone-300 text-orange-500 focus:ring-orange-400">
                  </th>
                {/if}
                {#each overviewColumns as column, index}
                  <th class="px-4 py-2.5 text-left text-[11px] font-semibold text-stone-400 tracking-widest uppercase {index === overviewColumns.length - 1 ? 'text-right' : ''}">
                    {#if column.key}
                      <button type="button" onclick={() => toggleOverviewSort(column.key)}
                        class="inline-flex items-center gap-1 hover:text-stone-700 transition-colors"
                        aria-label={`按${column.label}${overviewSortKey === column.key && overviewSortDirection === 'asc' ? '降序' : '升序'}排列`}>
                        {column.label}
                        <span class="text-[9px] {overviewSortKey === column.key ? 'text-orange-500' : 'text-stone-300'}" aria-hidden="true">
                          {overviewSortKey === column.key ? (overviewSortDirection === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    {:else}{column.label}{/if}
                  </th>
                {/each}
              </tr>
            </thead>
            <tbody class="divide-y divide-stone-50">
              {#each groupedRows as row}
                <tr class="hover:bg-stone-50 transition-colors {row.__isSecondary ? 'bg-stone-50/60' : ''}">
                  {#if canQueryBalances}
                    <td class="w-12 px-4 py-3" style="padding-left: {row.__depth * 1.25 + 1}rem">
                      <input type="checkbox" checked={selectedIccidSet.has(row.phone.iccid)}
                        disabled={row.phone.sim_role === 'secondary' || row.phone.service_type === 'postpaid'}
                        aria-label={`选择 ${formatCardNumber(row.phone.sim_index)}`}
                        onchange={(event) => toggleCardSelection(row.phone.iccid, event.currentTarget.checked)}
                        class="rounded border-stone-300 text-orange-500 focus:ring-orange-400 disabled:opacity-40">
                    </td>
                  {/if}
                  <td class="px-4 py-3 min-w-[180px]">
                    <div class="flex items-baseline gap-2">
                      <span class="font-mono font-bold text-stone-900">{formatCardNumber(row.phone.sim_index)}</span>
                      <span class="font-mono text-xs text-stone-600">{row.phone.number || row.phone.phone_number || '未设置号码'}</span>
                    </div>
                    <div class="mt-0.5 font-mono text-[10px] text-stone-400">{row.phone.iccid}</div>
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap text-stone-600">
                    <span class="mr-1">{row.phone.flag || getCountryFlag(row.phone.country)}</span>{row.phone.carrier || '—'}
                  </td>
                  <!-- 主副卡 -->
                  <td class="px-4 py-3 whitespace-nowrap">
                    {#if row.phone.sim_role === 'secondary'}
                      {@const primary = primaryOf(row)}
                      <span class="inline-flex px-1.5 py-0.5 rounded border text-[10px] bg-violet-50 text-violet-700 border-violet-200"
                        title={primary ? `余额随主卡 → ${formatCardNumber(primary.phone.sim_index)}` : '副卡'}>
                        副卡{primary ? ` → ${formatCardNumber(primary.phone.sim_index)}` : ''}
                      </span>
                    {:else if row.phone.sim_role === 'primary'}
                      <span class="inline-flex px-1.5 py-0.5 rounded border text-[10px] bg-blue-50 text-blue-700 border-blue-200">主卡</span>
                    {:else}
                      <span class="text-stone-300">—</span>
                    {/if}
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap">
                    <span class="inline-flex px-2 py-0.5 rounded-md border text-[11px]
                      {row.phone.service_type === 'prepaid' || row.phone.service_type === 'postpaid'
                        ? 'bg-stone-50 text-stone-700 border-stone-200'
                        : row.phone.service_type === 'balance_managed'
                          ? 'bg-stone-50 text-stone-400 border-stone-200'
                          : 'bg-amber-50 text-amber-700 border-amber-200'}">
                      {getSimServiceTypeLabel(row.phone.service_type)}
                    </span>
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap font-semibold tabular-nums {['low_balance', 'zero_or_negative_balance'].includes(row.health) ? 'text-red-700' : 'text-stone-900'}">
                    {#if row.__isSecondary}
                      <span class="text-xs font-normal text-stone-400">余额随主卡</span>
                    {:else if row.phone.service_type === 'postpaid'}
                      <span class="flex flex-col gap-0.5 text-xs font-normal">
                        <span class="text-stone-400">不按余额管理</span>
                        <span class={billingAccountBySim.has(row.phone.iccid) ? 'text-emerald-700' : 'text-amber-700'}>
                          {billingAccountBySim.has(row.phone.iccid) ? '已收到过账单短信' : '等待账单短信'}
                        </span>
                      </span>
                    {:else}
                      {formatBalanceMetric(row.balanceMetric)}
                    {/if}
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap font-mono text-xs text-stone-500">
                    {row.__isSecondary ? '—' : row.expiryDate || '—'}
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap">
                    {#if row.__isSecondary}
                      <span class="text-stone-300">—</span>
                    {:else}
                      <span class="flex flex-wrap items-center gap-1 max-w-[190px]">
                        <span class="inline-flex px-2 py-0.5 rounded-md border text-[11px] font-medium {row.healthMeta.className}">{row.healthMeta.label}</span>
                        {#each row.healthReasons.filter((reason) => reason !== row.health && BALANCE_HEALTH_META[reason]) as reason}
                          <span class="inline-flex px-1.5 py-0.5 rounded border text-[10px] font-medium {BALANCE_HEALTH_META[reason].className}">{BALANCE_HEALTH_META[reason].label}</span>
                        {/each}
                      </span>
                    {/if}
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap font-mono text-xs text-stone-500">
                    {row.__isSecondary ? '—' : formatThreshold(row.threshold)}
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap font-mono text-xs text-stone-500">
                    {row.__isSecondary ? '—' : formatTime(row.balanceTimestamp, true)}
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap">
                    {#if row.__isSecondary}
                      <span class="text-stone-300">—</span>
                    {:else if row.latestCheck}
                      {@const queryMeta = getBalanceStatusMeta(row.latestCheck.display_status || row.latestCheck.status)}
                      <span class="text-xs text-stone-600">{queryMeta.label}</span>
                      <span class="ml-1 text-[10px] uppercase text-stone-400">{row.latestCheck.method || ''}</span>
                    {:else}
                      <span class="text-stone-300">—</span>
                    {/if}
                  </td>
                  <td class="px-4 py-3 text-right">
                    <div class="flex items-center justify-end gap-3">
                      {#if row.latestCheck || row.balanceCheck}
                        <button type="button" onclick={() => openRow(row)} class="text-xs font-medium text-stone-500 hover:text-stone-800">查看</button>
                      {/if}
                      {#if canQueryBalances && row.phone.service_type !== 'postpaid'}
                        <button type="button" onclick={(event) => queryPhone(row, event)}
                          disabled={!!queryingIccid || row.phone.sim_role === 'secondary'}
                          title={row.phone.sim_role === 'secondary' ? '副卡,余额随主卡查询' : ''}
                          class="text-xs font-semibold text-action-text hover:underline disabled:text-stone-300 disabled:no-underline">
                          {queryingIccid === row.phone.iccid ? '排队中…' : '查询'}
                        </button>
                      {:else if !row.latestCheck && !row.balanceCheck}
                        <span class="text-stone-300">—</span>
                      {/if}
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <div class="lg:hidden divide-y divide-stone-100" data-mobile-balance-list>
          {#each groupedRows as row}
            <div class="w-full px-4 py-2.5 text-left bg-white {row.__isSecondary ? 'bg-stone-50/60' : ''}"
                 style="padding-left: {row.__depth * 1 + 1}rem"
                 data-mobile-balance-row>
              <div class="flex items-center gap-2 min-w-0">
                {#if canQueryBalances}
                  <input type="checkbox" checked={selectedIccidSet.has(row.phone.iccid)}
                    disabled={row.phone.sim_role === 'secondary' || row.phone.service_type === 'postpaid'}
                    aria-label={`选择 ${formatCardNumber(row.phone.sim_index)}（移动端）`}
                    onchange={(event) => toggleCardSelection(row.phone.iccid, event.currentTarget.checked)}
                    class="rounded border-stone-300 text-orange-500 focus:ring-orange-400 shrink-0 disabled:opacity-40">
                {/if}
                <button type="button" onclick={() => openRow(row)} disabled={!row.latestCheck && !row.balanceCheck}
                  class="flex items-center gap-2 min-w-0 text-left disabled:cursor-default">
                  <span class="font-mono font-bold text-sm text-stone-900 shrink-0">{formatCardNumber(row.phone.sim_index)}</span>
                  <span class="font-mono text-xs text-stone-600 truncate">{row.phone.number || row.phone.phone_number || '未设置号码'}</span>
                </button>
                {#if row.__isSecondary}
                  <span class="ml-auto inline-flex px-1.5 py-0.5 rounded border text-[10px] font-medium shrink-0 bg-violet-50 text-violet-700 border-violet-200">副卡</span>
                {:else}
                  <span class="ml-auto flex items-center gap-1 shrink-0">
                    <span class="inline-flex px-2 py-0.5 rounded-md border text-[10px] font-medium {row.healthMeta.className}">{row.healthMeta.label}</span>
                    {#each row.healthReasons.filter((reason) => reason !== row.health && BALANCE_HEALTH_META[reason]) as reason}
                      <span class="inline-flex px-1.5 py-0.5 rounded border text-[9px] font-medium {BALANCE_HEALTH_META[reason].className}">{BALANCE_HEALTH_META[reason].label}</span>
                    {/each}
                  </span>
                {/if}
              </div>
              <div class="mt-1.5 flex items-center gap-2 min-w-0">
                <div class="min-w-0 flex-1 flex items-baseline gap-2">
                  {#if row.__isSecondary}
                    {@const primary = primaryOf(row)}
                    <span class="text-sm text-stone-400">
                      {primary
                        ? `余额随主卡 → ${formatCardNumber(primary.phone.sim_index)}`
                        : '余额随主卡'}
                    </span>
                  {:else}
                    {#if row.phone.service_type === 'postpaid'}
                      <span class="flex flex-col">
                        <strong class="text-sm leading-tight font-medium text-stone-400">不按余额管理</strong>
                        <small class={billingAccountBySim.has(row.phone.iccid) ? 'text-emerald-700' : 'text-amber-700'}>
                          {billingAccountBySim.has(row.phone.iccid) ? '已收到过账单短信' : '等待账单短信'}
                        </small>
                      </span>
                    {:else}
                      <strong class="text-base leading-tight font-semibold tabular-nums truncate {['low_balance', 'zero_or_negative_balance'].includes(row.health) ? 'text-red-700' : 'text-stone-900'}">{formatBalanceMetric(row.balanceMetric)}</strong>
                    {/if}
                    <span class="text-[11px] text-stone-400 truncate shrink">{row.phone.flag || getCountryFlag(row.phone.country)} {row.phone.carrier || '—'}</span>
                    <span class="text-[10px] text-stone-400 shrink-0">· {getSimServiceTypeLabel(row.phone.service_type)}</span>
                    {#if row.expiryDate}
                      <span class="font-mono text-[10px] text-stone-400 shrink-0">· {row.expiryDate}</span>
                    {/if}
                    {#if row.balanceTimestamp}
                      <span class="hidden min-[390px]:inline ml-auto font-mono text-[10px] text-stone-400 shrink-0">{formatTime(row.balanceTimestamp, true)}</span>
                    {/if}
                  {/if}
                </div>
                {#if canQueryBalances && row.phone.service_type !== 'postpaid'}
                  <button type="button" onclick={(event) => queryPhone(row, event)}
                    disabled={!!queryingIccid || row.phone.sim_role === 'secondary'}
                    aria-label={`查询 ${formatCardNumber(row.phone.sim_index)} 余额`}
                    class="h-8 px-2.5 shrink-0 text-xs font-semibold text-action-text bg-orange-50 rounded-lg active:bg-orange-100 disabled:text-stone-300 disabled:bg-stone-50">
                    {queryingIccid === row.phone.iccid ? '排队中…' : '查询'}
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {:else if activeTab === 'bills'}
      <div class="px-4 py-3 lg:px-5 border-b border-stone-100 flex items-center gap-3 lg:flex-none">
        <div>
          <p class="text-sm font-semibold text-stone-800">按接收卡归集的付款队列</p>
          <p class="text-[11px] text-stone-400">当前 SIM 收到运营商账单短信后自动生成，无需配置账户号</p>
        </div>
        <button type="button" onclick={() => loadBills(true)} disabled={billsLoading}
          class="ml-auto px-3 py-1.5 text-xs font-medium text-stone-600 bg-stone-100 hover:bg-stone-200 rounded-lg disabled:opacity-50">
          {billsLoading ? '刷新中…' : '刷新'}
        </button>
      </div>
      {#if billsLoading && !billsLoaded}
        <div class="py-16 text-center text-sm text-stone-400">正在加载后付费账单…</div>
      {:else if billError}
        <div class="py-16 text-center">
          <p class="text-sm text-red-600">{billError}</p>
          <button type="button" onclick={() => loadBills(true)} class="mt-2 text-xs text-action-text hover:underline">重试</button>
        </div>
      {:else if bills.length === 0}
        <div class="py-16 px-6 text-center">
          <p class="text-sm font-medium text-stone-600">目前没有后付费账单</p>
          <p class="mt-1 text-xs text-stone-400">当前 SIM 收到运营商账单短信后，系统会自动生成待办。</p>
        </div>
      {:else}
        <div class="hidden lg:block lg:flex-1 lg:min-h-0 lg:overflow-auto" data-desktop-bill-scroll>
          <table class="w-full text-sm">
            <thead class="sticky top-0 z-10 bg-stone-50">
              <tr class="border-b border-stone-200 text-[11px] font-semibold text-stone-400 tracking-widest uppercase">
                <th class="px-4 py-2.5 text-left">接收卡</th>
                <th class="px-4 py-2.5 text-left">运营商</th>
                <th class="px-4 py-2.5 text-left">金额</th>
                <th class="px-4 py-2.5 text-left">到期日</th>
                <th class="px-4 py-2.5 text-left">处理状态</th>
                <th class="px-4 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-stone-50">
              {#each bills as bill}
                {@const urgency = billUrgencyMeta(bill)}
                <tr class="hover:bg-stone-50">
                  <td class="px-4 py-3">
                    <strong class="block font-mono text-stone-800">{formatCardNumber(bill.notification_sim?.sim_index)}</strong>
                    <span class="text-[11px] text-stone-400">账单短信接收卡</span>
                  </td>
                  <td class="px-4 py-3 text-stone-600">{bill.carrier}</td>
                  <td class="px-4 py-3 font-semibold tabular-nums text-stone-900">{formatBillAmount(bill)}</td>
                  <td class="px-4 py-3">
                    <span class="block font-mono text-xs text-stone-600">{bill.due_date}</span>
                    <span class="mt-0.5 inline-flex px-2 py-0.5 rounded-md border text-[10px] font-medium {urgency.className}">{urgency.label}</span>
                  </td>
                  <td class="px-4 py-3 text-xs text-stone-600">{billActionLabel(bill.action_status)}</td>
                  <td class="px-4 py-3 text-right">
                    <button type="button" aria-label="查看账单" onclick={() => openBill(bill)} disabled={billDetailLoading}
                      class="text-xs font-medium text-action-text hover:underline disabled:text-stone-300">查看</button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="lg:hidden divide-y divide-stone-100" data-mobile-bill-list>
          {#each bills as bill}
            {@const urgency = billUrgencyMeta(bill)}
            <button type="button" aria-label="查看账单" onclick={() => openBill(bill)}
              class="w-full px-4 py-3 text-left active:bg-stone-50">
              <span class="flex items-start gap-3">
                <span class="min-w-0 flex-1">
                  <strong class="block font-mono text-sm text-stone-900">{formatCardNumber(bill.notification_sim?.sim_index)}</strong>
                  <span class="mt-0.5 block text-xs text-stone-400 truncate">{bill.carrier} · 账单短信接收卡</span>
                </span>
                <strong class="text-sm tabular-nums text-stone-900">{formatBillAmount(bill)}</strong>
              </span>
              <span class="mt-2 flex items-center gap-2">
                <span class="font-mono text-xs text-stone-500">{bill.due_date}</span>
                <span class="inline-flex px-2 py-0.5 rounded-md border text-[10px] font-medium {urgency.className}">{urgency.label}</span>
                <span class="ml-auto text-[10px] text-stone-400">自动识别</span>
              </span>
            </button>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="px-4 py-3 lg:px-5 border-b border-stone-100 flex justify-end lg:flex-none">
        <label class="sr-only" for="balance-history-carrier-filter">运营商筛选</label>
        <select
          id="balance-history-carrier-filter"
          value={carrierFilter}
          onchange={(event) => { carrierFilter = event.currentTarget.value; }}
          aria-label="运营商筛选"
          class="w-full sm:w-[145px] px-2.5 py-2 text-sm bg-stone-50 border border-stone-200 rounded-lg
            focus:outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
        >
          <option value="all">全部运营商</option>
          {#each carrierOptions as carrier}
            <option value={carrier.key}>{carrier.label}</option>
          {/each}
        </select>
      </div>
      {#if sortedChecks.length === 0}
        <div class="py-16 text-center text-sm text-stone-400">没有匹配的余额查询记录</div>
      {:else}
        <div class="hidden lg:block lg:flex-1 lg:min-h-0 lg:overflow-auto" data-desktop-balance-scroll>
          <table class="w-full text-sm">
            <thead class="sticky top-0 z-10 bg-stone-50"><tr class="bg-stone-50 border-b border-stone-200">
              {#each historyColumns as column, index}
                <th class="px-4 py-2.5 text-left text-[11px] font-semibold text-stone-400 tracking-widest uppercase {index === historyColumns.length - 1 ? 'text-right' : ''}">
                  {#if column.key}
                    <button type="button" onclick={() => toggleHistorySort(column.key)}
                      class="inline-flex items-center gap-1 hover:text-stone-700 transition-colors"
                      aria-label={`按${column.label}${historySortKey === column.key && historySortDirection === 'asc' ? '降序' : '升序'}排列`}>
                      {column.label}
                      <span class="text-[9px] {historySortKey === column.key ? 'text-orange-500' : 'text-stone-300'}" aria-hidden="true">
                        {historySortKey === column.key ? (historySortDirection === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  {:else}{column.label}{/if}
                </th>
              {/each}
            </tr></thead>
            <tbody class="divide-y divide-stone-50">
              {#each sortedChecks as check}
                {@const queryMeta = getBalanceStatusMeta(check.display_status || check.status)}
                <tr class="hover:bg-stone-50">
                  <td class="px-4 py-3 font-mono text-xs text-stone-500 whitespace-nowrap">{formatTime(getBalanceTimestamp(check))}</td>
                  <td class="px-4 py-3 font-mono font-semibold text-stone-800 whitespace-nowrap">{formatCardNumber(check.sim_index)} <span class="ml-1 text-xs font-normal text-stone-500">{check.sim_number || check.sim_iccid}</span></td>
                  <td class="px-4 py-3 text-stone-600 whitespace-nowrap">{check.profile_carrier || check.sim_carrier || '—'}</td>
                  <td class="px-4 py-3 text-xs uppercase text-stone-500">{check.method || '—'}</td>
                  <td class="px-4 py-3"><span class="inline-flex px-2 py-0.5 rounded-md border text-[11px] font-medium {queryMeta.className}">{queryMeta.label}</span></td>
                  <td class="px-4 py-3 font-semibold tabular-nums text-stone-800">{formatBalanceMetric(check.metrics?.find((metric) => metric.metric_type === 'cash_balance'))}</td>
                  <td class="px-4 py-3 text-right"><button type="button" onclick={() => onOpenBalance?.(check)} class="text-xs font-medium text-action-text hover:underline">详情</button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="lg:hidden divide-y divide-stone-100" data-mobile-balance-history>
          {#each sortedChecks as check}
            {@const queryMeta = getBalanceStatusMeta(check.display_status || check.status)}
            <button type="button" onclick={() => onOpenBalance?.(check)} class="w-full px-4 py-2.5 text-left active:bg-stone-50">
              <span class="flex items-center gap-2">
                <span class="font-mono font-bold text-stone-800">{formatCardNumber(check.sim_index)}</span>
                <span class="font-mono text-xs text-stone-500 truncate">{check.sim_number || check.sim_iccid}</span>
                <span class="ml-auto inline-flex px-2 py-0.5 rounded-md border text-[10px] font-medium {queryMeta.className}">{queryMeta.label}</span>
              </span>
              <span class="mt-1.5 flex items-center gap-2 text-xs text-stone-500">
                <strong class="text-sm text-stone-800 tabular-nums">{formatBalanceMetric(check.metrics?.find((metric) => metric.metric_type === 'cash_balance'))}</strong>
                <span>{check.profile_carrier || check.sim_carrier || '—'}</span>
                <span class="ml-auto font-mono text-[10px] text-stone-400">{formatTime(getBalanceTimestamp(check), true)}</span>
              </span>
            </button>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>

{#if selectedBill}
  {@const selectedUrgency = billUrgencyMeta(selectedBill)}
  <div class="fixed inset-0 z-50 bg-stone-900/35 flex items-end sm:items-center justify-center sm:p-4">
    <section class="w-full sm:max-w-[640px] max-h-[92vh] bg-white border border-stone-200 rounded-t-xl sm:rounded-xl shadow-modal overflow-hidden flex flex-col" aria-label="后付费账单详情">
      <header class="px-5 py-4 border-b border-stone-100 flex items-start justify-between gap-4">
        <div>
          <h3 class="font-mono font-semibold text-stone-900">{formatCardNumber(selectedBill.notification_sim?.sim_index ?? selectedBill.linked_sims?.[0]?.sim_index)}</h3>
          <p class="mt-0.5 text-xs text-stone-400">{selectedBill.carrier} · 由该卡收到的账单短信自动识别</p>
        </div>
        <button type="button" onclick={() => { selectedBill = null; }} aria-label="关闭账单详情" class="w-8 h-8 text-stone-400 hover:bg-stone-100 rounded-lg">&times;</button>
      </header>
      <div class="overflow-y-auto">
        <div class="grid grid-cols-2 sm:grid-cols-4 border-b border-stone-100">
          <div class="px-4 py-3 border-r border-stone-100"><p class="text-[11px] text-stone-400">金额</p><strong class="block mt-1 text-stone-900 tabular-nums">{formatBillAmount(selectedBill)}</strong></div>
          <div class="px-4 py-3 border-r border-stone-100"><p class="text-[11px] text-stone-400">到期日</p><strong class="block mt-1 font-mono text-sm text-stone-800">{selectedBill.due_date}</strong></div>
          <div class="px-4 py-3 border-r border-stone-100"><p class="text-[11px] text-stone-400">紧急程度</p><span class="mt-1 inline-flex px-2 py-0.5 rounded-md border text-[10px] font-medium {selectedUrgency.className}">{selectedUrgency.label}</span></div>
          <div class="px-4 py-3"><p class="text-[11px] text-stone-400">处理状态</p><strong class="block mt-1 text-sm text-stone-800">{billActionLabel(selectedBill.action_status)}</strong></div>
        </div>
        <section class="px-5 py-4 border-b border-stone-100" aria-label="账单短信接收卡">
          <h4 class="text-xs font-semibold text-stone-700">账单短信接收卡</h4>
          <p class="mt-2 text-sm font-mono text-stone-600">{formatCardNumber(selectedBill.notification_sim?.sim_index ?? selectedBill.linked_sims?.[0]?.sim_index)}</p>
        </section>
        <section class="px-5 py-4 border-b border-stone-100" aria-label="账单短信证据">
          <h4 class="text-xs font-semibold text-stone-700">账单短信证据</h4>
          {#if selectedBill.source_message}
            <p class="mt-2 text-[11px] text-stone-400">来自 {selectedBill.source_message.sender || '运营商'}</p>
            <blockquote class="mt-2 p-3 bg-stone-50 border border-stone-100 rounded-lg text-sm leading-6 text-stone-600 whitespace-pre-wrap break-words">{selectedBill.source_message.content}</blockquote>
          {:else}
            <p class="mt-2 text-sm text-stone-400">原始短信已按保留策略清理，规范化账单和审计记录仍保留。</p>
          {/if}
        </section>
        <section class="px-5 py-4" aria-label="账单审计记录">
          <h4 class="text-xs font-semibold text-stone-700">审计记录</h4>
          <ol class="mt-2 space-y-2">
            {#each selectedBill.events || [] as event}
              <li class="flex items-start gap-3 text-xs">
                <span class="mt-1.5 w-1.5 h-1.5 rounded-full bg-stone-300 shrink-0"></span>
                <span class="flex-1 text-stone-600">{billEventLabel(event.event_type)}</span>
                <span class="font-mono text-[10px] text-stone-400">{formatTime(event.created_at, true)}</span>
              </li>
            {/each}
          </ol>
        </section>
      </div>
      {#if canWriteBills}
        <footer class="px-5 py-4 border-t border-stone-100 flex flex-wrap justify-end gap-2">
          {#if !['paid', 'waived'].includes(selectedBill.action_status)}
            <button type="button" onclick={() => recordBillAction('payment-planned', '计划付款')} disabled={billActionBusy}
              class="px-3 py-2 text-sm text-stone-600 bg-stone-100 hover:bg-stone-200 rounded-lg disabled:opacity-50">计划付款</button>
            <button type="button" onclick={() => recordBillAction('waive', '豁免')} disabled={billActionBusy}
              class="px-3 py-2 text-sm text-stone-600 bg-stone-100 hover:bg-stone-200 rounded-lg disabled:opacity-50">标记豁免</button>
            <button type="button" onclick={() => recordBillAction('mark-paid', '标记为已付款')} disabled={billActionBusy}
              class="px-3 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg disabled:opacity-50">标记已付款</button>
          {:else}
            <button type="button" onclick={() => recordBillAction('reopen', '重新打开')} disabled={billActionBusy}
              class="px-3 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg disabled:opacity-50">重新打开</button>
          {/if}
        </footer>
      {/if}
    </section>
  </div>
{/if}

{#if singlePreview}
  {@const preflight = singlePreview.preflight}
  {@const runnerUnavailable = preflight.runner?.required && !preflight.runner.available}
  <div class="fixed inset-0 z-50 bg-stone-900/35 flex items-end sm:items-center justify-center sm:p-4">
    <section class="w-full sm:max-w-[460px] bg-white border border-stone-200 rounded-t-xl sm:rounded-xl shadow-modal overflow-hidden" aria-label="单卡余额查询确认">
      <header class="px-5 py-4 border-b border-stone-100 flex items-start justify-between gap-4">
        <div>
          <h3 class="font-semibold text-stone-900">
            {runnerUnavailable ? '查询助手未就绪' : '浏览器查询确认'}
          </h3>
          <p class="mt-1 text-xs text-stone-400">
            {formatCardNumber(singlePreview.row.phone.sim_index)}
            <span class="mx-1">·</span>{singlePreview.row.phone.number || singlePreview.row.phone.phone_number}
          </p>
        </div>
        <button type="button" onclick={() => { singlePreview = null; }} aria-label="关闭" class="w-8 h-8 text-stone-400 hover:bg-stone-100 rounded-lg">&times;</button>
      </header>
      <div class="px-5 py-5 text-sm text-stone-600 leading-6">
        {#if runnerUnavailable}
          <p>此查询需要 {capabilityLabels[preflight.method.capability] || '本地查询助手'}，当前没有可用实例。</p>
          <p class="mt-2 text-xs text-stone-400">启动并登录 Balance Agent 后再查询，可立即处理任务。</p>
        {:else}
          <p>联通官方网站将在运行 Balance Agent 的电脑上打开，并逐张处理。</p>
          <p class="mt-2 text-xs text-stone-400">登录过程中可能需要完成滑块或图片验证。</p>
        {/if}
      </div>
      <footer class="px-5 py-4 border-t border-stone-100 flex items-center justify-end gap-2">
        <button type="button" onclick={() => { singlePreview = null; }} class="px-4 py-2 text-sm text-stone-600 hover:bg-stone-100 rounded-lg">取消</button>
        {#if runnerUnavailable}
          <button type="button" onclick={() => submitSingle()} disabled={!!queryingIccid}
            class="px-4 py-2 text-sm text-stone-500 hover:bg-stone-100 rounded-lg disabled:opacity-50">
            {queryingIccid ? '排队中…' : '仍然排队'}
          </button>
          <a href="message-dashboard-runner://open"
            class="px-4 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg">
            打开查询助手
          </a>
        {:else}
          <button type="button" onclick={() => submitSingle()} disabled={!!queryingIccid}
            class="px-4 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg disabled:opacity-50">
            {queryingIccid ? '排队中…' : '开始查询'}
          </button>
        {/if}
      </footer>
    </section>
  </div>
{/if}

{#if batchPreview}
  <div class="fixed inset-0 z-50 bg-stone-900/35 flex items-end sm:items-center justify-center sm:p-4">
    <section class="w-full sm:max-w-[520px] bg-white border border-stone-200 rounded-t-xl sm:rounded-xl shadow-modal overflow-hidden" aria-label="批量余额查询预览">
      <header class="px-4 py-4 border-b border-stone-100 flex items-center justify-between">
        <div>
          <h3 class="font-semibold text-stone-900">批量查询确认</h3>
          <p class="mt-0.5 text-xs text-stone-400">只查询已验证且满足 24 小时间隔的在线卡</p>
        </div>
        <button type="button" onclick={closeBatchPreview} aria-label="关闭" class="w-8 h-8 text-stone-400 hover:bg-stone-100 rounded-lg">&times;</button>
      </header>
      <div class="px-4 py-2.5 border-b border-stone-100 bg-stone-50 text-xs text-stone-600">
        查询范围：<strong class="font-medium text-stone-800">{batchScope?.label}</strong>
      </div>
      <div class="grid grid-cols-3 border-b border-stone-100">
        <div class="px-4 py-4 border-r border-stone-100"><p class="text-xs text-stone-400">将查询</p><strong class="block mt-1 text-2xl tabular-nums">{batchPreview.summary.eligible}</strong></div>
        <div class="px-4 py-4 border-r border-stone-100"><p class="text-xs text-stone-400">24h 内已查</p><strong class="block mt-1 text-2xl tabular-nums">{batchPreview.summary.cooldown}</strong></div>
        <div class="px-4 py-4"><p class="text-xs text-stone-400">离线</p><strong class="block mt-1 text-2xl tabular-nums">{batchPreview.summary.offline}</strong></div>
      </div>
      {#if batchPreview.method_summary}
        <div class="divide-y divide-stone-100 border-b border-stone-100">
          <label class="px-4 py-3 flex items-center gap-3 text-sm">
            <input type="checkbox" bind:checked={batchMethods.direct_sms} disabled={!batchPreview.method_summary.direct_sms}
              class="rounded border-stone-300 text-orange-500 focus:ring-orange-400">
            <span class="flex-1 text-stone-600">直接短信</span>
            <strong class="font-mono tabular-nums text-stone-800">{batchPreview.method_summary.direct_sms || 0}</strong>
          </label>
          <label class="px-4 py-3 flex items-center gap-3 text-sm">
            <input type="checkbox" bind:checked={batchMethods.sms_ai}
              disabled={!batchPreview.method_summary.sms_ai || !batchPreview.runner_capabilities?.sms_ai?.available}
              class="rounded border-stone-300 text-orange-500 focus:ring-orange-400">
            <span class="flex-1 text-stone-600">
              AI 辅助短信
              {#if batchPreview.method_summary.sms_ai && !batchPreview.runner_capabilities?.sms_ai?.available}
                <small class="ml-1 text-amber-600">助手未就绪</small>
              {/if}
            </span>
            <strong class="font-mono tabular-nums text-stone-800">{batchPreview.method_summary.sms_ai || 0}</strong>
          </label>
          <label class="px-4 py-3 flex items-center gap-3 text-sm">
            <input type="checkbox" bind:checked={batchMethods.browser}
              disabled={!batchPreview.method_summary.browser || !batchPreview.runner_capabilities?.carrier_browser?.available}
              class="rounded border-stone-300 text-orange-500 focus:ring-orange-400">
            <span class="flex-1 text-stone-600">
              浏览器登录（逐张处理）
              {#if batchPreview.method_summary.browser && !batchPreview.runner_capabilities?.carrier_browser?.available}
                <small class="ml-1 text-amber-600">助手未就绪</small>
              {/if}
            </span>
            <strong class="font-mono tabular-nums text-stone-800">{batchPreview.method_summary.browser || 0}</strong>
          </label>
          {#if batchMethods.browser}
            <div class="px-4 py-2.5 text-xs bg-orange-50 text-orange-700 space-y-1">
              <p>浏览器任务串行执行，每张卡都可能需要人工验证，并按运营商 profile 的限流间隔处理。</p>
              {#if (batchPreview.method_summary.browser || 0) > 5}
                <p class="font-medium text-red-600">
                  ⚠️ 当前选中 {batchPreview.method_summary.browser} 张浏览器查询卡，运营商登录接口可能限流，建议分批处理。
                </p>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
      <dl class="px-4 py-4 grid grid-cols-[1fr_auto] gap-y-2 text-sm">
        <dt class="text-stone-500">未支持运营商</dt><dd class="font-mono tabular-nums text-stone-700">{batchPreview.summary.unsupported}</dd>
        <dt class="text-stone-500">尚未完成单卡验证</dt><dd class="font-mono tabular-nums text-stone-700">{batchPreview.summary.unverified}</dd>
        {#if batchPreview.summary.secondary}
          <dt class="text-stone-500">副卡(余额随主卡)</dt><dd class="font-mono tabular-nums text-stone-700">{batchPreview.summary.secondary}</dd>
        {/if}
        <dt class="text-stone-500">范围内卡数</dt><dd class="font-mono tabular-nums text-stone-700">{batchPreview.summary.total}</dd>
      </dl>
      <footer class="px-4 py-4 border-t border-stone-100 flex gap-2 justify-end">
        <button type="button" onclick={closeBatchPreview} class="px-4 py-2 text-sm text-stone-600 hover:bg-stone-100 rounded-lg">取消</button>
        <button type="button" onclick={submitBatch} disabled={!selectedBatchCount() || batchSubmitting}
          class="px-4 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg disabled:bg-stone-300">
          {batchSubmitting ? '正在加入队列…' : `确认查询 ${selectedBatchCount()} 张卡`}
        </button>
      </footer>
    </section>
  </div>
{/if}
