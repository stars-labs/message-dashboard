<script>
  export let signal = 0; // 0-100 signal strength
  export let status = "offline";
  export let rssi = null; // RSSI in dBm
  export let rsrq = null; // RSRQ in dB
  export let rsrp = null; // RSRP in dBm
  export let snr = null; // SNR in dB
  export let compact = false; // Compact mode for list view
  export const daemonConnected = true; // Whether daemon is connected (external reference only)
  export let isInitialLoad = false; // Whether this is the initial page load

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

  // Get signal color for bars (dark theme)
  function getSignalColor(signal) {
    const validSignal = Number(signal) || 0;
    if (validSignal >= 75) return "bg-green-400";
    if (validSignal >= 50) return "bg-blue-400";
    if (validSignal >= 25) return "bg-yellow-400";
    if (validSignal > 0) return "bg-orange-400";
    return "bg-gray-600";
  }

  // Get text color for labels (dark theme)
  function getTextColor(signal) {
    const validSignal = Number(signal) || 0;
    if (validSignal >= 75) return "text-green-400";
    if (validSignal >= 50) return "text-blue-400";
    if (validSignal >= 25) return "text-yellow-400";
    if (validSignal > 0) return "text-orange-400";
    return "text-gray-500";
  }

  $: bars = getSignalBars(signal) || 0;
  $: quality = getSignalQuality(signal);
  $: color = getSignalColor(signal);
  $: textColor = getTextColor(signal);
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
              : 'bg-gray-700'}"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
    {:else if status === "searching"}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-yellow-400 rounded-sm animate-pulse"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
      <span class="text-xs text-yellow-400">搜索中</span>
    {:else if status === "failed"}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-red-400 rounded-sm"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
      <span class="text-xs text-red-400">故障</span>
    {:else if status === "offline"}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-gray-300 rounded-sm"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
      <span class="text-xs text-gray-400">离线</span>
    {:else if status === "unknown"}
      {#if isInitialLoad}
        <!-- Show loading animation during initial load -->
        <div class="flex gap-0.5 items-end">
          {#each [1, 2, 3, 4] as bar}
            <div
              class="w-1 bg-gray-600 rounded-sm animate-pulse"
              style="height: {4 + bar * 3}px; animation-delay: {bar * 100}ms"
            ></div>
          {/each}
        </div>
        <span class="text-xs text-gray-400">加载中</span>
      {:else}
        <!-- Show data expired only after initial load -->
        <div class="flex gap-0.5 items-end">
          {#each [1, 2, 3, 4] as bar}
            <div
              class="w-1 bg-gray-700 rounded-sm opacity-50"
              style="height: {4 + bar * 3}px"
            ></div>
          {/each}
        </div>
        <span class="text-xs text-gray-500">数据过期</span>
      {/if}
    {:else if status === "stale"}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-orange-400 rounded-sm"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
      <span class="text-xs text-orange-400">数据陈旧</span>
    {:else}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-gray-700 rounded-sm"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
      <span class="text-xs text-gray-500">未知</span>
    {/if}
  </div>
{:else}
  <!-- Detailed view -->
  <div class="bg-gray-800 rounded-lg p-3 space-y-2 border border-gray-700">
    <div class="flex items-center justify-between">
      <span class="text-sm font-medium text-gray-300">信号强度</span>
      <div class="flex items-center gap-2">
        {#if status === "online" || status === "active" || status === "registered" || status === "connected"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 rounded-sm {bar <= bars
                  ? color
                  : 'bg-gray-700'}"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold {textColor}">{quality}</span>
        {:else if status === "searching"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-yellow-400 rounded-sm animate-pulse"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-yellow-400">搜索网络中</span>
        {:else if status === "failed"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-red-400 rounded-sm"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-red-400">连接故障</span>
        {:else if status === "offline"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-gray-600 rounded-sm"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-gray-400">离线</span>
        {:else if status === "unknown"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-gray-700 rounded-sm opacity-50"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-gray-500">数据过期</span>
        {:else if status === "stale"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-orange-400 rounded-sm"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-orange-400">数据陈旧</span>
        {:else}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-gray-700 rounded-sm"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-gray-500">未知状态</span>
        {/if}
      </div>
    </div>

    {#if status === "online" && (rssi || rsrq || rsrp || snr)}
      <div class="grid grid-cols-2 gap-2 text-xs">
        {#if rssi}
          <div class="flex justify-between">
            <span class="text-gray-300/70">RSSI:</span>
            <span class="font-mono font-medium text-gray-200">{rssi} dBm</span>
          </div>
        {/if}
        {#if rsrq}
          <div class="flex justify-between">
            <span class="text-gray-300/70">RSRQ:</span>
            <span class="font-mono font-medium text-gray-200">{rsrq} dB</span>
          </div>
        {/if}
        {#if rsrp}
          <div class="flex justify-between">
            <span class="text-gray-300/70">RSRP:</span>
            <span class="font-mono font-medium text-gray-200">{rsrp} dBm</span>
          </div>
        {/if}
        {#if snr}
          <div class="flex justify-between">
            <span class="text-gray-300/70">S/N:</span>
            <span class="font-mono font-medium text-gray-200">{snr} dB</span>
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
