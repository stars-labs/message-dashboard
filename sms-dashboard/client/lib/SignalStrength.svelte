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
    if (signal >= 75) return 4;
    if (signal >= 50) return 3;
    if (signal >= 25) return 2;
    if (signal > 0) return 1;
    return 0;
  }

  // Get signal quality label
  function getSignalQuality(signal) {
    if (signal >= 75) return "优秀";
    if (signal >= 50) return "良好";
    if (signal >= 25) return "一般";
    if (signal > 0) return "较弱";
    return "无信号";
  }

  // Get signal color for bars
  function getSignalColor(signal) {
    if (signal >= 75) return "bg-green-500";
    if (signal >= 50) return "bg-blue-500";
    if (signal >= 25) return "bg-yellow-500";
    if (signal > 0) return "bg-orange-500";
    return "bg-gray-400";
  }

  // Get text color for labels
  function getTextColor(signal) {
    if (signal >= 75) return "text-green-600";
    if (signal >= 50) return "text-blue-600";
    if (signal >= 25) return "text-yellow-600";
    if (signal > 0) return "text-orange-600";
    return "text-gray-400";
  }

  $: bars = getSignalBars(signal);
  $: quality = getSignalQuality(signal);
  $: color = getSignalColor(signal);
  $: textColor = getTextColor(signal);
</script>

{#if compact}
  <!-- Compact view for list -->
  <div class="flex items-center gap-1.5">
    {#if status === "online"}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 transition-all duration-300 rounded-sm {bar <= bars
              ? color
              : 'bg-gray-300'}"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
    {:else if status === "searching"}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-yellow-300 rounded-sm animate-pulse"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
      <span class="text-xs text-yellow-600">搜索中</span>
    {:else if status === "failed"}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-red-300 rounded-sm"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
      <span class="text-xs text-red-600">故障</span>
    {:else if status === "offline"}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-gray-300 rounded-sm"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
      <span class="text-xs text-gray-500">离线</span>
    {:else if status === "unknown"}
      {#if isInitialLoad}
        <!-- Show loading animation during initial load -->
        <div class="flex gap-0.5 items-end">
          {#each [1, 2, 3, 4] as bar}
            <div
              class="w-1 bg-gray-300 rounded-sm animate-pulse"
              style="height: {4 + bar * 3}px; animation-delay: {bar * 100}ms"
            ></div>
          {/each}
        </div>
        <span class="text-xs text-gray-500">加载中</span>
      {:else}
        <!-- Show data expired only after initial load -->
        <div class="flex gap-0.5 items-end">
          {#each [1, 2, 3, 4] as bar}
            <div
              class="w-1 bg-gray-200 rounded-sm opacity-50"
              style="height: {4 + bar * 3}px"
            ></div>
          {/each}
        </div>
        <span class="text-xs text-gray-400">数据过期</span>
      {/if}
    {:else if status === "stale"}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-orange-200 rounded-sm"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
      <span class="text-xs text-orange-500">数据陈旧</span>
    {:else}
      <div class="flex gap-0.5 items-end">
        {#each [1, 2, 3, 4] as bar}
          <div
            class="w-1 bg-gray-200 rounded-sm"
            style="height: {4 + bar * 3}px"
          ></div>
        {/each}
      </div>
      <span class="text-xs text-gray-400">未知</span>
    {/if}
  </div>
{:else}
  <!-- Detailed view -->
  <div class="bg-gray-50 rounded-lg p-3 space-y-2">
    <div class="flex items-center justify-between">
      <span class="text-sm font-medium text-gray-700">信号强度</span>
      <div class="flex items-center gap-2">
        {#if status === "online"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 transition-all duration-300 rounded-sm {bar <= bars
                  ? color
                  : 'bg-gray-300'}"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold {textColor}">{quality}</span>
        {:else if status === "searching"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-yellow-300 rounded-sm animate-pulse"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-yellow-600">搜索网络中</span>
        {:else if status === "failed"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-red-300 rounded-sm"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-red-600">连接故障</span>
        {:else if status === "offline"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-gray-300 rounded-sm"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-gray-500">离线</span>
        {:else if status === "unknown"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-gray-200 rounded-sm opacity-50"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-gray-400">数据过期</span>
        {:else if status === "stale"}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-orange-200 rounded-sm"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-orange-500">数据陈旧</span>
        {:else}
          <div class="flex gap-0.5 items-end">
            {#each [1, 2, 3, 4] as bar}
              <div
                class="w-1.5 bg-gray-200 rounded-sm"
                style="height: {bar * 4 + 6}px"
              ></div>
            {/each}
          </div>
          <span class="text-sm font-semibold text-gray-400">未知状态</span>
        {/if}
      </div>
    </div>

    {#if status === "online" && (rssi || rsrq || rsrp || snr)}
      <div class="grid grid-cols-2 gap-2 text-xs">
        {#if rssi}
          <div class="flex justify-between">
            <span class="text-gray-600">RSSI:</span>
            <span class="font-mono font-medium">{rssi} dBm</span>
          </div>
        {/if}
        {#if rsrq}
          <div class="flex justify-between">
            <span class="text-gray-600">RSRQ:</span>
            <span class="font-mono font-medium">{rsrq} dB</span>
          </div>
        {/if}
        {#if rsrp}
          <div class="flex justify-between">
            <span class="text-gray-600">RSRP:</span>
            <span class="font-mono font-medium">{rsrp} dBm</span>
          </div>
        {/if}
        {#if snr}
          <div class="flex justify-between">
            <span class="text-gray-600">S/N:</span>
            <span class="font-mono font-medium">{snr} dB</span>
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
