<script lang="ts">
  import type { View } from '../../shared/views.js';
  import { auth } from '../lib/auth.js';
  import { getDaemonStatusMeta, type DaemonView } from '../lib/daemon-status.js';
  import { overlay } from '../lib/overlay.js';
  import { formatTimeAgo } from '../lib/time.js';
  import type { CallController } from './call-controller.svelte.js';
  import type { Permission } from './types.js';

  interface Props {
    can: Permission;
    calls: CallController;
    daemonStatus: DaemonView;
    onClose: () => void;
    onNavigate: (view: View) => void;
    onOpenDaemonDetails: () => Promise<void>;
    onResetCache: () => Promise<void>;
  }

  let { can, calls, daemonStatus, onClose, onNavigate, onOpenDaemonDetails, onResetCache }: Props =
    $props();

  let daemonMeta = $derived(getDaemonStatusMeta(daemonStatus.status));
</script>

<div
  class="lg:hidden fixed inset-0 z-[35] bg-stone-900/20"
  onclick={onClose}
  role="presentation"
></div>
<div
  class="lg:hidden fixed bottom-[var(--mobile-tab-bar-height)] left-0 right-0 z-40 bg-white border-t border-stone-200 rounded-t-2xl
        shadow-[0_-8px_30px_rgba(28,25,23,.18)] max-h-[calc(100dvh_-_var(--mobile-tab-bar-height)_-_16px)] overflow-y-auto"
  role="dialog"
  aria-modal="true"
  aria-label="更多"
  use:overlay={{ onClose }}
>
  <div class="p-4 space-y-1">
    <p class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest px-3 mb-2">
      运行状态
    </p>
    <button
      onclick={() => {
        onClose();
        void onOpenDaemonDetails();
      }}
      class="w-full flex items-center justify-between px-3 py-3 rounded-lg hover:bg-stone-50 transition-colors text-left"
    >
      <div class="flex items-center gap-2.5">
        <span class="w-2 h-2 rounded-full {daemonMeta.dotClass}"></span>
        <div>
          <div class="text-sm font-medium text-stone-800">采集服务{daemonMeta.label}</div>
          <div class="text-xs text-stone-400 mt-0.5">
            心跳 {formatTimeAgo(daemonStatus.last_heartbeat)}
          </div>
        </div>
      </div>
      <svg class="w-4 h-4 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
      </svg>
    </button>

    {#if can('messages.read')}
      <button
        onclick={() => {
          onClose();
          calls.openPanel();
        }}
        class="w-full flex items-center justify-between px-3 py-3 rounded-lg hover:bg-stone-50 transition-colors text-left"
      >
        <div class="flex items-center gap-2.5">
          <span class="w-2 h-2 rounded-full {calls.activeCall ? 'bg-emerald-500' : 'bg-stone-300'}"
          ></span>
          <div class="text-sm font-medium text-stone-800">
            {#if calls.activeCall?.state === 'ringing'}来电振铃{:else if calls.duration}通话中 {calls.duration}{:else}语音通话{/if}
          </div>
          {#if !calls.activeCall && calls.missedCount > 0}
            <span
              class="min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full
                    bg-rose-600 text-white text-[10px] font-medium tabular-nums"
              >{calls.missedCount}</span
            >
          {/if}
        </div>
        <svg class="w-4 h-4 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    {/if}

    <div class="border-t border-stone-100 my-2"></div>
    <p class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest px-3 mb-2">规则</p>

    {#if can('filters.read')}
      <button
        onclick={() => {
          onNavigate('filters');
        }}
        class="w-full flex items-center justify-between px-3 py-3 rounded-xl hover:bg-stone-50 transition-colors text-left"
      >
        <div>
          <div class="text-sm font-medium text-stone-800">垃圾过滤</div>
          <div class="text-xs text-stone-400 mt-0.5">隐藏非验证码推广短信</div>
        </div>
        <svg class="w-4 h-4 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    {/if}

    {#if can('keywords.read')}
      <button
        onclick={() => {
          onNavigate('keywords');
        }}
        class="w-full flex items-center justify-between px-3 py-3 rounded-xl hover:bg-stone-50 transition-colors text-left"
      >
        <div>
          <div class="text-sm font-medium text-stone-800">关键词高亮</div>
          <div class="text-xs text-stone-400 mt-0.5">标色识别验证码类型</div>
        </div>
        <svg class="w-4 h-4 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    {/if}

    {#if can('users.read')}
      <div class="border-t border-stone-100 my-2"></div>
      <p class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest px-3 mb-2">
        管理
      </p>
      <button
        onclick={() => {
          onNavigate('users');
        }}
        class="w-full flex items-center justify-between px-3 py-3 rounded-xl hover:bg-stone-50 transition-colors text-left"
      >
        <div>
          <div class="text-sm font-medium text-stone-800">用户管理</div>
          <div class="text-xs text-stone-400 mt-0.5">管理员 / 查看者角色</div>
        </div>
        <svg class="w-4 h-4 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    {/if}

    <div class="border-t border-stone-100 my-2"></div>
    <p class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest px-3 mb-2">账户</p>
    <!-- Self-service recovery for stale IndexedDB rows or a bad service worker. -->
    <button
      onclick={onResetCache}
      class="w-full flex items-center justify-between px-3 py-3 rounded-xl hover:bg-stone-50 transition-colors text-left"
    >
      <div>
        <div class="text-sm font-medium text-stone-700">重置本地缓存</div>
        <div class="text-xs text-stone-400 mt-0.5">清除短信与离线缓存后重新加载</div>
      </div>
      <svg class="w-4 h-4 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        />
      </svg>
    </button>
    <button
      onclick={() => {
        auth.logout();
      }}
      class="w-full flex items-center justify-between px-3 py-3 rounded-xl hover:bg-stone-50 transition-colors text-left"
    >
      <div class="text-sm font-medium text-stone-700">退出登录</div>
      <svg class="w-4 h-4 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
        />
      </svg>
    </button>
  </div>
</div>
