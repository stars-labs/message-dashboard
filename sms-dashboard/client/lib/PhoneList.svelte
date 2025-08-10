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

  // Helper function to infer country code from phone number
  function inferCountryFromNumber(phone) {
    // First check if phone has explicit country from ICCID mapping or database
    if (phone.country || phone.mapped_country) {
      return phone.country || phone.mapped_country;
    }

    // Otherwise, try to infer from phone number
    if (!phone.number) return null;
    
    const number = phone.number.toString();
    
    // China (+86)
    if (number.startsWith("86") || number.startsWith("+86") || 
        (number.startsWith("1") && number.length === 11)) {
      return "CN";
    }
    
    // Hong Kong (+852)
    if (number.startsWith("852") || number.startsWith("+852") || 
        number.startsWith("00852")) {
      return "HK";
    }
    
    // Singapore (+65)
    if (number.startsWith("65") || number.startsWith("+65") || 
        (number.length === 8 && (number.startsWith("8") || number.startsWith("9")))) {
      return "SG";
    }
    
    // USA (+1) - be careful as +1 is shared by many countries
    if (number.startsWith("+1") || (number.length === 10 && !number.startsWith("1"))) {
      return "US";
    }
    
    // Japan (+81)
    if (number.startsWith("81") || number.startsWith("+81")) {
      return "JP";
    }
    
    // Korea (+82)
    if (number.startsWith("82") || number.startsWith("+82")) {
      return "KR";
    }
    
    // Malaysia (+60)
    if (number.startsWith("60") || number.startsWith("+60")) {
      return "MY";
    }
    
    // Thailand (+66)
    if (number.startsWith("66") || number.startsWith("+66")) {
      return "TH";
    }
    
    return null;
  }

  $: filteredPhones = phoneNumbers
    .filter((phone) => {
      // Get the effective country (explicit or inferred)
      const effectiveCountry = inferCountryFromNumber(phone);
      
      // Debug logging for filter matching
      const matchesCountry =
        selectedCountry === "all" || 
        effectiveCountry === selectedCountry;
      
      const searchLower = searchTerm.toLowerCase();
      const matchesSearch =
        searchTerm === "" ||
        (phone.number && phone.number.toString().toLowerCase().includes(searchLower)) ||
        (phone.carrier && 
          phone.carrier.toLowerCase().includes(searchLower)) ||
        (phone.iccid && 
          phone.iccid.toLowerCase().includes(searchLower)) ||
        (phone.operator_name && 
          phone.operator_name.toLowerCase().includes(searchLower)) ||
        (phone.mapped_number && 
          phone.mapped_number.toString().toLowerCase().includes(searchLower)) ||
        (phone.mapped_carrier && 
          phone.mapped_carrier.toLowerCase().includes(searchLower));
          
      // Log first few phones for debugging
      if (phoneNumbers.indexOf(phone) < 3) {
        console.log('[PhoneList] Filter debug:', {
          phone: {
            iccid: phone.iccid,
            country: phone.country,
            mapped_country: phone.mapped_country,
            effectiveCountry: effectiveCountry,
            number: phone.number,
            carrier: phone.carrier
          },
          selectedCountry,
          searchTerm,
          matchesCountry,
          matchesSearch,
          willShow: matchesCountry && matchesSearch
        });
      }
          
      return matchesCountry && matchesSearch;
    });

  const countries = [
    { code: "all", name: "全部", flag: "🌍" },
    { code: "CN", name: "中国", flag: "🇨🇳" },
    { code: "HK", name: "香港", flag: "🇭🇰" },
    { code: "SG", name: "新加坡", flag: "🇸🇬" },
  ];

  // Debug: Log unique countries found in phone data
  $: {
    if (phoneNumbers.length > 0) {
      const uniqueCountries = [...new Set(phoneNumbers.map(p => p.country).filter(Boolean))];
      const uniqueMappedCountries = [...new Set(phoneNumbers.map(p => p.mapped_country).filter(Boolean))];
      const uniqueInferredCountries = [...new Set(phoneNumbers.map(p => inferCountryFromNumber(p)).filter(Boolean))];
      console.log('[PhoneList] Available countries in data:', {
        dbCountries: uniqueCountries,
        mappedCountries: uniqueMappedCountries,
        inferredCountries: uniqueInferredCountries,
        totalPhones: phoneNumbers.length,
        filteredCount: filteredPhones.length,
        selectedCountry
      });
    }
  }

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

