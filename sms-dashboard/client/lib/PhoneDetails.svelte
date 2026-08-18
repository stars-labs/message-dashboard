<script>
  import SignalStrength from './SignalStrength.svelte';
  import { formatCardNumber } from './card-number.js';
  import { getModemPosition } from './modem-position.js';
  import { getEffectiveDeviceStatus, getStatusMeta } from './device-status.js';
  import {
    formatBalanceMetric,
    getBalanceStatusMeta,
    getCashBalance,
  } from './balance-query.js';
  import { getSimServiceTypeLabel } from './sim-service-type.js';
  import { getSimRoleLabel } from './sim-role.js';

  let {
    phone = null,
    mobile = false,
    daemonStatus = { connected: false, lastDataUpdate: null },
    balanceCheck = null,
    onOpenBalance = null,
    phones = [],
  } = $props();

  let effectiveStatus = $derived(
    getEffectiveDeviceStatus(phone?.status, daemonStatus.connected)
  );
  let statusMeta = $derived(getStatusMeta(effectiveStatus));
  let signal = $derived(Number(phone?.signal) || 0);
  let balanceStatusMeta = $derived(getBalanceStatusMeta(balanceCheck?.display_status || balanceCheck?.status));
  let cashBalance = $derived(getCashBalance(balanceCheck));
  // carrier = user-maintained home label (sims table, never daemon-written)
  // operator = daemon-detected serving network (AT+COPS?, live, may differ when roaming)
  let carrier = $derived(phone?.carrier || '—');
  let operator = $derived(phone?.operator);
  // For a secondary SIM, the primary it belongs to (looked up from the full
  // phone list so we can show a human label, not just the raw ICCID).
  let primarySim = $derived(
    phone?.sim_role === 'secondary' && phone?.primary_iccid
      ? phones.find((p) => p.iccid === phone.primary_iccid)
      : null
  );
  let moduleName = $derived(
    [phone?.manufacturer, phone?.model].filter(Boolean).join(' ') || '—'
  );
  let location = $derived(getModemPosition(phone) || { path: null, isLastKnown: false });

  function formatUpdatedAt(value) {
    if (!value) return '—';
    const normalized = typeof value === 'string' && !value.endsWith('Z')
      ? `${value}Z`
      : value;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
</script>

{#if phone}
  <section
    aria-label="所选卡片信息"
    class="bg-white border border-stone-200/80 rounded-xl flex flex-col h-full min-h-0 overflow-hidden {mobile ? 'mx-4 mb-4' : ''}"
    style="box-shadow: 0 1px 3px rgba(28,25,23,0.06);"
  >
    <header class="h-[52px] px-4 border-b border-stone-200 flex items-center justify-between gap-4 shrink-0">
      <div class="min-w-0 flex items-center gap-3">
        <span class="w-1 h-7 rounded-sm bg-orange-500 shrink-0"></span>
        <div class="min-w-0 flex items-baseline gap-2">
          <h2 class="text-sm font-semibold text-stone-900 whitespace-nowrap">卡片信息</h2>
          <span class="font-mono text-xs font-semibold text-stone-600 whitespace-nowrap">
            {formatCardNumber(phone.sim_index)}
          </span>
          <span class="text-xs text-stone-400 truncate" title={phone.number || '未设置号码'}>
            {phone.flag || ''} {phone.number || '未设置号码'}
          </span>
        </div>
      </div>

      <div class="flex items-center gap-3 shrink-0">
        {#if balanceCheck}
          <button
            type="button"
            onclick={() => onOpenBalance?.(balanceCheck)}
            class="hidden xl:flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-stone-200
              hover:border-orange-200 hover:bg-orange-50/50 transition-colors text-left"
            aria-label="查看余额查询详情"
          >
            <span>
              <span class="block text-[10px] leading-none text-stone-400">余额</span>
              <span class="block mt-1 text-xs leading-none font-semibold text-stone-800 tabular-nums">
                {formatBalanceMetric(cashBalance)}
              </span>
            </span>
            <span class="w-px h-6 bg-stone-200"></span>
            <span class="text-[11px] font-medium {balanceStatusMeta.className.includes('red') ? 'text-red-700' : 'text-stone-500'}">
              {balanceStatusMeta.label}
            </span>
          </button>
        {/if}
        <div class="hidden sm:flex items-center gap-2 text-xs text-stone-500">
          <SignalStrength signal={signal} status={effectiveStatus} compact={true} />
          <span class="font-mono tabular-nums">{signal}%</span>
        </div>
        <span class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium {statusMeta.badgeClass}">
          <span class="w-1.5 h-1.5 rounded-full {statusMeta.dotClass}"></span>
          {statusMeta.label}
        </span>
      </div>
    </header>

    <div class="flex-1 min-h-0 overflow-y-auto">
      <div class="grid grid-cols-2 xl:grid-cols-4 border-b border-stone-100 bg-stone-50/50">
        <div class="px-4 py-3 border-r border-b xl:border-b-0 border-stone-100 min-w-0">
          <p class="text-[11px] text-stone-400 mb-1">手机号</p>
          <p class="text-sm font-medium text-stone-800 truncate" title={phone.number || '未设置'}>
            {phone.number || '未设置'}
          </p>
        </div>
        <div class="px-4 py-3 border-b xl:border-b-0 xl:border-r border-stone-100 min-w-0">
          <p class="text-[11px] text-stone-400 mb-1">运营商</p>
          <p class="text-sm font-medium text-stone-800 truncate" title={carrier}>{carrier}</p>
        </div>
        <div class="px-4 py-3 border-r border-stone-100 min-w-0">
          <p class="text-[11px] text-stone-400 mb-1">国家 / 地区</p>
          <p class="text-sm font-medium text-stone-800 truncate" title={phone.country || '—'}>
            {phone.flag || ''} {phone.country || '—'}
          </p>
        </div>
        <div class="px-4 py-3 min-w-0">
          <p class="text-[11px] text-stone-400 mb-1">最后更新</p>
          <p class="text-sm font-medium text-stone-800 tabular-nums">
            {formatUpdatedAt(phone.updated_at || phone.lastActive)}
          </p>
        </div>
      </div>

      <dl class="grid grid-cols-1 xl:grid-cols-2 gap-x-8 gap-y-3 px-4 py-3 text-xs">
        <div class="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-3 min-w-0">
          <dt class="text-stone-400">ICCID</dt>
          <dd class="font-mono text-stone-700 truncate" title={phone.iccid || '—'}>{phone.iccid || '—'}</dd>
        </div>
        <div class="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-3 min-w-0">
          <dt class="text-stone-400">IMEI</dt>
          <dd class="font-mono text-stone-700 truncate" title={phone.imei || '—'}>{phone.imei || '—'}</dd>
        </div>
        <div class="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-3 min-w-0">
          <dt class="text-stone-400">模块</dt>
          <dd class="text-stone-700 truncate" title={moduleName}>{moduleName}</dd>
        </div>
        <div class="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-3 min-w-0">
          <dt class="text-stone-400">位置</dt>
          <dd class="text-stone-700 truncate" title={location.path || ''}>
            {#if location.path}
              {location.path}
              {#if location.isLastKnown}
                <span class="text-[11px] text-stone-400">（上次）</span>
              {/if}
            {:else}
              <span class="text-stone-300">—</span>
            {/if}
          </dd>
        </div>
        <div class="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-3 min-w-0">
          <dt class="text-stone-400">网络</dt>
          <dd class="text-stone-700 truncate" title={phone.access_tech || operator}>
            {phone.access_tech || operator}
          </dd>
        </div>
        <div class="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-3 min-w-0">
          <dt class="text-stone-400">守护进程</dt>
          <dd class="text-stone-700">{daemonStatus.connected ? '连接正常' : '未连接'}</dd>
        </div>
        <div class="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-3 min-w-0">
          <dt class="text-stone-400">计费类型</dt>
          <dd class="text-stone-700">{getSimServiceTypeLabel(phone.service_type)}</dd>
        </div>
        <div class="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-3 min-w-0">
          <dt class="text-stone-400">主副卡</dt>
          <dd class="text-stone-700">
            {getSimRoleLabel(phone.sim_role)}
            {#if phone.sim_role === 'secondary' && primarySim}
              <span class="text-stone-400"> → {formatCardNumber(primarySim.sim_index)}</span>
            {/if}
          </dd>
        </div>
        {#if phone.notes}
          <div class="xl:col-span-2 grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-3 min-w-0 pt-1 border-t border-stone-100">
            <dt class="text-stone-400">备注</dt>
            <dd class="text-stone-700 truncate" title={phone.notes}>{phone.notes}</dd>
          </div>
        {/if}
      </dl>
    </div>
  </section>
{/if}
