<script>
  export let sims = [];
  export let modems = [];
  export let selectedSimIccid = null;
  export let selectedCountry = "all";
  export let searchTerm = "";
  export let onSelectSim = null;
  export let mobile = false;
  export let onSetMapping = null;
  export let isLoading = false;
  export let showUnassigned = true;

  // Helper to find modem for a SIM
  function findModemForSim(sim) {
    return modems.find(m => m.equipment_id === sim.current_modem_id);
  }

  // Helper to infer country from phone number
  function inferCountryFromNumber(number) {
    if (!number) return null;

    const num = number.toString();

    // China (+86)
    if (num.startsWith("86") || num.startsWith("+86") ||
        (num.startsWith("1") && num.length === 11)) {
      return "CN";
    }

    // Hong Kong (+852)
    if (num.startsWith("852") || num.startsWith("+852")) {
      return "HK";
    }

    // Singapore (+65)
    if (num.startsWith("65") || num.startsWith("+65") ||
        (num.length === 8 && (num.startsWith("8") || num.startsWith("9")))) {
      return "SG";
    }

    return null;
  }

  // Filter SIMs
  $: filteredSims = sims.filter(sim => {
    // Filter by assignment status
    const isUnassigned = !sim.current_modem_id;
    if (isUnassigned && !showUnassigned) {
      return false;
    }

    // Filter by country
    const country = inferCountryFromNumber(sim.phone_number);
    if (selectedCountry !== "all" && country !== selectedCountry) {
      return false;
    }

    // Filter by search
    const searchLower = searchTerm.toLowerCase();
    if (searchTerm === "") return true;

    const modem = findModemForSim(sim);

    return (
      (sim.iccid && sim.iccid.toLowerCase().includes(searchLower)) ||
      (sim.phone_number && sim.phone_number.toLowerCase().includes(searchLower)) ||
      (sim.operator_name && sim.operator_name.toLowerCase().includes(searchLower)) ||
      (modem && modem.equipment_id && modem.equipment_id.toLowerCase().includes(searchLower))
    );
  });

  const countries = [
    { code: "all", name: "全部", flag: "🌍" },
    { code: "CN", name: "中国", flag: "🇨🇳" },
    { code: "HK", name: "香港", flag: "🇭🇰" },
    { code: "SG", name: "新加坡", flag: "🇸🇬" },
  ];

  function handleSimClick(sim) {
    if (selectedSimIccid === sim.iccid) {
      selectedSimIccid = null;
      if (onSelectSim) onSelectSim(null);
    } else {
      selectedSimIccid = sim.iccid;
      if (onSelectSim) onSelectSim(sim);
    }
  }

  function formatIccid(iccid) {
    if (!iccid || iccid.length < 10) return iccid;
    return `${iccid.slice(0, 6)}...${iccid.slice(-4)}`;
  }

  function getCountryFlag(number) {
    const country = inferCountryFromNumber(number);
    switch (country) {
      case "CN": return "🇨🇳";
      case "HK": return "🇭🇰";
      case "SG": return "🇸🇬";
      default: return "🌏";
    }
  }

  function getStatusColor(sim) {
    if (!sim.current_modem_id) return "text-gray-500";
    if (sim.status === "active") return "text-green-400";
    if (sim.status === "inactive") return "text-yellow-400";
    return "text-gray-400";
  }
</script>

