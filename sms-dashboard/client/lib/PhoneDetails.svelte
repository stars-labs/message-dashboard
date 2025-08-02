<script>
  import SignalStrength from './SignalStrength.svelte';
  
  export let phone = null;
  export let mobile = false;
  export let daemonStatus = { connected: false, lastDataUpdate: null };
  
  // Function to get carrier color class (dark theme)
  function getCarrierColor(carrier) {
    if (!carrier) return "";
    
    const carrierUpper = carrier.toUpperCase();
    
    // Common carrier mappings (dark theme)
    if (carrierUpper.includes("CMCC") || carrierUpper.includes("中国移动") || carrierUpper.includes("CHINA MOBILE")) {
      return "bg-blue-900/50 text-blue-300 border border-blue-500/30";
    }
    if (carrierUpper.includes("UNICOM") || carrierUpper.includes("中国联通") || carrierUpper.includes("CHINA UNICOM")) {
      return "bg-orange-900/50 text-orange-300 border border-orange-500/30";
    }
    if (carrierUpper.includes("TELECOM") || carrierUpper.includes("中国电信") || carrierUpper.includes("CHINA TELECOM")) {
      return "bg-red-900/50 text-red-300 border border-red-500/30";
    }
    if (carrierUpper.includes("CMHK") || carrierUpper.includes("香港移动")) {
      return "bg-purple-900/50 text-purple-300 border border-purple-500/30";
    }
    if (carrierUpper.includes("SINGTEL")) {
      return "bg-teal-900/50 text-teal-300 border border-teal-500/30";
    }
    if (carrierUpper.includes("STARHUB")) {
      return "bg-indigo-900/50 text-indigo-300 border border-indigo-500/30";
    }
    if (carrierUpper.includes("M1") || carrierUpper.includes("SGP-M1")) {
      return "bg-green-900/50 text-green-300 border border-green-500/30";
    }
    
    // Default color for unknown carriers
    return "bg-gray-900/50 text-gray-300 border border-gray-500/30";
  }
  
  // Track if we're in initial loading state
  $: isInitialLoad = daemonStatus.connected && Date.now() - (daemonStatus.lastDataUpdate || Date.now()) < 5000;
  
  function getEffectiveStatus(phone) {
    if (!phone) return 'unknown';
    
    // During initial load with optimistic daemon status, trust the phone status
    if (daemonStatus.connected && phone.status) {
      return phone.status;
    }
    
    if (!daemonStatus.connected) {
      return 'unknown';
    }
    
    // If daemon is connected but no recent data update, show as stale
    if (daemonStatus.lastDataUpdate) {
      const timeSinceUpdate = Date.now() - daemonStatus.lastDataUpdate;
      if (timeSinceUpdate > 120000) { // 2 minutes
        return 'stale';
      }
    }
    
    return phone.status || 'offline';
  }
</script>

