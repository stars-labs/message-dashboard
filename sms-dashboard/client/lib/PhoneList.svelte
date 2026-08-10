<script>
  import SignalStrength from "./SignalStrength.svelte";
  import { COUNTRY_FILTER_TABS, inferCountryFromNumber } from "./countries.js";
  import { getStatusMeta, isAnomalous } from "./device-status.js";
  import { formatCardNumber } from "./card-number.js";

  let {
    phoneNumbers = [],
    selectedPhone = null,
    selectedPhoneIccid = $bindable(null),
    selectedCountry = $bindable("all"),
    searchTerm = $bindable(""),
    onSelectPhone = null,
    mobile = false,
    onSetIccidMapping = null,
    daemonStatus = { connected: false, lastDataUpdate: null },
    isLoading = false,
  } = $props();

  // Debounced local search: the parent bind:searchTerm is updated after 200 ms
  // so the full list re-filter only runs when the user pauses.
  let searchInput = $state(searchTerm);
  let debounceTimer;
  function handleSearchInput(e) {
    searchInput = e.target.value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { searchTerm = searchInput; }, 200);
  }

  // Status filter chips: all / online / anomaly
  let statusChip = $state('all'); // 'all' | 'online' | 'error'

  let filteredPhones = $derived(
    phoneNumbers
      .filter((phone) => {
        const effectiveCountry = inferCountryFromNumber(phone);
        const matchesCountry = selectedCountry === 'all' || effectiveCountry === selectedCountry;

        const q = searchTerm.trim().toLowerCase();
        const matchesSearch = !q ||
          String(phone.sim_index ?? '').includes(q) ||
          (phone.number && phone.number.toLowerCase().includes(q)) ||
          (phone.carrier && phone.carrier.toLowerCase().includes(q)) ||
          (phone.iccid && phone.iccid.toLowerCase().includes(q)) ||
          (phone.operator_name && phone.operator_name.toLowerCase().includes(q));

        const matchesChip =
          statusChip === 'all' ||
          (statusChip === 'online' && phone.status === 'active') ||
          (statusChip === 'error' && isAnomalous(phone.status));

        return matchesCountry && matchesSearch && matchesChip;
      })
      // Anomalous cards sort to the top within any filter.
      .sort((a, b) => {
        const ao = getStatusMeta(a.status).sortOrder;
        const bo = getStatusMeta(b.status).sortOrder;
        if (ao !== bo) return ao - bo;
        return (a.sim_index ?? 999) - (b.sim_index ?? 999);
      })
  );

  // Status chip counts — always computed from the full list (not filteredPhones)
  // so the badge numbers don't change when a chip is selected.
  let onlineCount  = $derived(phoneNumbers.filter(p => p.status === 'active').length);
  let errorCount   = $derived(phoneNumbers.filter(p => isAnomalous(p.status)).length);

  // Highlight query matches in a string: wrap hits with <mark>.
  // The returned string is safe to pass to {@html} because it only
  // wraps user-supplied text in a known-safe tag with no attributes.
  function highlight(text, q) {
    if (!q || !text) return text || '';
    const safe = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`(${safe})`, 'gi'), '<mark class="bg-[#fed7aa] rounded-[2px]">$1</mark>');
  }

  function handlePhoneClick(phone) {
    if (selectedPhoneIccid === phone.iccid) {
      selectedPhoneIccid = null;
      onSelectPhone?.(null);
    } else {
      selectedPhoneIccid = phone.iccid;
      onSelectPhone?.(phone);
    }
  }
</script>

