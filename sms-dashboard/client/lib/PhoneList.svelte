<script>
  import SignalStrength from "./SignalStrength.svelte";

  export let phoneNumbers = [];
  export const selectedPhone = null; // External reference only
  export let selectedPhoneIccid = null;
  export let selectedCountry = "all";
  export let searchTerm = "";
  export let onSelectPhone = null;
  export let mobile = false;
  export let onSetIccidMapping = null;
  export let daemonStatus = { connected: false, lastDataUpdate: null };
  export let isLoading = false;

  $: filteredPhones = phoneNumbers.filter((phone) => {
    const matchesCountry =
      selectedCountry === "all" || phone.country === selectedCountry;
    const matchesSearch =
      searchTerm === "" ||
      (phone.number && phone.number.includes(searchTerm)) ||
      (phone.carrier &&
        phone.carrier.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (phone.iccid &&
        phone.iccid.toLowerCase &&
        phone.iccid.toLowerCase().includes(searchTerm.toLowerCase()));
    return matchesCountry && matchesSearch;
  });

  const countries = [
    { code: "all", name: "全部", flag: "🌍" },
    { code: "CN", name: "中国", flag: "🇨🇳" },
    { code: "HK", name: "香港", flag: "🇭🇰" },
    { code: "SG", name: "新加坡", flag: "🇸🇬" },
  ];

  function getStatusColor(status) {
    switch (status) {
      case "online":
      case "active":
      case "registered":
      case "connected":
        return "bg-gradient-to-r from-green-400 to-green-500";
      case "offline":
        return "bg-gradient-to-r from-gray-400 to-gray-500";
      case "error":
        return "bg-gradient-to-r from-red-400 to-red-500";
      default:
        return "bg-gradient-to-r from-gray-400 to-gray-500";
    }
  }

  function handlePhoneClick(phone) {
    // Toggle selection - if clicking the same phone, unselect it
    if (selectedPhoneIccid === phone.iccid) {
      selectedPhoneIccid = null;
      if (onSelectPhone) {
        onSelectPhone(null);
      }
    } else {
      selectedPhoneIccid = phone.iccid;
      if (onSelectPhone) {
        onSelectPhone(phone);
      }
    }
  }

  function getEffectiveStatus(phone) {
    // During loading, trust the phone status if it exists
    if (isLoading && phone.status) {
      return phone.status;
    }

    if (!daemonStatus.connected) {
      return "unknown";
    }

    // If daemon is connected but no recent data update, show as stale
    if (daemonStatus.lastDataUpdate) {
      const timeSinceUpdate = Date.now() - daemonStatus.lastDataUpdate;
      if (timeSinceUpdate > 120000) {
        // 2 minutes
        return "stale";
      }
    }

    return phone.status || "offline";
  }
</script>

<div class={mobile ? "bg-white" : "glassmorphism rounded-2xl shadow-xl"}>
  <div class="p-4 {mobile ? 'border-b' : ''}">
    <h2
      class="text-lg font-bold bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text text-transparent mb-3"
    >
      号码列表
    </h2>

    <!-- Country Filter -->
    <div class="mb-3">
      <select
        bind:value={selectedCountry}
        class="w-full px-3 py-2 text-sm border border-purple-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white/50 backdrop-blur-sm"
      >
        {#each countries as country}
          <option value={country.code}>
            {country.flag}
            {country.name}
          </option>
        {/each}
      </select>
    </div>

    <!-- Search -->
    <div class="mb-3">
      <input
        type="text"
        bind:value={searchTerm}
        placeholder="搜索号码或运营商..."
        class="w-full px-3 py-2 text-sm border border-purple-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white/50 backdrop-blur-sm"
      />
    </div>

    <div class="flex items-center justify-between">
      <div class="text-sm font-medium text-purple-600">
        共 {filteredPhones.length} 个号码
      </div>
      <div class="text-xs text-gray-500 flex items-center gap-3">
        <span class="flex items-center gap-1">
          <span class="w-2 h-2 bg-gray-900 rounded-full"></span>
          原始号码
        </span>
        <span class="flex items-center gap-1">
          <svg class="w-3 h-3 text-purple-600" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
          </svg>
          <span class="text-purple-600">映射号码</span>
        </span>
      </div>
    </div>
  </div>

  <!-- Phone List -->
  <div class="{mobile ? '' : 'max-h-[600px]'} overflow-y-auto">
    {#if isLoading}
      <!-- Loading skeleton -->
      {#each [1, 2, 3, 4, 5] as index}
        <div class="w-full p-3 border-b">
          <div class="animate-pulse">
            <div class="flex items-center justify-between">
              <div class="flex-1">
                <div class="flex items-center gap-2">
                  <div class="w-6 h-6 bg-gray-200 rounded"></div>
                  <div class="h-4 bg-gray-200 rounded w-32"></div>
                </div>
                <div class="h-3 bg-gray-200 rounded w-48 mt-2"></div>
              </div>
              <div class="flex gap-0.5 items-end">
                {#each [1, 2, 3, 4] as bar}
                  <div
                    class="w-1 bg-gray-200 rounded-sm"
                    style="height: {4 + bar * 3}px"
                  ></div>
                {/each}
              </div>
            </div>
          </div>
        </div>
      {/each}
    {:else if filteredPhones.length === 0}
      <div class="p-4 text-center text-gray-500">
        <svg
          class="w-12 h-12 mx-auto mb-2 text-gray-300"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
          />
        </svg>
        <p class="text-sm">暂无设备</p>
      </div>
    {:else}
      {#each filteredPhones as phone}
        <button
          class="w-full p-3 border-b hover:bg-purple-50 active:bg-purple-100 transition-all duration-300 text-left {selectedPhoneIccid ===
          phone.iccid
            ? 'bg-gradient-to-r from-purple-50 to-indigo-50 border-l-4 border-l-purple-500'
            : 'hover:border-l-4 hover:border-l-purple-200'}"
          on:click={() => handlePhoneClick(phone)}
        >
          <div class="flex items-center justify-between">
            <div class="flex-1">
              <div class="flex items-center gap-2">
                <span class="text-lg">{phone.flag || "📱"}</span>
                {#if phone.number}
                  {#if phone.mapped_number}
                    <span class="font-medium text-purple-600 text-sm flex items-center gap-1">
                      <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                      </svg>
                      {phone.number}
                    </span>
                  {:else}
                    <span class="font-medium text-gray-900 text-sm">
                      {phone.number}
                    </span>
                  {/if}
                {:else}
                  <span
                    class="font-medium text-orange-600 text-sm flex items-center gap-1"
                  >
                    <svg
                      class="w-4 h-4"
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
                    未设置号码
                  </span>
                  {#if phone.iccid && onSetIccidMapping}
                    <span
                      class="text-xs bg-orange-500 hover:bg-orange-600 text-white px-2 py-1 rounded transition-colors cursor-pointer"
                      on:click|stopPropagation={() => onSetIccidMapping(phone)}
                      on:keydown|stopPropagation={(e) =>
                        e.key === "Enter" && onSetIccidMapping(phone)}
                      role="button"
                      tabindex="0"
                    >
                      设置映射
                    </span>
                  {/if}
                {/if}
                {#if selectedPhoneIccid === phone.iccid}
                  <span class="text-purple-600 text-xs font-semibold ml-1"
                    >✓</span
                  >
                {/if}
              </div>
              <div class="text-xs text-gray-600 mt-0.5">
                {#if phone.carrier}
                  <span class="font-medium">{phone.carrier}</span>
                {/if}
                {#if phone.operator_name}
                  <span class="text-gray-500"> • {phone.operator_name}</span>
                {/if}
                {#if phone.iccid && phone.iccid.length > 15}
                  <!-- ICCID (long numeric string) -->
                  <span class="text-gray-500 font-mono">
                    • {phone.iccid.slice(0, 6)}...{phone.iccid.slice(-4)}</span
                  >
                {:else if phone.iccid}
                  <!-- Shorter ICCID -->
                  <span class="text-purple-600"> • {phone.iccid}</span>
                {/if}
                {#if phone.modem_index != null || phone.sim_index != null}
                  <span class="text-indigo-600 font-medium">
                    {#if phone.modem_index != null}
                      • M{phone.modem_index}
                    {/if}
                    {#if phone.sim_index != null}
                      /S{phone.sim_index}
                    {/if}
                  </span>
                {/if}
              </div>
            </div>
            <SignalStrength
              signal={phone.signal || 0}
              status={getEffectiveStatus(phone)}
              compact={true}
              daemonConnected={daemonStatus.connected}
              isInitialLoad={isLoading}
            />
          </div>
          {#if phone.lastActive && !mobile}
            <div class="text-xs text-gray-400 mt-1">
              最后活跃: {new Date(phone.lastActive).toLocaleString("zh-CN")}
            </div>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
</div>
