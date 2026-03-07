<script>
  import { onMount, onDestroy } from 'svelte';
  import api from './api';
  
  let daemonStatus = {
    status: 'unknown',
    message: 'Checking daemon status...',
    modem_count: 0,
    last_heartbeat: null
  };
  
  let interval;
  
  async function checkDaemonStatus() {
    try {
      const response = await fetch('/api/daemon/status');
      if (response.ok) {
        daemonStatus = await response.json();
      } else {
        daemonStatus = {
          status: 'error',
          message: 'Failed to check daemon status'
        };
      }
    } catch (error) {
      console.error('Failed to check daemon status:', error);
      daemonStatus = {
        status: 'error',
        message: 'Cannot connect to server'
      };
    }
  }
  
  onMount(() => {
    checkDaemonStatus();
    // Check every 30 seconds
    interval = setInterval(checkDaemonStatus, 30000);
  });
  
  onDestroy(() => {
    if (interval) clearInterval(interval);
  });
  
  $: statusColor = {
    'online': 'text-emerald-600',
    'warning': 'text-amber-600',
    'offline': 'text-red-500',
    'error': 'text-red-500',
    'unknown': 'text-stone-400'
  }[daemonStatus.status] || 'text-stone-400';
  
  $: statusIcon = {
    'online': '🟢',
    'warning': '🟡',
    'offline': '🔴',
    'error': '🔴',
    'unknown': '⚪'
  }[daemonStatus.status] || '⚪';
</script>

<div class="bg-white rounded-lg p-3 border border-stone-200">
  <div class="flex items-center justify-between mb-2">
    <h3 class="text-stone-700 font-semibold text-sm">SMS Daemon Status</h3>
    <button
      on:click={checkDaemonStatus}
      class="text-xs text-stone-400 hover:text-stone-600 transition-colors"
      title="Refresh status"
    >
      🔄
    </button>
  </div>

  <div class="flex items-center gap-2">
    <span class="text-xl">{statusIcon}</span>
    <div class="flex-1">
      <div class="flex items-center gap-2">
        <span class="{statusColor} font-semibold capitalize">
          {daemonStatus.status}
        </span>
        {#if daemonStatus.modem_count !== undefined && daemonStatus.status === 'online'}
          <span class="text-xs text-stone-400">
            ({daemonStatus.modem_count} modem{daemonStatus.modem_count !== 1 ? 's' : ''})
          </span>
        {/if}
      </div>
      <div class="text-xs text-stone-400 mt-1">
        {daemonStatus.message}
      </div>
    </div>
  </div>

  {#if daemonStatus.status === 'offline' || daemonStatus.status === 'warning'}
    <div class="mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs">
      <div class="text-red-600 font-semibold mb-1">⚠️ Action Required</div>
      {#if daemonStatus.status === 'offline'}
        <div class="text-red-700">
          The SMS daemon is not responding. Please check:
          <ul class="mt-1 ml-4 list-disc">
            <li>SSH to Orange Pi: <code class="bg-stone-100 px-1 rounded">ssh root@10.171.150.102</code></li>
            <li>Check daemon status: <code class="bg-stone-100 px-1 rounded">systemctl status sms-dashboard-daemon</code></li>
            <li>Restart if needed: <code class="bg-stone-100 px-1 rounded">systemctl restart sms-dashboard-daemon</code></li>
            <li>Check ModemManager: <code class="bg-stone-100 px-1 rounded">systemctl status ModemManager</code></li>
          </ul>
        </div>
      {:else if daemonStatus.modem_count === 0}
        <div class="text-amber-700">
          No modems detected. ModemManager may be stopped or modems disconnected.
        </div>
      {/if}
    </div>
  {/if}

  {#if daemonStatus.version && daemonStatus.version !== 'unknown'}
    <div class="mt-2 text-xs text-stone-400">
      Version: {daemonStatus.version}
    </div>
  {/if}
</div>