<script lang="ts">
  import type { MeResponse } from '../../shared/api/auth.js';
  import { textOr } from '../../shared/text.js';
  import type { View } from '../../shared/views.js';
  import { auth } from '../lib/auth.js';
  import { formatCardNumber } from '../lib/card-number.js';
  import { getDaemonStatusMeta, type DaemonView } from '../lib/daemon-status.js';
  import { formatTimeAgo } from '../lib/time.js';
  import type { CallController } from './call-controller.svelte.js';
  import type { Permission, ViewPhone } from './types.js';

  interface Props {
    user: MeResponse['user'];
    currentView: View;
    can: Permission;
    calls: CallController;
    daemonStatus: DaemonView;
    daemonRefreshing: boolean;
    showDaemonDetails: boolean;
    showPhoneList: boolean;
    selectedPhone: ViewPhone | null;
    onNavigate: (view: View) => void;
    onOpenIccidMappings: (filter: 'all' | 'error') => void;
    onOpenDaemonDetails: () => Promise<void>;
    onOpenPhoneList: () => void;
    onToggleSendDrawer: () => void;
    onResetCache: () => Promise<void>;
  }

  let {
    user,
    currentView,
    can,
    calls,
    daemonStatus,
    daemonRefreshing,
    showDaemonDetails,
    showPhoneList,
    selectedPhone,
    onNavigate,
    onOpenIccidMappings,
    onOpenDaemonDetails,
    onOpenPhoneList,
    onToggleSendDrawer,
    onResetCache,
  }: Props = $props();

  let daemonMeta = $derived(getDaemonStatusMeta(daemonStatus.status));
  let initials = $derived(textOr(user.name, textOr(user.email, '?')).charAt(0).toUpperCase());
</script>

