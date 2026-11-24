<script lang="ts">
  import { textOr } from '../../shared/text.js';
  import { getDaemonStatusMeta, type DaemonView } from '../lib/daemon-status.js';
  import { getStatusMeta } from '../lib/device-status.js';
  import { formatTimeAgo } from '../lib/time.js';
  import type { Permission, ViewPhone } from './types.js';

  interface Props {
    daemonStatus: DaemonView;
    phoneNumbers: readonly ViewPhone[];
    can: Permission;
    onOpenIccidMappings: (filter: 'all' | 'error') => void;
  }

  let { daemonStatus, phoneNumbers, can, onOpenIccidMappings }: Props = $props();

  let daemonMeta = $derived(getDaemonStatusMeta(daemonStatus.status));
</script>

{#if daemonStatus.status === 'offline' || daemonStatus.status === 'error'}
  <div class="bg-red-50 border-b border-red-200 px-4 py-3">
    <div class="flex items-start gap-3">
      <span class="mt-0.5 shrink-0">
        <span class="inline-block w-2.5 h-2.5 rounded-full bg-red-500"></span>
      </span>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-semibold text-red-800">
          采集服务{daemonMeta.label}
        </p>
        <p class="text-xs text-red-600 mt-0.5 leading-relaxed">
          {#if daemonStatus.last_heartbeat}
            最后一次心跳是 <strong>{formatTimeAgo(daemonStatus.last_heartbeat)}</strong>。
            下面显示的是那时的数据，新短信不会进来。
          {:else}
            {textOr(daemonStatus.message, '设备数据可能不是最新的。历史消息仍可查看。')}
          {/if}
        </p>
        <p class="text-xs text-red-500 mt-1">通常是 Orange Pi 掉线或 USB 集线器断电。</p>
      </div>
      <button
        onclick={() => {
          window.location.reload();
        }}
        class="shrink-0 px-3 py-1.5 text-xs font-medium text-red-700 border border-red-300
              rounded-lg hover:bg-red-100 transition-colors"
      >
        重新连接
      </button>
    </div>
  </div>
{/if}

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
          {#if phoneNumbers.filter((p) => p.status === 'sim_error').length > 0}
            <strong>{phoneNumbers.filter((p) => p.status === 'sim_error').length}</strong>
            张{getStatusMeta('sim_error').label}
          {/if}
          {#if phoneNumbers.filter((p) => p.status === 'iccid_mismatch').length > 0}
            {#if phoneNumbers.filter((p) => p.status === 'sim_error').length > 0}
              •
            {/if}
            <strong>{phoneNumbers.filter((p) => p.status === 'iccid_mismatch').length}</strong>
            张{getStatusMeta('iccid_mismatch').label}
          {/if}
        </span>
      </div>
      {#if can('phones.write')}
        <!-- Deep-links into the ICCID page, which a viewer cannot open — the hash
                 guard would bounce them straight back to the dashboard. -->
        <button
          onclick={() => {
            onOpenIccidMappings('error');
          }}
          class="text-xs text-yellow-600 hover:text-yellow-700 underline"
        >
          查看详情
        </button>
      {/if}
    </div>
  </div>
{/if}
