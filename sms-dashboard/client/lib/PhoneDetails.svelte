<script>
  import SignalStrength from './SignalStrength.svelte';
  
  export let phone = null;
  export let mobile = false;
</script>

{#if phone}
  <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4 {mobile ? 'mx-4 mb-4' : ''}">
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
            {phone.carrier} • 
          {/if}
          {phone.id}
        </p>
      </div>
      <div class="flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium {phone.status === 'online' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'}">
        <div class="w-2 h-2 rounded-full {phone.status === 'online' ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}"></div>
        {phone.status === 'online' ? '在线' : '离线'}
      </div>
    </div>
    
    <!-- Signal Strength Details -->
    <SignalStrength 
      signal={phone.signal || 0}
      status={phone.status}
      rssi={phone.rssi}
      rsrq={phone.rsrq}
      rsrp={phone.rsrp}
      snr={phone.snr}
      compact={false}
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