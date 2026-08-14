<script>
  import { formatCardNumber } from './card-number.js';
  import { getCountryFlag } from './countries.js';
  import { api } from './api.js';
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
    onQueriesChanged = null,
  } = $props();

  let activeTab = $state('overview');
  let statusFilter = $state('all');
  let searchQuery = $state('');
  let overviewSortKey = $state(null);
  let overviewSortDirection = $state('asc');
  let historySortKey = $state('time');
  let historySortDirection = $state('desc');
  let queryingIccid = $state(null);
  let loadingPreview = $state(false);
  let batchSubmitting = $state(false);
  let batchPreview = $state(null);
  let notice = $state(null);

  let rows = $derived(buildBalanceRows(phoneNumbers, balanceChecks));
  let counts = $derived(countBalanceHealth(rows));
  let filteredRows = $derived.by(() => {
    const query = searchQuery.trim().toLowerCase();
    return rows
      .filter((row) => statusFilter === 'all' || row.health === statusFilter)
      .filter((row) => {
        if (!query) return true;
        const phone = row.phone;
        return [
          formatCardNumber(phone.sim_index),
          phone.number,
          phone.phone_number,
          phone.iccid,
          phone.carrier,
        ].some((value) => String(value || '').toLowerCase().includes(query));
      })
      .sort(compareOverviewRows);
  });
  let sortedChecks = $derived((balanceChecks || []).slice().sort(compareHistoryChecks));
  let latestUpdate = $derived(
    rows
      .map((row) => row.balanceTimestamp)
      .filter(Boolean)
      .sort((a, b) => new Date(normalizeUtcTimestamp(b)) - new Date(normalizeUtcTimestamp(a)))[0] || null
  );

  const summaryItems = [
    ['normal', '正常'],
    ['low', '需要充值'],
    ['stale', '数据过期'],
    ['failed', '查询失败'],
    ['unknown', '尚未取得'],
  ];

  const overviewColumns = [
    { key: 'sim', label: 'SIM' },
    { key: 'carrier', label: '运营商' },
    { key: 'balance', label: '当前余额' },
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
    if (key === 'health') return ({ failed: 0, low: 1, stale: 2, unknown: 3, normal: 4 })[row.health];
    if (key === 'updated') return row.balanceTimestamp ? new Date(normalizeUtcTimestamp(row.balanceTimestamp)).getTime() : null;
    if (key === 'query') return row.latestCheck?.status || '';
    return null;
  }

  function compareOverviewRows(left, right) {
    if (!overviewSortKey) {
      const order = { failed: 0, low: 1, stale: 2, unknown: 3, normal: 4 };
      return order[left.health] - order[right.health]
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
    if (!canQueryBalances || queryingIccid) return;
    queryingIccid = row.phone.iccid;
    notice = null;
    try {
      await api.post('/api/balance-checks/query', { phone_iccid: row.phone.iccid });
      notice = { type: 'success', message: `${formatCardNumber(row.phone.sim_index)} 已加入余额查询队列` };
      await onQueriesChanged?.();
    } catch (error) {
      notice = { type: 'error', message: error.message || '余额查询创建失败' };
    } finally {
      queryingIccid = null;
    }
  }

  async function openBatchPreview() {
    if (!canQueryBalances || loadingPreview) return;
    loadingPreview = true;
    notice = null;
    try {
      batchPreview = await api.get('/api/balance-checks/query-preview');
    } catch (error) {
      notice = { type: 'error', message: error.message || '无法生成批量查询预览' };
    } finally {
      loadingPreview = false;
    }
  }

  async function submitBatch() {
    if (!canQueryBalances || batchSubmitting || !batchPreview?.summary?.eligible) return;
    batchSubmitting = true;
    try {
      const result = await api.post('/api/balance-checks/query-batch');
      batchPreview = null;
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
</script>

<div class="h-full min-h-0 bg-white lg:bg-transparent lg:px-8 lg:py-6 lg:overflow-auto">
  <div class="w-full bg-white lg:border lg:border-stone-200 lg:rounded-xl lg:shadow-raised overflow-hidden">
    <header class="px-4 py-4 lg:px-6 lg:py-5 border-b border-stone-100">
      <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div>
          <h2 class="text-lg lg:text-xl font-bold text-stone-900">余额管理</h2>
          <p class="mt-1 text-xs text-stone-400">
            {phoneNumbers.length} 张卡
            <span class="mx-1">·</span>
            最近更新 {formatTime(latestUpdate, true)}
          </p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <div class="inline-flex items-center bg-stone-100 rounded-lg p-0.5 text-xs">
            <button
              type="button"
              onclick={() => { activeTab = 'overview'; }}
              class="px-3 py-1.5 rounded-md transition-all {activeTab === 'overview'
                ? 'bg-white shadow-sm font-semibold text-stone-800'
                : 'text-stone-500'}"
            >余额概览</button>
            <button
              type="button"
              onclick={() => { activeTab = 'history'; }}
              class="px-3 py-1.5 rounded-md transition-all {activeTab === 'history'
                ? 'bg-white shadow-sm font-semibold text-stone-800'
                : 'text-stone-500'}"
            >查询记录</button>
          </div>
          {#if canQueryBalances}
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

    {#if notice}
      <div class="px-4 lg:px-5 py-2.5 border-b text-sm flex items-center justify-between gap-3
        {notice.type === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-red-50 text-red-700 border-red-100'}">
        <span>{notice.message}</span>
        <button type="button" onclick={() => { notice = null; }} aria-label="关闭提示" class="text-current opacity-60 hover:opacity-100">&times;</button>
      </div>
    {/if}

    {#if activeTab === 'overview'}
      <section class="grid grid-cols-5 border-b border-stone-100" aria-label="余额状态汇总">
        {#each summaryItems as [value, label], index}
          {@const meta = BALANCE_HEALTH_META[value]}
          <button
            type="button"
            onclick={() => { statusFilter = statusFilter === value ? 'all' : value; }}
            aria-pressed={statusFilter === value}
            class="min-w-0 px-2 py-3 lg:px-5 lg:py-4 text-left transition-colors
              {index < summaryItems.length - 1 ? 'border-r border-stone-100' : ''}
              {statusFilter === value ? 'bg-stone-50' : 'hover:bg-stone-50/70'}"
          >
            <span class="flex items-center gap-1.5 text-[10px] lg:text-xs text-stone-500 truncate">
              <span class="w-1.5 h-1.5 rounded-full shrink-0 {meta.dotClass}"></span>
              <span class="truncate">{label}</span>
            </span>
            <strong class="block mt-1 text-lg lg:text-2xl font-semibold text-stone-900 tabular-nums">{counts[value]}</strong>
          </button>
        {/each}
      </section>

      <div class="px-4 py-3 lg:px-5 border-b border-stone-100 flex flex-col sm:flex-row gap-2 sm:items-center">
        <div class="flex items-center gap-1.5 overflow-x-auto">
          {#each [['all', '全部'], ['low', '需充值'], ['stale', '已过期'], ['failed', '失败'], ['unknown', '未取得']] as [value, label]}
            <button
              type="button"
              onclick={() => { statusFilter = value; }}
              class="shrink-0 px-2.5 py-1.5 text-xs rounded-lg font-medium transition-colors
                {statusFilter === value
                  ? value === 'low' || value === 'failed'
                    ? 'bg-red-600 text-white'
                    : 'bg-stone-800 text-white'
                  : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}"
            >{label}</button>
          {/each}
        </div>
        <div class="relative sm:ml-auto sm:w-[360px]">
          <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <input
            bind:value={searchQuery}
            type="search"
            placeholder="搜索 S02 / 号码 / 运营商 / ICCID…"
            class="w-full pl-9 pr-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-lg
              focus:outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
          />
        </div>
      </div>

      {#if filteredRows.length === 0}
        <div class="py-16 text-center">
          <p class="text-sm text-stone-400">没有匹配的 SIM</p>
          <button type="button" onclick={() => { statusFilter = 'all'; searchQuery = ''; }} class="mt-2 text-xs text-action-text hover:underline">清除筛选</button>
        </div>
      {:else}
        <div class="hidden lg:block overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="bg-stone-50 border-b border-stone-200">
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
              {#each filteredRows as row}
                <tr class="hover:bg-stone-50 transition-colors">
                  <td class="px-4 py-3 min-w-[210px]">
                    <div class="flex items-baseline gap-2">
                      <span class="font-mono font-bold text-stone-900">{formatCardNumber(row.phone.sim_index)}</span>
                      <span class="font-mono text-xs text-stone-600">{row.phone.number || row.phone.phone_number || '未设置号码'}</span>
                    </div>
                    <div class="mt-0.5 font-mono text-[10px] text-stone-400">{row.phone.iccid}</div>
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap text-stone-600">
                    <span class="mr-1">{row.phone.flag || getCountryFlag(row.phone.country)}</span>{row.phone.carrier || '—'}
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap font-semibold tabular-nums {row.health === 'low' ? 'text-red-700' : 'text-stone-900'}">
                    {formatBalanceMetric(row.balanceMetric)}
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap">
                    <span class="inline-flex px-2 py-0.5 rounded-md border text-[11px] font-medium {row.healthMeta.className}">{row.healthMeta.label}</span>
                  </td>
                  <td class="px-4 py-3 whitespace-nowrap font-mono text-xs text-stone-500">{formatThreshold(row.threshold)}</td>
                  <td class="px-4 py-3 whitespace-nowrap font-mono text-xs text-stone-500">{formatTime(row.balanceTimestamp, true)}</td>
                  <td class="px-4 py-3 whitespace-nowrap">
                    {#if row.latestCheck}
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
                      {#if canQueryBalances}
                        <button type="button" onclick={(event) => queryPhone(row, event)} disabled={!!queryingIccid}
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

        <div class="lg:hidden divide-y divide-stone-100">
          {#each filteredRows as row}
            <div class="w-full px-4 py-3 text-left bg-white">
              <span class="flex items-center gap-2 min-w-0">
                <button type="button" onclick={() => openRow(row)} disabled={!row.latestCheck && !row.balanceCheck}
                  class="flex items-center gap-2 min-w-0 text-left disabled:cursor-default">
                  <span class="font-mono font-bold text-sm text-stone-900 shrink-0">{formatCardNumber(row.phone.sim_index)}</span>
                  <span class="font-mono text-sm text-stone-700 truncate">{row.phone.number || row.phone.phone_number || '未设置号码'}</span>
                </button>
                <span class="ml-auto inline-flex px-2 py-0.5 rounded-md border text-[10px] font-medium shrink-0 {row.healthMeta.className}">{row.healthMeta.label}</span>
              </span>
              <span class="mt-1.5 flex items-baseline gap-2 min-w-0">
                <strong class="text-base font-semibold tabular-nums {row.health === 'low' ? 'text-red-700' : 'text-stone-900'}">{formatBalanceMetric(row.balanceMetric)}</strong>
                <span class="text-[11px] text-stone-400 truncate">{row.phone.flag || getCountryFlag(row.phone.country)} {row.phone.carrier || '—'}</span>
                <span class="ml-auto font-mono text-[10px] text-stone-400 shrink-0">{formatTime(row.balanceTimestamp, true)}</span>
              </span>
              {#if canQueryBalances}
                <div class="mt-2 flex justify-end">
                  <button type="button" onclick={(event) => queryPhone(row, event)} disabled={!!queryingIccid}
                    class="px-3 py-1.5 text-xs font-semibold text-action-text bg-orange-50 rounded-lg disabled:text-stone-300 disabled:bg-stone-50">
                    {queryingIccid === row.phone.iccid ? '正在排队…' : '查询余额'}
                  </button>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      {#if sortedChecks.length === 0}
        <div class="py-16 text-center text-sm text-stone-400">暂无余额查询记录</div>
      {:else}
        <div class="hidden lg:block overflow-x-auto">
          <table class="w-full text-sm">
            <thead><tr class="bg-stone-50 border-b border-stone-200">
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
        <div class="lg:hidden divide-y divide-stone-100">
          {#each sortedChecks as check}
            {@const queryMeta = getBalanceStatusMeta(check.display_status || check.status)}
            <button type="button" onclick={() => onOpenBalance?.(check)} class="w-full px-4 py-3 text-left active:bg-stone-50">
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

{#if batchPreview}
  <div class="fixed inset-0 z-50 bg-stone-900/35 flex items-end sm:items-center justify-center sm:p-4">
    <section class="w-full sm:max-w-[520px] bg-white border border-stone-200 rounded-t-xl sm:rounded-xl shadow-modal overflow-hidden" aria-label="批量余额查询预览">
      <header class="px-4 py-4 border-b border-stone-100 flex items-center justify-between">
        <div>
          <h3 class="font-semibold text-stone-900">批量查询确认</h3>
          <p class="mt-0.5 text-xs text-stone-400">只查询已验证且满足 24 小时间隔的在线卡</p>
        </div>
        <button type="button" onclick={() => { batchPreview = null; }} aria-label="关闭" class="w-8 h-8 text-stone-400 hover:bg-stone-100 rounded-lg">&times;</button>
      </header>
      <div class="grid grid-cols-3 border-b border-stone-100">
        <div class="px-4 py-4 border-r border-stone-100"><p class="text-xs text-stone-400">将查询</p><strong class="block mt-1 text-2xl tabular-nums">{batchPreview.summary.eligible}</strong></div>
        <div class="px-4 py-4 border-r border-stone-100"><p class="text-xs text-stone-400">24h 内已查</p><strong class="block mt-1 text-2xl tabular-nums">{batchPreview.summary.cooldown}</strong></div>
        <div class="px-4 py-4"><p class="text-xs text-stone-400">离线</p><strong class="block mt-1 text-2xl tabular-nums">{batchPreview.summary.offline}</strong></div>
      </div>
      <dl class="px-4 py-4 grid grid-cols-[1fr_auto] gap-y-2 text-sm">
        <dt class="text-stone-500">未支持运营商</dt><dd class="font-mono tabular-nums text-stone-700">{batchPreview.summary.unsupported}</dd>
        <dt class="text-stone-500">尚未完成单卡验证</dt><dd class="font-mono tabular-nums text-stone-700">{batchPreview.summary.unverified}</dd>
        <dt class="text-stone-500">总卡数</dt><dd class="font-mono tabular-nums text-stone-700">{batchPreview.summary.total}</dd>
      </dl>
      <footer class="px-4 py-4 border-t border-stone-100 flex gap-2 justify-end">
        <button type="button" onclick={() => { batchPreview = null; }} class="px-4 py-2 text-sm text-stone-600 hover:bg-stone-100 rounded-lg">取消</button>
        <button type="button" onclick={submitBatch} disabled={!batchPreview.summary.eligible || batchSubmitting}
          class="px-4 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg disabled:bg-stone-300">
          {batchSubmitting ? '正在加入队列…' : `确认查询 ${batchPreview.summary.eligible} 张卡`}
        </button>
      </footer>
    </section>
  </div>
{/if}
