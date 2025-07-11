<script>
  import SignalStrength from './SignalStrength.svelte';
  
  export let phoneNumbers = [];
  export let selectedPhone = null;
  export let selectedCountry = 'all';
  export let searchTerm = '';
  export let onSelectPhone = null;
  export let mobile = false;
  
  $: filteredPhones = phoneNumbers.filter(phone => {
    const matchesCountry = selectedCountry === 'all' || phone.country === selectedCountry;
    const matchesSearch = searchTerm === '' || 
      phone.number.includes(searchTerm) || 
      phone.carrier.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesCountry && matchesSearch;
  });
  
  const countries = [
    { code: 'all', name: '全部', flag: '🌍' },
    { code: 'CN', name: '中国', flag: '🇨🇳' },
    { code: 'HK', name: '香港', flag: '🇭🇰' },
    { code: 'SG', name: '新加坡', flag: '🇸🇬' }
  ];
  
  function getStatusColor(status) {
    switch(status) {
      case 'online': return 'bg-gradient-to-r from-green-400 to-green-500';
      case 'offline': return 'bg-gradient-to-r from-gray-400 to-gray-500';
      case 'error': return 'bg-gradient-to-r from-red-400 to-red-500';
      default: return 'bg-gradient-to-r from-gray-400 to-gray-500';
    }
  }
  
  function handlePhoneClick(phone) {
    // Toggle selection - if clicking the same phone, unselect it
    if (selectedPhone?.id === phone.id) {
      selectedPhone = null;
      if (onSelectPhone) {
        onSelectPhone(null);
      }
    } else {
      selectedPhone = phone;
      if (onSelectPhone) {
        onSelectPhone(phone);
      }
    }
  }
</script>

<div class="{mobile ? 'bg-white' : 'glassmorphism rounded-2xl shadow-xl'}">
  <div class="p-4 {mobile ? 'border-b' : ''}">
    <h2 class="text-lg font-bold bg-gradient-to-r from-purple-600 to-indigo-600 bg-clip-text text-transparent mb-3">号码列表</h2>
    
    <!-- Country Filter -->
    <div class="mb-3">
      <select 
        bind:value={selectedCountry}
        class="w-full px-3 py-2 text-sm border border-purple-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white/50 backdrop-blur-sm"
      >
        {#each countries as country}
          <option value={country.code}>
            {country.flag} {country.name}
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
    
    <div class="text-sm font-medium text-purple-600">
      共 {filteredPhones.length} 个号码
    </div>
  </div>
  
  <!-- Phone List -->
  <div class="{mobile ? '' : 'max-h-[600px]'} overflow-y-auto">
    {#each filteredPhones as phone}
      <button
        class="w-full p-3 border-b hover:bg-purple-50 active:bg-purple-100 transition-all duration-300 text-left {selectedPhone?.id === phone.id ? 'bg-gradient-to-r from-purple-50 to-indigo-50 border-l-4 border-l-purple-500' : 'hover:border-l-4 hover:border-l-purple-200'}"
        on:click={() => handlePhoneClick(phone)}
      >
        <div class="flex items-center justify-between">
          <div class="flex-1">
            <div class="flex items-center gap-2">
              <span class="text-lg">{phone.flag}</span>
              <span class="font-medium text-gray-900 text-sm">{phone.number}</span>
              {#if selectedPhone?.id === phone.id}
                <span class="text-purple-600 text-xs font-semibold ml-1">✓</span>
              {/if}
            </div>
            <div class="text-xs text-gray-600 mt-0.5">
              <span class="font-medium">{phone.carrier}</span> • <span class="text-purple-600 font-semibold">{phone.id}</span>
            </div>
          </div>
          <SignalStrength 
            signal={phone.signal || 0} 
            status={phone.status}
            compact={true}
          />
        </div>
        {#if phone.lastActive && !mobile}
          <div class="text-xs text-gray-400 mt-1">
            最后活跃: {new Date(phone.lastActive).toLocaleString('zh-CN')}
          </div>
        {/if}
      </button>
    {/each}
  </div>
</div>