<div class="bg-white border border-stone-200/80 rounded-xl flex flex-col h-full min-h-0"
  style="box-shadow: 0 1px 3px rgba(28,25,23,0.06);">

  <!-- Header: search + filter chips -->
  <div class="p-3 border-b border-stone-200 flex-shrink-0 space-y-2">

    <!-- Search -->
    <div class="relative">
      <svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400 pointer-events-none"
        fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round"
          d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
      </svg>
      <input
        type="text"
        value={searchInput}
        oninput={handleSearchInput}
        placeholder="卡号 / 号码 / 运营商 / ICCID"
        class="w-full pl-8 pr-3 py-1.5 text-sm bg-stone-50 border border-stone-200 rounded-lg
          focus:outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100 transition-colors"
      />
    </div>

    <!-- Status chips -->
    <div class="flex items-center gap-1.5">
      <button
        onclick={() => { statusChip = 'all'; }}
        class="px-2.5 py-1 text-xs rounded-md font-medium transition-colors
          {statusChip === 'all'
            ? 'bg-stone-800 text-white'
            : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}"
      >全部 <span class="font-mono tabular-nums">{phoneNumbers.length}</span></button>
      <button
        onclick={() => { statusChip = 'online'; }}
        class="px-2.5 py-1 text-xs rounded-md font-medium transition-colors
          {statusChip === 'online'
            ? 'bg-stone-800 text-white'
            : 'bg-stone-50 border border-stone-200 text-stone-500 hover:bg-stone-100'}"
      >在线 <span class="font-mono tabular-nums">{onlineCount}</span></button>
      {#if errorCount > 0}
        <button
          onclick={() => { statusChip = 'error'; }}
          class="px-2.5 py-1 text-xs rounded-md font-medium transition-colors
            {statusChip === 'error'
              ? 'bg-red-600 text-white'
              : 'bg-red-50 border border-red-200 text-red-700 hover:bg-red-100'}"
        >异常 <span class="font-mono tabular-nums">{errorCount}</span></button>
      {/if}
    </div>
  </div>

  <!-- List -->
  <div class="flex-1 min-h-0 overflow-y-auto">
    {#if isLoading}
      {#each [1,2,3,4,5] as _}
        <div class="flex items-center gap-2 px-3 py-2.5 border-b border-stone-100 animate-pulse">
          <div class="w-1.5 h-1.5 rounded-full bg-stone-200 shrink-0"></div>
          <div class="w-6 h-3.5 bg-stone-200 rounded shrink-0"></div>
          <div class="flex-1 space-y-1">
            <div class="h-3 bg-stone-200 rounded w-28"></div>
            <div class="h-2.5 bg-stone-200 rounded w-36"></div>
          </div>
          <div class="flex gap-0.5 items-end shrink-0">
            {#each [1,2,3,4] as bar}
              <div class="w-0.5 bg-stone-200 rounded-sm" style="height: {4+bar*3}px"></div>
            {/each}
          </div>
        </div>
      {/each}

    {:else if filteredPhones.length === 0}
      <div class="p-6 text-center">
        {#if phoneNumbers.length === 0}
          <p class="text-sm text-red-500">无法加载设备数据</p>
          <p class="text-xs text-stone-400 mt-1">请检查网络连接或重新登录</p>
        {:else}
          <p class="text-sm text-stone-400">无匹配设备</p>
          <button onclick={() => { statusChip = 'all'; searchTerm = ''; searchInput = ''; }}
            class="text-xs text-action-text mt-1 hover:underline">清除筛选</button>
        {/if}
      </div>

    {:else}
      {#each filteredPhones as phone}
        {@const meta = getStatusMeta(phone.status)}
        {@const selected = selectedPhoneIccid === phone.iccid}
        {@const q = searchTerm.trim().toLowerCase()}
        {@const anomalous = isAnomalous(phone.status)}
        {@const iccidTail = phone.iccid ? phone.iccid.slice(-4) : ''}

        <!-- Using div+role rather than <button> here because the row may contain
             a nested <button> (the 映射 action), and a button inside a button is
             invalid HTML. The keyboard handler provides equivalent accessibility. -->
        <div
          role="button"
          tabindex="0"
          onclick={() => handlePhoneClick(phone)}
          onkeydown={(e) => e.key === 'Enter' && handlePhoneClick(phone)}
          class="w-full flex items-center gap-2 px-3 py-2.5 border-b text-left cursor-pointer
            transition-all duration-150
            {selected
              ? 'bg-[#fff7ed] border-stone-200'
              : anomalous
                ? `${meta.rowClass} border-stone-100 hover:brightness-95`
                : 'bg-white border-stone-100 hover:bg-stone-50'}
            {selected ? 'shadow-[inset_3px_0_0_#f97316]' : ''}"
        >
          <!-- Status dot -->
          <span class="w-1.5 h-1.5 rounded-full shrink-0 {meta.dotClass}"></span>

          <!-- Card number: the primary identifier -->
          <span class="font-mono text-sm font-semibold tabular-nums w-6 text-right shrink-0
            {phone.status === 'active' ? 'text-stone-800' : 'text-stone-400'}">
            {formatCardNumber(phone.sim_index)}
          </span>

          <!-- Main info -->
          <div class="flex-1 min-w-0">
            <!-- Primary line: flag + number -->
            <div class="flex items-center gap-1 text-sm font-medium font-mono leading-snug">
              {#if phone.flag}<span class="text-base leading-none">{phone.flag}</span>{/if}
              {#if phone.number}
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                <span class="truncate text-stone-800 text-[13px]">{@html highlight(phone.number, q)}</span>
              {:else}
                <span class="text-amber-600 text-xs">未设置号码</span>
                {#if phone.iccid && onSetIccidMapping}
                  <button
                    onclick={(e) => { e.stopPropagation(); onSetIccidMapping(phone); }}
                    onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onSetIccidMapping(phone); } }}
                    class="ml-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-50 border
                      border-amber-200 text-amber-700 hover:bg-amber-100 transition-colors shrink-0"
                  >映射</button>
                {/if}
              {/if}
            </div>
            <!-- Secondary line: carrier · ICCID tail -->
            <div class="text-[11px] text-stone-400 font-mono leading-snug truncate mt-0.5">
              {#if phone.carrier}
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                <span class="text-stone-500">{@html highlight(phone.carrier, q)}</span>
              {/if}
              {#if iccidTail}
                <span class="text-stone-300"> · …{iccidTail}</span>
              {/if}
              {#if anomalous}
                <span class="ml-1 text-[10px] font-medium {meta.badgeClass.includes('red') ? 'text-red-600' : 'text-amber-600'}">
                  {meta.label}
                </span>
              {/if}
            </div>
          </div>

          <!-- Signal bars -->
          <div class="shrink-0">
            <SignalStrength
              signal={phone.signal || 0}
              status={phone.status || 'offline'}
              compact={true}
              daemonConnected={daemonStatus.connected}
              isInitialLoad={isLoading}
            />
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>