{#if phone}
  <div class="tech-card p-4 {mobile ? 'mx-4 mb-4' : 'mb-4'}">
    <div class="flex items-start justify-between mb-4">
      <div>
        <h3 class="text-lg font-semibold data-value high-contrast">
          {#if phone.number}
            {#if phone.mapped_number}
              <span class="text-purple-400 flex items-center gap-2 tech-text">
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                </svg>
                {phone.number}
                <span class="text-xs font-normal text-purple-400">(映射号码)</span>
              </span>
            {:else}
              <span class="text-white">{phone.number}</span>
            {/if}
          {:else}
            <span class="text-orange-400">未设置号码</span>
          {/if}
        </h3>
        <p class="text-sm text-cyan-400 mt-1">
          {#if phone.mapped_carrier || phone.carrier}
            <span class="inline-flex px-2 py-1 text-xs rounded-full font-medium {getCarrierColor(phone.mapped_carrier || phone.carrier)}">
              {phone.mapped_carrier || phone.carrier}
            </span>
          {/if}
          {#if phone.operator_name && !phone.mapped_carrier}
            {#if phone.carrier} • {/if}
            <span class="text-cyan-400">{phone.operator_name}</span>
          {/if}
        </p>
      </div>
      <div class="flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium {['online', 'active', 'registered', 'connected'].includes(getEffectiveStatus(phone)) ? 'bg-green-900/50 text-green-300 border border-green-500/30' : getEffectiveStatus(phone) === 'unknown' ? 'bg-gray-900/50 text-gray-400 border border-gray-500/30' : getEffectiveStatus(phone) === 'stale' ? 'bg-orange-900/50 text-orange-300 border border-orange-500/30' : 'bg-gray-900/50 text-gray-400 border border-gray-500/30'}">
        <div class="w-2 h-2 rounded-full {['online', 'active', 'registered', 'connected'].includes(getEffectiveStatus(phone)) ? 'bg-green-400 animate-pulse shadow-lg shadow-green-400/50' : getEffectiveStatus(phone) === 'unknown' ? 'bg-gray-500' : getEffectiveStatus(phone) === 'stale' ? 'bg-orange-400 shadow-lg shadow-orange-400/50' : 'bg-gray-500'}"></div>
        {['online', 'active', 'registered', 'connected'].includes(getEffectiveStatus(phone)) ? '在线' : getEffectiveStatus(phone) === 'unknown' ? '数据过期' : getEffectiveStatus(phone) === 'stale' ? '数据陈旧' : '离线'}
      </div>
    </div>
    
    <!-- Signal Strength Details -->
    <SignalStrength 
      signal={phone.signal || 0}
      status={getEffectiveStatus(phone)}
      rssi={phone.rssi}
      rsrq={phone.rsrq}
      rsrp={phone.rsrp}
      snr={phone.snr}
      compact={false}
      daemonConnected={daemonStatus.connected}
      isInitialLoad={isInitialLoad}
    />
    
    <!-- Additional Phone Info -->
    <div class="mt-4 space-y-2 text-sm bg-black/30 rounded-lg p-3 border border-cyan-500/20">
      {#if phone.iccid}
        <div class="flex justify-between">
          <span class="text-cyan-400/70">ICCID:</span>
          <span class="font-mono text-xs text-cyan-300">{phone.iccid}</span>
        </div>
      {/if}
      {#if phone.modem_index != null || phone.sim_index != null}
        <div class="flex justify-between">
          <span class="text-cyan-400/70">位置索引:</span>
          <span class="text-indigo-400 font-medium tech-text">
            {#if phone.modem_index != null}
              调制解调器 #{phone.modem_index}
            {/if}
            {#if phone.modem_index != null && phone.sim_index != null}
              ,
            {/if}
            {#if phone.sim_index != null}
              SIM卡 #{phone.sim_index}
            {/if}
          </span>
        </div>
      {/if}
      {#if phone.mapped_number}
        <div class="flex justify-between items-center">
          <span class="text-cyan-400/70">映射来源:</span>
          <span class="text-purple-400 text-sm flex items-center gap-1 tech-text">
            <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
            </svg>
            ICCID 映射
          </span>
        </div>
      {/if}
      {#if phone.imei}
        <div class="flex justify-between">
          <span class="text-cyan-400/70">IMEI:</span>
          <span class="font-mono text-xs text-cyan-300">{phone.imei}</span>
        </div>
      {/if}
      {#if phone.mapped_carrier || phone.operator_name}
        <div class="flex justify-between items-center">
          <span class="text-cyan-400/70">运营商:</span>
          <span>
            {#if phone.mapped_carrier}
              <span class="inline-flex px-2 py-1 text-xs rounded-full font-medium {getCarrierColor(phone.mapped_carrier)}">
                {phone.mapped_carrier}
              </span>
            {:else}
              <span class="text-cyan-300">{phone.operator_name} {phone.operator_id ? `(${phone.operator_id})` : ''}</span>
            {/if}
          </span>
        </div>
      {/if}
      {#if phone.access_tech}
        <div class="flex justify-between">
          <span class="text-cyan-400/70">网络类型:</span>
          <span class="uppercase font-medium text-cyan-300">{phone.access_tech}</span>
        </div>
      {/if}
      {#if phone.country}
        <div class="flex justify-between">
          <span class="text-cyan-400/70">国家/地区:</span>
          <span class="text-cyan-300">{phone.country}</span>
        </div>
      {/if}
      {#if phone.lastActive}
        <div class="flex justify-between">
          <span class="text-cyan-400/70">最后活跃:</span>
          <span class="text-cyan-300">{new Date(phone.lastActive).toLocaleString('zh-CN')}</span>
        </div>
      {/if}
    </div>
  </div>
{/if}