<div class="{mobile ? 'bg-gray-900' : 'tech-card'}">
  <div class="p-3 lg:p-4 {mobile ? 'border-b border-gray-700' : ''}">
    <h2 class="text-base lg:text-lg font-bold data-value high-contrast mb-3">
      SIM 卡列表
    </h2>

    <!-- Country Filter -->
    <div class="mb-3">
      <select
        bind:value={selectedCountry}
        class="w-full px-3 py-2 text-sm cyber-input"
      >
        {#each countries as country}
          <option value={country.code}>
            {country.flag} {country.name}
          </option>
        {/each}
      </select>
    </div>

    <!-- Search -->
    <div class="mb-3">
      <input
        type="text"
        bind:value={searchTerm}
        placeholder="搜索号码、ICCID 或运营商..."
        class="w-full px-3 py-2 text-sm cyber-input placeholder-gray-500"
      />
    </div>

    <!-- Unassigned Filter -->
    <div class="mb-3">
      <label class="flex items-center gap-2 text-sm text-gray-400">
        <input
          type="checkbox"
          bind:checked={showUnassigned}
          class="accent-blue-400"
        />
        <span>显示未分配的 SIM 卡</span>
      </label>
    </div>

    <div class="flex items-center justify-between">
      <div class="text-sm font-bold text-gray-200">
        共 <span class="data-value text-base high-contrast">{filteredSims.length}</span> 张 SIM 卡
      </div>
      <div class="text-xs text-gray-400/60 flex items-center gap-2">
        <span class="flex items-center gap-1">
          <span class="w-2 h-2 bg-green-400 rounded-full"></span>
          已插入
        </span>
        <span class="flex items-center gap-1">
          <span class="w-2 h-2 bg-gray-400 rounded-full"></span>
          未插入
        </span>
      </div>
    </div>
  </div>

  <!-- SIM List -->
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
    {:else if filteredSims.length === 0}
      <div class="p-4 text-center text-gray-400/60">
        <p class="text-sm">无匹配的 SIM 卡</p>
      </div>
    {:else}
      {#each filteredSims as sim}
        {@const modem = findModemForSim(sim)}
        <button
          class="w-full p-3 border-b border-gray-700 hover:bg-gray-700 transition-all text-left
                 {selectedSimIccid === sim.iccid ? 'bg-gray-700/50 border-l-4 border-l-purple-400' : ''}"
          on:click={() => handleSimClick(sim)}
        >
          <div class="flex items-start justify-between">
            <div class="flex-1">
              <!-- SIM Info -->
              <div class="flex items-center gap-2 mb-1">
                <span class="text-lg">{getCountryFlag(sim.phone_number)}</span>
                {#if sim.phone_number}
                  <span class="font-medium text-gray-200 text-sm">
                    {sim.phone_number}
                  </span>
                {:else}
                  <span class="font-medium text-orange-400 text-sm">
                    未设置号码
                  </span>
                  {#if onSetMapping}
                    <button
                      class="text-xs tech-button px-2 py-1"
                      on:click|stopPropagation={() => onSetMapping(sim)}
                    >
                      设置映射
                    </button>
                  {/if}
                {/if}
                <span class={getStatusColor(sim)}>
                  ●
                </span>
              </div>

              <!-- Carrier & ICCID -->
              <div class="text-xs text-gray-400/70">
                {#if sim.operator_name}
                  <span class="font-bold text-gray-200">{sim.operator_name}</span>
                {/if}
                <span class="font-mono text-gray-500">
                  • {formatIccid(sim.iccid)}
                </span>
              </div>

              <!-- Modem Assignment -->
              {#if modem}
                <div class="mt-1 flex items-center gap-2">
                  <span class="text-xs px-2 py-0.5 bg-green-900/30 text-green-400 rounded">
                    插入设备 #{modem.modem_index || 'N/A'}
                  </span>
                  <span class="text-xs text-gray-500">
                    {modem.manufacturer || ''} {modem.model || ''}
                  </span>
                </div>
              {:else}
                <div class="mt-1">
                  <span class="text-xs px-2 py-0.5 bg-gray-900/30 text-gray-400 rounded">
                    未插入设备
                  </span>
                </div>
              {/if}

              <!-- User Overrides if any -->
              {#if sim.user_phone_number || sim.user_carrier}
                <div class="mt-1 p-1 bg-purple-900/20 rounded">
                  <div class="flex items-center gap-1 text-xs text-purple-400">
                    <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fill-rule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                    </svg>
                    <span>用户映射:</span>
                    {#if sim.user_phone_number}
                      <span>{sim.user_phone_number}</span>
                    {/if}
                    {#if sim.user_carrier}
                      <span>• {sim.user_carrier}</span>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>

            <!-- Status Indicator -->
            <div class="flex flex-col items-center">
              {#if sim.current_modem_id}
                <span class="text-xs text-green-400">已插入</span>
              {:else}
                <span class="text-xs text-gray-500">未插入</span>
              {/if}
              {#if sim.sim_index != null}
                <span class="text-xs text-indigo-400 mt-1">
                  S{sim.sim_index}
                </span>
              {/if}
            </div>
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

  .tech-button {
    @apply bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors;
  }

  .data-value {
    /* plain */
  }

  .high-contrast {
    @apply text-gray-100;
  }
</style>