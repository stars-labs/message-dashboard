<script>
  import SignalStrength from './SignalStrength.svelte';
  
  export let phone = null;
  export let mobile = false;
  export let daemonStatus = { connected: false, lastDataUpdate: null };
  
  function getEffectiveStatus(phone) {
    if (!phone) return 'unknown';
    
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
    
    return phone.status;
  }
</script>

{#if phone}
  <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4 {mobile ? 'mx-4 mb-4' : 'mb-4'}">
    <div class="flex items-start justify-between mb-4">
      <div>
        <h3 class="text-lg font-semibold text-gray-900">
          {#if phone.number}
            {phone.number}
          {:else}
            <span class="text-orange-600">未设置号码</span>
          {/if}
        </h3>
        <p class="text-sm text-gray-600">
          {#if phone.carrier}
            {phone.carrier}
          {/if}
          {#if phone.operator_name}
            {#if phone.carrier} • {/if}
            {phone.operator_name}
          {/if}
        </p>
      </div>
      <div class="flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium {getEffectiveStatus(phone) === 'online' ? 'bg-green-100 text-green-700' : getEffectiveStatus(phone) === 'unknown' ? 'bg-gray-100 text-gray-500' : getEffectiveStatus(phone) === 'stale' ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-700'}">
        <div class="w-2 h-2 rounded-full {getEffectiveStatus(phone) === 'online' ? 'bg-green-500 animate-pulse' : getEffectiveStatus(phone) === 'unknown' ? 'bg-gray-400' : getEffectiveStatus(phone) === 'stale' ? 'bg-orange-500' : 'bg-gray-400'}"></div>
        {getEffectiveStatus(phone) === 'online' ? '在线' : getEffectiveStatus(phone) === 'unknown' ? '数据过期' : getEffectiveStatus(phone) === 'stale' ? '数据陈旧' : '离线'}
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
    />
    
    <!-- Additional Phone Info -->
    <div class="mt-4 space-y-2 text-sm">
      {#if phone.iccid}
        <div class="flex justify-between">
          <span class="text-gray-600">ICCID:</span>
          <span class="font-mono text-xs">{phone.iccid}</span>
        </div>
      {/if}
      {#if phone.imei}
        <div class="flex justify-between">
          <span class="text-gray-600">IMEI:</span>
          <span class="font-mono text-xs">{phone.imei}</span>
        </div>
      {/if}
      {#if phone.operator_name}
        <div class="flex justify-between">
          <span class="text-gray-600">运营商:</span>
          <span>{phone.operator_name} {phone.operator_id ? `(${phone.operator_id})` : ''}</span>
        </div>
      {/if}
      {#if phone.access_tech}
        <div class="flex justify-between">
          <span class="text-gray-600">网络类型:</span>
          <span class="uppercase font-medium">{phone.access_tech}</span>
        </div>
      {/if}
      {#if phone.country}
        <div class="flex justify-between">
          <span class="text-gray-600">国家/地区:</span>
          <span>{phone.country}</span>
        </div>
      {/if}
      {#if phone.lastActive}
        <div class="flex justify-between">
          <span class="text-gray-600">最后活跃:</span>
          <span>{new Date(phone.lastActive).toLocaleString('zh-CN')}</span>
        </div>
      {/if}
    </div>
  </div>
{/if}