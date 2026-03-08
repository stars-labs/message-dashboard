<script>
  import SignalStrength from "./SignalStrength.svelte";
  import { COUNTRY_FILTER_TABS, inferCountryFromNumber } from "./countries.js";

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
  export let showSimMissing = true; // Toggle to show/hide modems without SIM cards

  // Helper function to check if device has SIM card issues
  function hasSimIssue(phone) {
    return phone.status === 'sim-missing' || (!phone.iccid && !phone.number);
  }

  // Helper function to get display identifier for device
  function getDeviceIdentifier(phone) {
    if (hasSimIssue(phone)) {
      return phone.equipment_id || phone.imei || `设备-${phone.modem_index || 'Unknown'}`;
    }
    return phone.number || phone.iccid;
  }

  $: filteredPhones = phoneNumbers
    .filter((phone) => {
      // Filter by SIM status first
      const isSimMissing = hasSimIssue(phone);
      if (isSimMissing && !showSimMissing) {
        return false;
      }
      
      // Get the effective country (explicit or inferred) - skip for sim-missing devices
      const effectiveCountry = isSimMissing ? null : inferCountryFromNumber(phone);

      // Country filter: sim-missing devices only show in "all", not in specific country tabs
      const matchesCountry =
        selectedCountry === "all" ||
        effectiveCountry === selectedCountry;
      
      const searchLower = searchTerm.toLowerCase();
      const deviceId = getDeviceIdentifier(phone);
      const matchesSearch =
        searchTerm === "" ||
        (deviceId && deviceId.toString().toLowerCase().includes(searchLower)) ||
        (phone.number && phone.number.toString().toLowerCase().includes(searchLower)) ||
        (phone.carrier && 
          phone.carrier.toLowerCase().includes(searchLower)) ||
        (phone.iccid && 
          phone.iccid.toLowerCase().includes(searchLower)) ||
        (phone.operator_name && 
          phone.operator_name.toLowerCase().includes(searchLower)) ||
        (phone.equipment_id &&
          phone.equipment_id.toLowerCase().includes(searchLower));

      return matchesCountry && matchesSearch;
    });

  function getStatusColor(status) {
    switch (status) {
      case "online":
      case "active":
      case "registered":
      case "connected":
        return "bg-emerald-500";
      case "sim-missing":
        return "bg-orange-500";
      case "offline":
        return "bg-stone-400";
      case "error":
        return "bg-red-500";
      default:
        return "bg-stone-400";
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

<div class="bg-white border border-stone-200/80 rounded-xl flex flex-col h-full min-h-0" style="box-shadow: 0 1px 3px rgba(28,25,23,0.06);">
  <div class="p-4 border-b border-stone-200 flex-shrink-0">
    <h2
      class="text-base lg:text-lg font-bold data-value high-contrast mb-3 header-effect-target"
    >
      号码列表
    </h2>

    <!-- Country Filter + Device Count -->
    <div class="mb-3 flex items-center justify-between">
      <select
        bind:value={selectedCountry}
        class="w-1/2 px-3 py-2 text-sm cyber-input shrink-0"
      >
        {#each COUNTRY_FILTER_TABS as country}
          <option value={country.code}>
            {country.flag}
            {country.name}
          </option>
        {/each}
      </select>
      <span class="text-sm text-stone-500">
        共 <span class="font-mono font-bold text-stone-900">{filteredPhones.length}</span> 个设备
      </span>
    </div>

    <!-- Search -->
    <div class="mb-3">
      <input
        type="text"
        bind:value={searchTerm}
        placeholder="搜索号码或运营商..."
        class="w-full px-3 py-2 text-sm cyber-input"
      />
    </div>

    <!-- SIM Missing Filter Toggle -->
    <div class="mb-3">
      <label class="flex items-center gap-2 text-sm text-stone-600">
        <input
          type="checkbox"
          bind:checked={showSimMissing}
          class="accent-orange-500"
        />
        <span>显示需要SIM卡的设备</span>
        {#if phoneNumbers.filter(hasSimIssue).length > 0}
          <span class="px-2 py-1 bg-orange-50 text-orange-600 rounded-full text-xs font-medium border border-orange-200">
            {phoneNumbers.filter(hasSimIssue).length} 个设备
          </span>
        {/if}
      </label>
    </div>

  </div>

  <!-- Phone List -->
  <div class="flex-1 min-h-0 overflow-y-auto">
    {#if isLoading}
      <!-- Loading skeleton -->
      {#each [1, 2, 3, 4, 5] as index}
        <div class="w-full p-3 border-b">
          <div class="animate-pulse">
            <div class="flex items-center justify-between">
              <div class="flex-1">
                <div class="flex items-center gap-2">
                  <div class="w-6 h-6 bg-stone-200 rounded"></div>
                  <div class="h-4 bg-stone-200 rounded w-32"></div>
                </div>
                <div class="h-3 bg-stone-200 rounded w-48 mt-2"></div>
              </div>
              <div class="flex gap-0.5 items-end">
                {#each [1, 2, 3, 4] as bar}
                  <div
                    class="w-1 bg-stone-200 rounded-sm"
                    style="height: {Number.isFinite(bar) ? 4 + bar * 3 : 4}px"
                  ></div>
                {/each}
              </div>
            </div>
          </div>
        </div>
      {/each}
    {:else if filteredPhones.length === 0}
      <div class="p-4 text-center text-stone-400">
        <svg
          class="w-12 h-12 mx-auto mb-2 text-stone-300"
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
        {#if phoneNumbers.length === 0}
          <p class="text-sm text-red-500 mb-2">无法加载设备数据</p>
          <p class="text-xs text-stone-400">请检查网络连接或重新登录</p>
        {:else}
          <p class="text-sm">无匹配的设备</p>
          <p class="text-xs text-stone-400">尝试调整筛选条件</p>
        {/if}
      </div>
    {:else}
      {#each filteredPhones as phone}
        <button
          class="w-full p-3 border-b border-stone-200 hover:bg-stone-50 active:bg-stone-100 transition-all duration-150 text-left relative {selectedPhoneIccid ===
          phone.iccid
            ? 'phone-selected'
            : 'hover:border-l-4 hover:border-l-stone-400'}"
          on:click={() => handlePhoneClick(phone)}
        >
          <div class="flex items-center justify-between">
            <div class="flex-1">
              <div class="flex items-center gap-2">
                {#if hasSimIssue(phone)}
                  <!-- Modem without SIM card -->
                  <span class="text-lg">📵</span>
                  <span class="font-medium text-orange-600 text-sm flex items-center gap-1 tech-text">
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
                    {getDeviceIdentifier(phone)}
                  </span>
                  <span class="px-2 py-1 bg-red-50 text-red-600 rounded-full text-xs font-medium border border-red-200 sim-missing-badge">
                    需要SIM卡
                  </span>
                {:else}
                  <!-- Normal phone with SIM -->
                  <span class="text-lg">{phone.flag || "📱"}</span>
                  {#if phone.number}
                      <span class="font-medium text-stone-800 text-sm tech-text">
                        {phone.number}
                      </span>
                  {:else}
                    <span
                      class="font-medium text-orange-600 text-sm flex items-center gap-1 tech-text"
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
                        class="text-xs tech-button px-2 py-1 cursor-pointer"
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
                {/if}
              </div>
              <div class="text-xs text-stone-400 mt-0.5">
                {#if hasSimIssue(phone)}
                  <!-- Modem without SIM - show hardware details -->
                  {#if phone.equipment_id}
                    <span class="text-orange-600 font-mono">
                      IMEI: {phone.equipment_id.slice(0, 8)}...{phone.equipment_id.slice(-4)}
                    </span>
                  {/if}
                  {#if phone.manufacturer || phone.model}
                    <span class="text-stone-500">
                      • {phone.manufacturer || ''} {phone.model || ''}
                    </span>
                  {/if}
                  {#if phone.modem_index != null}
                    <span class="text-indigo-600 font-medium">
                      • 设备{phone.modem_index}
                    </span>
                  {/if}
                  <span class="text-red-500">
                    • 请插入SIM卡
                  </span>
                {:else}
                  <!-- Normal phone with SIM -->
                  {#if phone.carrier}
                    <span class="font-bold text-stone-700">{phone.carrier}</span>
                  {/if}
                  {#if phone.operator_name && phone.operator_name !== phone.carrier}
                    {@const dedupedOperator = [...new Set(phone.operator_name.split(/\s+/))].join(' ')}
                    {#if dedupedOperator !== phone.carrier}
                      <span class="text-stone-500"> • {dedupedOperator}</span>
                    {/if}
                  {/if}
                  {#if phone.iccid}
                    <span class="text-stone-400 font-mono iccid-display" title={phone.iccid}>
                      • <span class="iccid-full">{phone.iccid}</span><span class="iccid-short">{phone.iccid.slice(0, 6)}...{phone.iccid.slice(-4)}</span>
                    </span>
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
            <div class="text-xs text-stone-400 mt-1">
              最后活跃: {new Date(phone.lastActive).toLocaleString("zh-CN")}
            </div>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
</div>

<style>
  /* Show truncated ICCID by default, full on wider screens */
  .iccid-full { display: none; }
  .iccid-short { display: inline; }

  @media (min-width: 1280px) {
    .iccid-full { display: inline; }
    .iccid-short { display: none; }
  }
</style>
