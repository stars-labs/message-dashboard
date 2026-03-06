<script>
  import SignalStrength from "./SignalStrength.svelte";

  export let modems = [];
  export let sims = [];
  export let selectedModemId = null;
  export let searchTerm = "";
  export let onSelectModem = null;
  export let mobile = false;
  export let daemonStatus = { connected: false, lastDataUpdate: null };
  export let isLoading = false;
  export let showOffline = true;

  // Helper to find SIM for a modem
  function findSimForModem(modem) {
    // Match by current_modem_id (equipment_id)
    return sims.find(s => s.current_modem_id === modem.equipment_id);
  }

  // Filter modems based on search and status
  $: filteredModems = modems.filter(modem => {
    // Filter by status
    if (!showOffline && (modem.status === 'offline' || modem.status === 'disconnected')) {
      return false;
    }

    // Filter by search
    const searchLower = searchTerm.toLowerCase();
    if (searchTerm === "") return true;

    const sim = findSimForModem(modem);

    return (
      (modem.equipment_id && modem.equipment_id.toLowerCase().includes(searchLower)) ||
      (modem.manufacturer && modem.manufacturer.toLowerCase().includes(searchLower)) ||
      (modem.model && modem.model.toLowerCase().includes(searchLower)) ||
      (modem.modem_index != null && modem.modem_index.toString().includes(searchLower)) ||
      (sim && sim.iccid && sim.iccid.toLowerCase().includes(searchLower)) ||
      (sim && sim.phone_number && sim.phone_number.toLowerCase().includes(searchLower))
    );
  });

  function getStatusColor(status) {
    switch (status) {
      case "registered":
      case "connected":
      case "online":
        return "text-green-400";
      case "searching":
        return "text-yellow-400";
      case "disconnected":
      case "offline":
        return "text-gray-400";
      case "error":
        return "text-red-400";
      default:
        return "text-gray-500";
    }
  }

  function handleModemClick(modem) {
    if (selectedModemId === modem.equipment_id) {
      selectedModemId = null;
      if (onSelectModem) onSelectModem(null);
    } else {
      selectedModemId = modem.equipment_id;
      if (onSelectModem) onSelectModem(modem);
    }
  }

  function formatImei(imei) {
    if (!imei || imei.length < 8) return imei;
    return `${imei.slice(0, 8)}...${imei.slice(-4)}`;
  }
</script>

<div class="{mobile ? 'bg-gray-900' : 'tech-card'}">
  <div class="p-3 lg:p-4 {mobile ? 'border-b border-gray-700' : ''}">
    <h2 class="text-base lg:text-lg font-bold data-value high-contrast mb-3">
      调制解调器列表
    </h2>

    <!-- Search -->
    <div class="mb-3">
      <input
        type="text"
        bind:value={searchTerm}
        placeholder="搜索 IMEI、型号或 SIM 卡..."
        class="w-full px-3 py-2 text-sm cyber-input placeholder-gray-500"
      />
    </div>

    <!-- Status Filter -->
    <div class="mb-3">
      <label class="flex items-center gap-2 text-sm text-gray-400">
        <input
          type="checkbox"
          bind:checked={showOffline}
          class="accent-blue-400"
        />
        <span>显示离线设备</span>
      </label>
    </div>

    <div class="flex items-center justify-between">
      <div class="text-sm font-bold text-gray-200">
        共 <span class="data-value text-base high-contrast">{filteredModems.length}</span> 个调制解调器
      </div>
      <div class="text-xs text-gray-400/60 flex items-center gap-2">
        <span class="flex items-center gap-1">
          <span class="w-2 h-2 bg-green-400 rounded-full"></span>
          有 SIM 卡
        </span>
        <span class="flex items-center gap-1">
          <span class="w-2 h-2 bg-orange-400 rounded-full"></span>
          无 SIM 卡
        </span>
      </div>
    </div>
  </div>

  <!-- Modem List -->
  <div class="{mobile ? '' : 'max-h-[calc(100vh-400px)]'} overflow-y-auto">
    {#if isLoading}
      <!-- Loading skeleton -->
      {#each [1, 2, 3, 4] as _}
        <div class="p-3 border-b border-gray-700">
          <div class="animate-pulse">
            <div class="h-4 bg-gray-700/50 rounded w-48 mb-2"></div>
            <div class="h-3 bg-gray-700/50 rounded w-32"></div>
          </div>
        </div>
      {/each}
    {:else if filteredModems.length === 0}
      <div class="p-4 text-center text-gray-400/60">
        <p class="text-sm">无匹配的调制解调器</p>
      </div>
    {:else}
      {#each filteredModems as modem}
        {@const sim = findSimForModem(modem)}
        <button
          class="w-full p-3 border-b border-gray-700 hover:bg-gray-700 transition-all text-left
                 {selectedModemId === modem.equipment_id ? 'bg-gray-700/50 border-l-4 border-l-blue-400' : ''}"
          on:click={() => handleModemClick(modem)}
        >
          <div class="flex items-center justify-between">
            <div class="flex-1">
              <!-- Modem Info -->
              <div class="flex items-center gap-2 mb-1">
                <span class="text-lg">📡</span>
                <span class="font-mono text-sm text-gray-200">
                  {formatImei(modem.equipment_id)}
                </span>
                {#if modem.modem_index != null}
                  <span class="px-2 py-0.5 bg-gray-700/50 text-gray-400 rounded text-xs">
                    #{modem.modem_index}
                  </span>
                {/if}
                <span class={getStatusColor(modem.status || 'offline')}>
                  ●
                </span>
              </div>

              <!-- Hardware Details -->
              <div class="text-xs text-gray-400/70">
                {#if modem.manufacturer || modem.model}
                  <span>{modem.manufacturer || ''} {modem.model || ''}</span>
                {/if}
                {#if modem.firmware_revision}
                  <span class="text-gray-500"> • FW: {modem.firmware_revision}</span>
                {/if}
              </div>

              <!-- SIM Info if present -->
              {#if sim}
                <div class="mt-1 flex items-center gap-2">
                  <span class="text-xs px-2 py-0.5 bg-green-900/30 text-green-400 rounded">
                    SIM 卡已插入
                  </span>
                  {#if sim.phone_number}
                    <span class="text-xs text-gray-200">{sim.phone_number}</span>
                  {/if}
                  {#if sim.operator_name}
                    <span class="text-xs text-gray-500">{sim.operator_name}</span>
                  {/if}
                </div>
              {:else}
                <div class="mt-1">
                  <span class="text-xs px-2 py-0.5 bg-orange-900/30 text-orange-400 rounded">
                    需要 SIM 卡
                  </span>
                </div>
              {/if}

              <!-- Connection Info -->
              {#if modem.access_tech}
                <div class="text-xs text-indigo-400 mt-0.5">
                  {modem.access_tech}
                  {#if modem.rssi} • RSSI: {modem.rssi}dBm{/if}
                  {#if modem.rsrq} • RSRQ: {modem.rsrq}dB{/if}
                </div>
              {/if}
            </div>

            <!-- Signal Strength -->
            <SignalStrength
              signal={modem.signal || 0}
              status={modem.status || 'offline'}
              compact={true}
              daemonConnected={daemonStatus.connected}
              isInitialLoad={isLoading}
            />
          </div>
        </button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .tech-card {
    @apply bg-gray-900 border border-gray-700 rounded-lg;
  }

  .cyber-input {
    @apply bg-gray-800 border border-gray-600 rounded text-gray-200;
    @apply focus:outline-none focus:border-gray-400;
  }

  .data-value {
    /* plain */
  }

  .high-contrast {
    @apply text-gray-100;
  }
</style>