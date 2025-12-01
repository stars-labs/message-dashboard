<script>
  import PhoneList from './PhoneList.svelte';
  import ModemList from './ModemList.svelte';
  import SimList from './SimList.svelte';

  export let devices = []; // Combined device_view data for compatibility
  export let modems = [];
  export let sims = [];
  export let selectedItem = null;
  export let selectedCountry = "all";
  export let searchTerm = "";
  export let onSelectItem = null;
  export let mobile = false;
  export let onSetIccidMapping = null;
  export let daemonStatus = { connected: false, lastDataUpdate: null };
  export let isLoading = false;

  // View modes
  let viewMode = 'devices'; // 'devices' | 'modems' | 'sims'

  // Selected items per view
  let selectedPhoneIccid = null;
  let selectedModemId = null;
  let selectedSimIccid = null;

  // Handle selection changes
  function handlePhoneSelect(phone) {
    selectedItem = phone;
    if (onSelectItem) onSelectItem(phone);
  }

  function handleModemSelect(modem) {
    selectedItem = modem;
    if (onSelectItem) onSelectItem(modem);
  }

  function handleSimSelect(sim) {
    selectedItem = sim;
    if (onSelectItem) onSelectItem(sim);
  }

  // Tab styles
  function getTabClass(isActive) {
    const base = "px-4 py-2 text-sm font-medium transition-all duration-200 relative";
    if (isActive) {
      return `${base} text-cyan-300 bg-cyan-900/30 border-b-2 border-cyan-400`;
    }
    return `${base} text-cyan-500 hover:text-cyan-300 hover:bg-cyan-900/20`;
  }

  // Get counts for each view
  $: deviceCount = devices.length;
  $: modemCount = modems.length;
  $: simCount = sims.length;
</script>

<div class="{mobile ? 'bg-black/90' : 'bg-black/80 border border-cyan-900/50 rounded-lg shadow-2xl'}">
  <!-- Tab Navigation -->
  <div class="flex border-b border-cyan-900/50">
    <button
      class={getTabClass(viewMode === 'devices')}
      on:click={() => viewMode = 'devices'}
    >
      <span class="flex items-center gap-2">
        <span>📱</span>
        <span>设备</span>
        <span class="px-1.5 py-0.5 bg-cyan-900/50 text-cyan-400 rounded text-xs">
          {deviceCount}
        </span>
      </span>
      {#if viewMode === 'devices'}
        <div class="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-cyan-400 to-transparent"></div>
      {/if}
    </button>

    <button
      class={getTabClass(viewMode === 'modems')}
      on:click={() => viewMode = 'modems'}
    >
      <span class="flex items-center gap-2">
        <span>📡</span>
        <span>调制解调器</span>
        <span class="px-1.5 py-0.5 bg-cyan-900/50 text-cyan-400 rounded text-xs">
          {modemCount}
        </span>
      </span>
      {#if viewMode === 'modems'}
        <div class="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-cyan-400 to-transparent"></div>
      {/if}
    </button>

    <button
      class={getTabClass(viewMode === 'sims')}
      on:click={() => viewMode = 'sims'}
    >
      <span class="flex items-center gap-2">
        <span>💳</span>
        <span>SIM 卡</span>
        <span class="px-1.5 py-0.5 bg-cyan-900/50 text-purple-400 rounded text-xs">
          {simCount}
        </span>
      </span>
      {#if viewMode === 'sims'}
        <div class="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-purple-400 to-transparent"></div>
      {/if}
    </button>

    <!-- View Mode Indicator -->
    <div class="ml-auto flex items-center px-4">
      <span class="text-xs text-cyan-500/60">
        {#if viewMode === 'devices'}
          传统视图 (兼容模式)
        {:else if viewMode === 'modems'}
          硬件视图
        {:else}
          身份视图
        {/if}
      </span>
    </div>
  </div>

  <!-- Content Area -->
  <div class="relative">
    {#if viewMode === 'devices'}
      <!-- Traditional Phone View (for backward compatibility) -->
      <PhoneList
        phoneNumbers={devices}
        bind:selectedPhoneIccid
        {selectedCountry}
        {searchTerm}
        onSelectPhone={handlePhoneSelect}
        {mobile}
        {onSetIccidMapping}
        {daemonStatus}
        {isLoading}
      />
    {:else if viewMode === 'modems'}
      <!-- Modem Hardware View -->
      <ModemList
        {modems}
        {sims}
        bind:selectedModemId
        {searchTerm}
        onSelectModem={handleModemSelect}
        {mobile}
        {daemonStatus}
        {isLoading}
      />
    {:else}
      <!-- SIM Card View -->
      <SimList
        {sims}
        {modems}
        bind:selectedSimIccid
        {selectedCountry}
        {searchTerm}
        onSelectSim={handleSimSelect}
        {mobile}
        onSetMapping={onSetIccidMapping}
        {isLoading}
      />
    {/if}

    <!-- View Transition Effect -->
    {#if !isLoading}
      <div class="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent animate-pulse"></div>
    {/if}
  </div>
</div>

<style>
  /* Tab hover effects */
  button:hover {
    text-shadow: 0 0 10px currentColor;
  }

  /* Active tab glow */
  button:has(+ .h-0\.5) {
    box-shadow: 0 2px 10px -2px rgba(34, 211, 238, 0.3);
  }
</style>