<script lang="ts">
  import type { Permission, ViewPhone } from './types.js';

  interface Props {
    phoneNumbers: readonly ViewPhone[];
    can: Permission;
    onOpenIccidMappings: (filter: 'all' | 'error') => void;
  }

  let { phoneNumbers, can, onOpenIccidMappings }: Props = $props();

  // Device sync is incremental, so updated_at only moves when modem state changes;
  // a time-window filter would drop stable online devices. status 'active' is the signal.
  let onlineDevices = $derived(phoneNumbers.filter((p) => p.status === 'active').length);
  let anomalySimError = $derived(phoneNumbers.filter((p) => p.status === 'sim_error').length);
  let anomalyMismatch = $derived(phoneNumbers.filter((p) => p.status === 'iccid_mismatch').length);
  let anomalyOffline = $derived(phoneNumbers.filter((p) => p.status === 'offline').length);
</script>

<div class="lg:flex-shrink-0 bg-white border-b border-stone-200 flex-shrink-0">
  <div class="flex items-center gap-6 px-5 h-10 overflow-x-auto">
    <div class="flex items-baseline gap-1.5 shrink-0">
      <span
        class="font-mono text-[22px] font-semibold text-stone-900 leading-none tabular-nums tracking-[-0.02em]"
      >
        {onlineDevices}
      </span>
      <span class="font-mono text-sm text-stone-400">/ {phoneNumbers.length}</span>
      <span class="text-xs text-stone-600">张卡在线</span>
    </div>

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
            ICCID 不匹配
            <strong class="font-mono tabular-nums">{anomalyMismatch}</strong>
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
          onclick={() => {
            onOpenIccidMappings('error');
          }}
          class="text-xs text-action-text font-medium border-b border-[#fdba74] hover:border-orange-400 transition-colors shrink-0"
        >
          处理 →
        </button>
      {/if}
    {:else if phoneNumbers.length > 0}
      <div class="h-4 w-px bg-stone-200 shrink-0"></div>
      <span class="flex items-center gap-1.5 text-xs text-emerald-600">
        <span class="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0"
        ></span>
        全部正常
      </span>
    {/if}
  </div>
</div>
