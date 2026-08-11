<script>
  let {
    signal = 0, // 0-100 signal strength
    status = "offline",
    rssi = null, // RSSI in dBm
    rsrq = null, // RSRQ in dB
    rsrp = null, // RSRP in dBm
    snr = null, // SNR in dB
    compact = false, // Compact mode for list view
    daemonConnected = true, // Whether daemon is connected (external reference only)
    isInitialLoad = false, // Whether this is the initial page load
  } = $props();

  // Calculate signal bars (0-4) based on signal percentage
  function getSignalBars(signal) {
    const validSignal = Number(signal) || 0;
    if (validSignal >= 75) return 4;
    if (validSignal >= 50) return 3;
    if (validSignal >= 25) return 2;
    if (validSignal > 0) return 1;
    return 0;
  }

  // Get signal quality label
  function getSignalQuality(signal) {
    const validSignal = Number(signal) || 0;
    if (validSignal >= 75) return "优秀";
    if (validSignal >= 50) return "良好";
    if (validSignal >= 25) return "一般";
    if (validSignal > 0) return "较弱";
    return "无信号";
  }

  function getSignalColor(signal) {
    const validSignal = Number(signal) || 0;
    if (validSignal >= 75) return "bg-emerald-500";
    if (validSignal >= 50) return "bg-blue-500";
    if (validSignal >= 25) return "bg-amber-500";
    if (validSignal > 0) return "bg-orange-500";
    return "bg-stone-300";
  }

  function getTextColor(signal) {
    const validSignal = Number(signal) || 0;
    if (validSignal >= 75) return "text-emerald-600";
    if (validSignal >= 50) return "text-blue-600";
    if (validSignal >= 25) return "text-amber-600";
    if (validSignal > 0) return "text-orange-600";
    return "text-stone-400";
  }

  let bars = $derived(getSignalBars(signal) || 0);
  let quality = $derived(getSignalQuality(signal));
  let color = $derived(getSignalColor(signal));
  let textColor = $derived(getTextColor(signal));
</script>

{#if compact}
  <!-- Compact view for list -->
  <div class="flex items-center gap-1.5">
    {#if status === "online" || status === "active" || status === "registered" || status === "connected"}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 rounded-sm {bar <= bars
              ? color
              : 'bg-stone-200'}"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
    {:else if status === "searching"}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-amber-400 rounded-sm animate-pulse"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
      <span class="text-xs text-amber-600">搜索中</span>
    {:else if status === "failed"}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-red-500 rounded-sm"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
      <span class="text-xs text-red-500">故障</span>
    {:else if status === "offline"}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-stone-300 rounded-sm"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
    {:else if status === "unknown"}
      {#if isInitialLoad}
        <!-- Show loading animation during initial load -->
        <div class="flex gap-0.5 items-end">
          {#each [1, 2, 3, 4] as bar}
            <div
              class="w-1 bg-stone-300 rounded-sm animate-pulse"
              style="height: {4 + bar * 3}px; animation-delay: {bar * 100}ms"
            ></div>
          {/each}
        </div>
        <span class="text-xs text-stone-400">加载中</span>
      {:else}
        <!-- Show data expired only after initial load -->
        <div class="flex gap-0.5 items-end">
          {#each [1, 2, 3, 4] as bar}
            <div
              class="w-1 bg-stone-200 rounded-sm opacity-60"
              style="height: {4 + bar * 3}px"
            ></div>
          {/each}
        </div>
        <span class="text-xs text-stone-400">数据过期</span>
      {/if}
    {:else if status === "stale"}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-orange-500 rounded-sm"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
      <span class="text-xs text-orange-600">数据陈旧</span>
    {:else}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-stone-200 rounded-sm"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
      <span class="text-xs text-stone-400">未知</span>
    {/if}
  </div>
{:else}
  <!-- Detailed view -->
  <div class="bg-white rounded-lg p-3 space-y-2 border border-stone-200">
    <div class="flex items-center justify-between">
      <span class="text-sm font-medium text-stone-600">信号强度</span>
      <div class="flex items-center gap-2">
        {#if status === "online" || status === "active" || status === "registered" || status === "connected"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 rounded-sm {bar <= bars
                  ? color
                  : 'bg-stone-200'}"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold {textColor}">{quality}</span>
        {:else if status === "searching"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-amber-400 rounded-sm animate-pulse"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-amber-600">搜索网络中</span>
        {:else if status === "failed"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-red-500 rounded-sm"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-red-500">连接故障</span>
        {:else if status === "offline"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-stone-300 rounded-sm"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-stone-400">离线</span>
        {:else if status === "unknown"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-stone-200 rounded-sm opacity-60"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-stone-400">数据过期</span>
        {:else if status === "stale"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-orange-500 rounded-sm"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-orange-600">数据陈旧</span>
        {:else}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-stone-200 rounded-sm"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-stone-400">未知状态</span>
        {/if}
      </div>
    </div>

    {#if status === "online" && (rssi || rsrq || rsrp || snr)}
      <div class="grid grid-cols-2 gap-2 text-xs">
        {#if rssi}
          <div class="flex justify-between">
            <span class="text-stone-500">RSSI:</span>
            <span class="font-mono font-medium text-stone-800">{rssi} dBm</span>
          </div>
        {/if}
        {#if rsrq}
          <div class="flex justify-between">
            <span class="text-stone-500">RSRQ:</span>
            <span class="font-mono font-medium text-stone-800">{rsrq} dB</span>
          </div>
        {/if}
        {#if rsrp}
          <div class="flex justify-between">
            <span class="text-stone-500">RSRP:</span>
            <span class="font-mono font-medium text-stone-800">{rsrp} dBm</span>
          </div>
        {/if}
        {#if snr}
          <div class="flex justify-between">
            <span class="text-stone-500">S/N:</span>
            <span class="font-mono font-medium text-stone-800">{snr} dB</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Add smooth transitions for signal bars */
  div {
    transition: background-color 0.3s ease;
  }
</style>