<header class="bg-white border-b border-stone-200 sticky top-0 z-40 lg:flex-shrink-0">
  <div class="px-4 lg:px-5 flex items-center h-[52px] gap-3 lg:gap-6">
    <div class="flex items-center gap-2.5 shrink-0">
      <img src="/favicon.svg" alt="" class="w-[30px] h-[30px] rounded-[8px]" />
      <span class="text-[17px] leading-none font-semibold text-stone-900 tracking-[-0.01em]"
        >验证码中心</span
      >
    </div>

    <nav class="hidden lg:flex items-center gap-0.5 flex-1">
      <button
        onclick={() => {
          onNavigate('dashboard');
        }}
        class="text-sm px-3 py-1.5 rounded-[7px] transition-all
              {currentView === 'dashboard'
          ? 'bg-stone-100 font-semibold text-stone-900'
          : 'text-stone-500 hover:text-stone-900 hover:bg-stone-50'}"
      >
        消息
      </button>
      {#if can('phones.write')}
        <button
          onclick={() => {
            onOpenIccidMappings('all');
          }}
          class="text-sm px-3 py-1.5 rounded-[7px] transition-all
                {currentView === 'iccid-mappings'
            ? 'bg-stone-100 font-semibold text-stone-900'
            : 'text-stone-500 hover:text-stone-900 hover:bg-stone-50'}"
        >
          设备与卡
        </button>
      {/if}
      <button
        onclick={() => {
          onNavigate('balances');
        }}
        class="text-sm px-3 py-1.5 rounded-[7px] transition-all
              {currentView === 'balances'
          ? 'bg-stone-100 font-semibold text-stone-900'
          : 'text-stone-500 hover:text-stone-900 hover:bg-stone-50'}"
      >
        余额
      </button>
      {#if can('keywords.read') || can('filters.read')}
        <button
          onclick={() => {
            onNavigate(can('filters.read') ? 'filters' : 'keywords');
          }}
          class="text-sm px-3 py-1.5 rounded-[7px] transition-all
                {currentView === 'keywords' || currentView === 'filters'
            ? 'bg-stone-100 font-semibold text-stone-900'
            : 'text-stone-500 hover:text-stone-900 hover:bg-stone-50'}"
        >
          规则
        </button>
      {/if}
      {#if can('users.read')}
        <button
          onclick={() => {
            onNavigate('users');
          }}
          class="text-sm px-3 py-1.5 rounded-[7px] transition-all
                {currentView === 'users'
            ? 'bg-stone-100 font-semibold text-stone-900'
            : 'text-stone-500 hover:text-stone-900 hover:bg-stone-50'}"
        >
          用户
        </button>
      {/if}
    </nav>

    <div class="hidden lg:flex items-center gap-3 ml-auto shrink-0">
      {#if can('messages.read')}
        <button
          onclick={() => {
            calls.togglePanel();
          }}
          aria-haspopup="dialog"
          aria-expanded={calls.showPanel}
          class="flex items-center gap-1.5 px-2.5 py-[5px] border rounded-[7px] text-xs transition-colors
                {calls.activeCall?.state === 'ringing'
            ? 'bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700 animate-pulse'
            : calls.activeCall
              ? 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100'
              : 'bg-stone-50 border-stone-200 text-stone-700 hover:bg-stone-100'}"
        >
          <svg
            class="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M3 5a2 2 0 012-2h2.3a1 1 0 01.95.68l1.1 3.3a1 1 0 01-.5 1.2l-1.6.8a11 11 0 005.1 5.1l.8-1.6a1 1 0 011.2-.5l3.3 1.1a1 1 0 01.68.95V19a2 2 0 01-2 2h-1C9.7 21 3 14.3 3 6V5z"
            />
          </svg>
          <span class="font-medium tabular-nums">
            {#if calls.activeCall?.state === 'ringing'}来电{:else if calls.duration}{calls.duration}{:else}通话{/if}
          </span>
          {#if !calls.activeCall && calls.missedCount > 0}
            <span
              title="{calls.missedCount} 通未接来电"
              class="min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full
                    bg-rose-600 text-white text-[10px] font-medium tabular-nums"
              >{calls.missedCount}</span
            >
          {/if}
        </button>
      {/if}

      <button
        onclick={onOpenDaemonDetails}
        aria-haspopup="dialog"
        aria-expanded={showDaemonDetails}
        class="flex items-center gap-1.5 px-2.5 py-[5px] bg-stone-50 border border-stone-200
              rounded-[7px] text-xs transition-colors hover:bg-stone-100 {daemonRefreshing
          ? 'opacity-60'
          : ''}"
      >
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

      <!-- Only below 1600px; wider layouts have the resident send column. -->
      {#if can('messages.send')}
        <button
          onclick={onToggleSendDrawer}
          class="2xl:hidden flex items-center gap-1.5 px-3.5 py-[7px] bg-orange-500
                hover:bg-orange-600 text-white text-sm font-medium rounded-[8px] transition-colors"
        >
          <svg
            class="w-4 h-4"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          发送短信
        </button>
      {/if}

      <!-- A broom, not a refresh arrow: this clears local data and reloads. -->
      <button
        onclick={onResetCache}
        title="清除本地缓存并重新加载"
        aria-label="清除本地缓存并重新加载"
        class="w-[26px] h-[26px] rounded-full text-stone-400 hover:text-stone-700 hover:bg-stone-100
              flex items-center justify-center transition-colors shrink-0"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M19 5l-7 7M14 3l7 7-9 9H5v-3l9-9z"
          />
        </svg>
      </button>

      <button
        onclick={() => {
          auth.logout();
        }}
        title="退出登录"
        class="w-[26px] h-[26px] rounded-full bg-stone-200 hover:bg-stone-300 flex items-center
                justify-center text-[11px] font-semibold text-stone-700 transition-colors shrink-0"
      >
        {initials}
      </button>
    </div>

    <!-- Mobile: this is a receiver selector, not global navigation. -->
    {#if currentView === 'dashboard'}
      <button
        class="lg:hidden ml-auto min-w-0 max-w-[190px] h-9 px-2.5 flex items-center gap-1.5
              border border-stone-200 bg-stone-50 text-stone-700 rounded-lg transition-colors
              hover:bg-stone-100 active:bg-stone-200"
        onclick={onOpenPhoneList}
        aria-haspopup="dialog"
        aria-expanded={showPhoneList}
        aria-label={selectedPhone
          ? `切换接收卡，当前为${selectedPhone.number || formatCardNumber(selectedPhone.sim_index)}`
          : '选择接收卡'}
      >
        <svg
          class="w-4 h-4 text-stone-500 shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <rect x="7" y="2" width="10" height="20" rx="2" stroke-width="2" />
          <path stroke-linecap="round" stroke-width="2" d="M10 5h4M11 18h2" />
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
        <svg
          class="w-3.5 h-3.5 text-stone-400 shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 9l6 6 6-6" />
        </svg>
      </button>
    {/if}
  </div>
</header>