<div class="{mobile ? 'bg-black/90' : 'tech-card'}">
  <div class="p-3 lg:p-4 {mobile ? 'border-b border-cyan-900/30' : ''}">
    <h2
      class="text-base lg:text-lg font-bold data-value high-contrast mb-3 header-effect-target"
    >
      号码列表
    </h2>

    <!-- Country Filter -->
    <div class="mb-3">
      <select
        bind:value={selectedCountry}
        class="w-full px-3 py-2 text-sm cyber-input"
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
        class="w-full px-3 py-2 text-sm cyber-input placeholder-cyan-600"
      />
    </div>

    <div class="flex items-center justify-between">
      <div class="text-sm font-bold text-cyan-300 tech-text">
        共 <span class="data-value text-base high-contrast">{filteredPhones.length}</span> 个号码
      </div>
      <div class="text-xs text-cyan-400/60 flex items-center gap-3">
        <span class="flex items-center gap-1">
          <span class="w-2 h-2 bg-cyan-400 rounded-full shadow-lg shadow-cyan-400/50"></span>
          原始号码
        </span>
        <span class="flex items-center gap-1">
          <svg class="w-3 h-3 text-purple-400" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
          </svg>
          <span class="text-purple-400">映射号码</span>
        </span>
      </div>
    </div>
  </div>

  <!-- Phone List -->
  <div class="{mobile ? '' : 'max-h-[calc(100vh-400px)]'} overflow-y-auto">
    {#if isLoading}
      <!-- Loading skeleton -->
      {#each [1, 2, 3, 4, 5] as index}
        <div class="w-full p-3 border-b">
          <div class="animate-pulse">
            <div class="flex items-center justify-between">
              <div class="flex-1">
                <div class="flex items-center gap-2">
                  <div class="w-6 h-6 bg-cyan-900/30 rounded"></div>
                  <div class="h-4 bg-cyan-900/30 rounded w-32"></div>
                </div>
                <div class="h-3 bg-cyan-900/30 rounded w-48 mt-2"></div>
              </div>
              <div class="flex gap-0.5 items-end">
                {#each [1, 2, 3, 4] as bar}
                  <div
                    class="w-1 bg-cyan-900/30 rounded-sm"
                    style="height: {Number.isFinite(bar) ? 4 + bar * 3 : 4}px"
                  ></div>
                {/each}
              </div>
            </div>
          </div>
        </div>
      {/each}
    {:else if filteredPhones.length === 0}
      <div class="p-4 text-center text-cyan-400/60">
        <svg
          class="w-12 h-12 mx-auto mb-2 text-cyan-600/30"
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
          <p class="text-sm text-red-400 mb-2">无法加载设备数据</p>
          <p class="text-xs text-gray-500">请检查网络连接或重新登录</p>
        {:else}
          <p class="text-sm">无匹配的设备</p>
          <p class="text-xs text-gray-500">尝试调整筛选条件</p>
        {/if}
      </div>
    {:else}
      {#each filteredPhones as phone}
        <button
          class="w-full p-3 border-b border-cyan-900/30 hover:bg-cyan-900/20 active:bg-cyan-900/30 transition-all duration-300 text-left relative {selectedPhoneIccid ===
          phone.iccid
            ? 'phone-selected'
            : 'hover:border-l-4 hover:border-l-cyan-700'}"
          on:click={() => handlePhoneClick(phone)}
        >
          {#if selectedPhoneIccid === phone.iccid}
            <!-- VIP effects -->
            <div class="vip-sparkle top-left"></div>
            <div class="vip-sparkle top-right"></div>
            <div class="vip-sparkle bottom-left"></div>
            <div class="vip-sparkle bottom-right"></div>
            <div class="lightning-effect"></div>
            <div class="particle"></div>
            <div class="particle"></div>
            <div class="particle"></div>
            <div class="particle"></div>
            <div class="particle"></div>
            <div class="vip-badge">已选中</div>
          {/if}
          <div class="flex items-center justify-between">
            <div class="flex-1">
              <div class="flex items-center gap-2">
                <span class="text-lg">{phone.flag || "📱"}</span>
                {#if phone.number}
                  {#if phone.mapped_number}
                    <span class="font-medium text-purple-400 text-sm flex items-center gap-1 tech-text">
                      <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                      </svg>
                      {phone.number}
                    </span>
                  {:else}
                    <span class="font-medium text-cyan-300 text-sm tech-text">
                      {phone.number}
                    </span>
                  {/if}
                {:else}
                  <span
                    class="font-medium text-orange-400 text-sm flex items-center gap-1 tech-text"
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
              </div>
              <div class="text-xs text-cyan-400/70 mt-0.5">
                {#if phone.carrier}
                  <span class="font-bold text-cyan-300">{phone.carrier}</span>
                {/if}
                {#if phone.operator_name}
                  <span class="text-cyan-500/60"> • {phone.operator_name}</span>
                {/if}
                {#if phone.iccid && phone.iccid.length > 15}
                  <!-- ICCID (long numeric string) -->
                  <span class="text-cyan-500/60 font-mono">
                    • {phone.iccid.slice(0, 6)}...{phone.iccid.slice(-4)}</span
                  >
                {:else if phone.iccid}
                  <!-- Shorter ICCID -->
                  <span class="text-purple-400"> • {phone.iccid}</span>
                {/if}
                {#if phone.modem_index != null || phone.sim_index != null}
                  <span class="text-indigo-400 font-medium">
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
            <div class="text-xs text-cyan-600/50 mt-1">
              最后活跃: {new Date(phone.lastActive).toLocaleString("zh-CN")}
            </div>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
</div>

