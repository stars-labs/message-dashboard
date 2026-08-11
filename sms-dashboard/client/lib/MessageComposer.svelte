<script>
  import { onMount } from "svelte";

  let {
    selectedPhone = null,
    phoneNumbers = [],
    messages = [],
    mobilePage = false,
    onmessagesent = null,
  } = $props();

  const DRAFT_KEY = 'sms-dashboard:send-draft';

  let recipientNumber = $state("");
  let recipientSIM = $state("");
  let messageContent = $state("");
  let sendingStatus = $state("");
  let showRecipientHistory = $state(false);
  let recipientSearch = $state("");
  let simSearch = $state("");
  let showSimDropdown = $state(false);
  let selectedSimDisplay = $state("");
  let selectedCountryCode = $state("+65"); // Default to Singapore
  let showCountryDropdown = $state(false);
  let draftReady = $state(false);

  // Common country codes
  const countryCodes = [
    { code: "+65", country: "🇸🇬 Singapore", short: "SG" },
    { code: "+86", country: "🇨🇳 China", short: "CN" },
    { code: "+1", country: "🇺🇸 USA/Canada", short: "US" },
    { code: "+44", country: "🇬🇧 UK", short: "UK" },
    { code: "+81", country: "🇯🇵 Japan", short: "JP" },
    { code: "+82", country: "🇰🇷 South Korea", short: "KR" },
    { code: "+60", country: "🇲🇾 Malaysia", short: "MY" },
    { code: "+66", country: "🇹🇭 Thailand", short: "TH" },
    { code: "+62", country: "🇮🇩 Indonesia", short: "ID" },
    { code: "+63", country: "🇵🇭 Philippines", short: "PH" },
    { code: "+84", country: "🇻🇳 Vietnam", short: "VN" },
    { code: "+91", country: "🇮🇳 India", short: "IN" },
    { code: "+61", country: "🇦🇺 Australia", short: "AU" },
    { code: "+49", country: "🇩🇪 Germany", short: "DE" },
    { code: "+33", country: "🇫🇷 France", short: "FR" },
  ];

  // Get full phone number with country code
  function getFullPhoneNumber() {
    const num = recipientNumber.trim();
    // If already has + prefix, use as-is
    if (num.startsWith('+')) {
      return num;
    }
    // Otherwise prepend selected country code
    return `${selectedCountryCode}${num}`;
  }

  // Get unique recipient numbers from sent messages
  let recipientHistory = $state([
    ...new Set(
      messages
        .filter((msg) => msg.type === "sent" && msg.recipient)
        .map((msg) => msg.recipient),
    ),
  ].slice(0, 20)); // Keep last 20 unique recipients

  // Filter recipient history based on search
  let filteredRecipients = $derived(
    recipientHistory.filter(
      (num) => num.includes(recipientSearch) || recipientSearch === "",
    )
  );

  // Filter available SIM cards based on search
  // Include phones that are online, registered, or have any other active status
  let availablePhones = $derived(phoneNumbers.filter((p) => p.iccid && (p.status === "online" || p.status === "registered" || (!p.status || (p.status !== "offline" && p.status !== "error" && p.status !== "sim-missing")))));

  let filteredSims = $derived(availablePhones.filter(phone => {
    if (!simSearch) return true;
    const searchLower = simSearch.toLowerCase();
    const phoneNumber = (phone.number && phone.number !== "null") ? phone.number : (phone.iccid ? `ICCID: ${phone.iccid.slice(-6)}` : "Unknown");
    const phoneDisplay = `${phone.flag || ''} ${phoneNumber} ${phone.operator_name || ""}`.toLowerCase();
    return phoneDisplay.includes(searchLower) || (phone.iccid && phone.iccid.toLowerCase().includes(searchLower));
  }));

  // Sync SIM selection + display when selectedPhone changes. The legacy version
  // was a reactive `$: if (selectedPhone)` block; $effect tracks the same prop
  // and runs the same side effects after each change.
  $effect(() => {
    if (selectedPhone) {
      // Always update the sender SIM when a different phone is selected in the list
      recipientSIM = selectedPhone.iccid;
      const phone = availablePhones.find(p => p.iccid === selectedPhone.iccid);
      if (phone) {
        const phoneDisplay = (phone.number && phone.number !== "null") ? phone.number : (phone.iccid ? `ICCID: ${phone.iccid.slice(-6)}` : "Unknown");
        const operatorDisplay = phone.operator_name ? ` - ${phone.operator_name}` : "";
        selectedSimDisplay = `${phone.flag || ""} ${phoneDisplay}${operatorDisplay}`;
      }
    }
  });

  async function handleSend() {
    if (!recipientNumber || !recipientSIM || !messageContent) {
      sendingStatus = "validation-error";
      setTimeout(() => (sendingStatus = ""), 3000);
      return;
    }

    sendingStatus = "sending";

    // Get full phone number with country code
    const fullPhoneNumber = getFullPhoneNumber();

    // Store recipient in localStorage for persistence (store with country code)
    const storedRecipients = JSON.parse(
      localStorage.getItem("recipientHistory") || "[]",
    );
    if (!storedRecipients.includes(fullPhoneNumber)) {
      storedRecipients.unshift(fullPhoneNumber);
      localStorage.setItem(
        "recipientHistory",
        JSON.stringify(storedRecipients.slice(0, 50)),
      );
    }

    // Send actual message via WebSocket
    const sentMessage = {
      phone_iccid: recipientSIM,
      phoneNumber: fullPhoneNumber,
      recipient: fullPhoneNumber,
      content: messageContent,
      timestamp: new Date(),
      type: "sent",
      status: "sending",
    };

    try {
      // App owns the HTTP request. Keep the draft until the API accepts it.
      if (!onmessagesent) throw new Error("发送服务不可用");
      await onmessagesent(sentMessage);
      sendingStatus = "success";
      messageContent = "";
    } catch (error) {
      console.error("Failed to send message:", error);
      sendingStatus = "send-error";
    }

    setTimeout(() => {
      sendingStatus = "";
    }, 2000);
  }

  function selectRecipient(number) {
    recipientNumber = number;
    showRecipientHistory = false;
    recipientSearch = "";
  }

  function selectSim(phone) {
    recipientSIM = phone.iccid;
    const phoneDisplay = (phone.number && phone.number !== "null") ? phone.number : (phone.iccid ? `ICCID: ${phone.iccid.slice(-6)}` : "Unknown");
    const operatorDisplay = phone.operator_name ? ` - ${phone.operator_name}` : "";
    selectedSimDisplay = `${phone.flag || ""} ${phoneDisplay}${operatorDisplay}`;
    showSimDropdown = false;
    simSearch = "";
  }

  function insertTemplate(template) {
    messageContent = template;
  }

  const messageTemplates = [
    { name: "验证码模板", content: "您的验证码是：123456，有效期5分钟。" },
    { name: "通知模板", content: "尊敬的用户，您的订单已发货，请注意查收。" },
    { name: "提醒模板", content: "温馨提醒：您的账户余额不足，请及时充值。" },
    { name: "营销模板", content: "限时优惠！全场商品8折，快来选购吧！" },
  ];

  // Restore the route draft after navigation or a refresh. Wait until restore is
  // complete before persisting so the initial empty state cannot overwrite it.
  onMount(() => {
    try {
      const storedRecipients = JSON.parse(localStorage.getItem("recipientHistory") || "[]");
      if (storedRecipients.length > 0) recipientHistory.push(...storedRecipients);
    } catch {
      localStorage.removeItem("recipientHistory");
    }

    if (!mobilePage) return;

    try {
      const draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null");
      if (draft) {
        recipientNumber = draft.recipientNumber || "";
        recipientSIM = draft.recipientSIM || recipientSIM;
        messageContent = draft.messageContent || "";
        selectedCountryCode = draft.selectedCountryCode || "+65";
        selectedSimDisplay = draft.selectedSimDisplay || selectedSimDisplay;
      }
    } catch {
      sessionStorage.removeItem(DRAFT_KEY);
    }
    draftReady = true;
  });

  $effect(() => {
    if (!mobilePage || !draftReady) return;
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
      recipientNumber,
      recipientSIM,
      messageContent,
      selectedCountryCode,
      selectedSimDisplay,
    }));
  });

  // Close dropdown when clicking outside
  function handleClickOutside(event) {
    if (!event.target.closest(".recipient-input-container")) {
      showRecipientHistory = false;
    }
    if (!event.target.closest(".sim-input-container")) {
      showSimDropdown = false;
    }
    if (!event.target.closest(".country-code-container")) {
      showCountryDropdown = false;
    }
  }

  function selectCountryCode(code) {
    selectedCountryCode = code;
    showCountryDropdown = false;
  }
</script>

<svelte:window onclick={handleClickOutside} />

<!-- Desktop Composer -->
<div
  class="hidden lg:flex lg:flex-col bg-white border border-stone-200/80 rounded-xl h-full min-h-0"
  style="box-shadow: 0 1px 3px rgba(28,25,23,0.06);"
>
  <div class="p-4 border-b border-stone-200 flex-shrink-0 flex items-center justify-between">
    <h2 class="text-lg font-bold text-stone-900">发送短信</h2>
  </div>
  <div class="flex-1 overflow-y-auto p-4">

  <!-- SIM Card Selection -->
  <div class="mb-4 relative sim-input-container">
    <label
      for="sim-selection"
      class="block text-sm font-medium text-stone-600 mb-2"
    >
      发送卡号
    </label>
    <input
      id="sim-selection"
      type="text"
      value={selectedSimDisplay}
      onfocus={() => {
        showSimDropdown = true;
        simSearch = "";
      }}
      oninput={(e) => {
        showSimDropdown = true;
        simSearch = e.target.value;
        selectedSimDisplay = e.target.value;
        recipientSIM = "";
      }}
      placeholder="输入卡号筛选或选择发送卡..."
      class="w-full px-4 py-2 cyber-input"
    />

    <!-- SIM Cards Dropdown -->
    {#if showSimDropdown && filteredSims.length > 0}
      <div
        class="absolute top-full left-0 right-0 mt-1 tech-card border border-stone-200 rounded-lg shadow-xl shadow-gray-900 max-h-60 overflow-y-auto z-50"
      >
        <div class="p-2">
          <div
            class="text-xs text-stone-400 px-2 py-1 border-b border-stone-200 mb-1"
          >
            可用发送卡 ({filteredSims.length})
          </div>
          {#each filteredSims as phone}
            <button
              onclick={() => selectSim(phone)}
              class="w-full text-left px-3 py-2 hover:bg-stone-200 rounded-md transition-colors text-sm flex items-center gap-2"
            >
              <span class="text-lg">{phone.flag}</span>
              <div class="flex-1">
                <div class="font-mono">
                  {(phone.number && phone.number !== "null") ? phone.number : (phone.iccid ? `ICCID: ${phone.iccid.slice(-6)}` : "Unknown")}
                </div>
                {#if phone.operator_name}
                  <div class="text-xs text-stone-400">{phone.operator_name}</div>
                {/if}
              </div>
              {#if phone.signal_strength}
                <div class="text-xs text-stone-400">
                  信号: {phone.signal_strength}%
                </div>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <!-- Recipient Number -->
  <div class="mb-4 relative recipient-input-container">
    <label
      for="recipient-number"
      class="block text-sm font-medium text-stone-600 mb-2"
    >
      接收号码
    </label>
    <div class="flex gap-2">
      <!-- Country Code Selector -->
      <div class="relative country-code-container">
        <button
          type="button"
          onclick={() => showCountryDropdown = !showCountryDropdown}
          class="px-3 py-2 cyber-input flex items-center gap-1 min-w-[90px] justify-between"
        >
          <span class="font-mono">{selectedCountryCode}</span>
          <svg class="w-4 h-4 text-stone-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {#if showCountryDropdown}
          <div class="absolute top-full left-0 mt-1 tech-card border border-stone-200 rounded-lg shadow-xl shadow-gray-900 max-h-60 overflow-y-auto z-50 min-w-[200px]">
            <div class="p-2">
              {#each countryCodes as cc}
                <button
                  onclick={() => selectCountryCode(cc.code)}
                  class="w-full text-left px-3 py-2 hover:bg-stone-200 rounded-md transition-colors text-sm flex items-center gap-2 {selectedCountryCode === cc.code ? 'bg-stone-200' : ''}"
                >
                  <span class="font-mono w-12">{cc.code}</span>
                  <span class="text-stone-500">{cc.country}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
      <!-- Phone Number Input -->
      <input
        id="recipient-number"
        type="text"
        bind:value={recipientNumber}
        onfocus={() => (showRecipientHistory = true)}
        oninput={(e) => {
          showRecipientHistory = true;
          recipientSearch = e.target.value;
        }}
        placeholder="输入手机号..."
        class="flex-1 px-4 py-2 cyber-input"
      />
    </div>

    <!-- Recipient History Dropdown -->
    {#if showRecipientHistory && filteredRecipients.length > 0}
      <div
        class="absolute top-full left-0 right-0 mt-1 tech-card border border-stone-200 rounded-lg shadow-xl shadow-gray-900 max-h-48 overflow-y-auto z-50"
      >
        <div class="p-2">
          <div
            class="text-xs text-stone-400 px-2 py-1 border-b border-stone-200 mb-1"
          >
            历史接收号码
          </div>
          {#each filteredRecipients as recipient}
            <button
              onclick={() => selectRecipient(recipient)}
              class="w-full text-left px-3 py-2 hover:bg-stone-200 rounded-md transition-colors text-sm flex items-center gap-2"
            >
              <svg
                class="w-4 h-4 text-stone-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span class="font-mono">{recipient}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <!-- Message Templates -->
  <div class="mb-4">
    <div
      id="template-label"
      class="block text-sm font-medium text-stone-600 mb-2"
    >
      快速模板
    </div>
    <div
      class="flex flex-wrap gap-2"
      role="group"
      aria-labelledby="template-label"
    >
      {#each messageTemplates as template}
        <button
          onclick={() => insertTemplate(template.content)}
          class="px-3 py-1 text-xs bg-stone-100 text-stone-600 border border-stone-200 rounded-full hover:bg-stone-200 transition-colors"
        >
          {template.name}
        </button>
      {/each}
    </div>
  </div>

  <!-- Message Content -->
  <div class="mb-4">
    <label
      for="message-content"
      class="block text-sm font-medium text-stone-600 mb-2"
    >
      短信内容
    </label>
    <textarea
      id="message-content"
      bind:value={messageContent}
      placeholder="输入短信内容..."
      rows="4"
      class="w-full px-4 py-2 cyber-input resize-none"
    ></textarea>
    <div class="mt-1 text-xs text-stone-400">
      字数：{messageContent.length} / 500
    </div>
  </div>

  <!-- Send Button -->
  <button
    onclick={handleSend}
    disabled={sendingStatus === "sending"}
    class="w-full py-3 font-medium rounded-lg transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed text-white {sendingStatus === 'success' ? 'bg-emerald-500 hover:bg-emerald-600' : sendingStatus === 'validation-error' || sendingStatus === 'send-error' ? 'bg-red-500 hover:bg-red-600' : 'bg-orange-500 hover:bg-orange-600'}"
  >
    {#if sendingStatus === "sending"}
      <span class="flex items-center justify-center">
        <svg
          class="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          ></circle>
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          ></path>
        </svg>
        发送中...
      </span>
    {:else if sendingStatus === "success"}
      ✅ 发送成功
    {:else if sendingStatus === "validation-error"}
      ❌ 请填写完整信息
    {:else if sendingStatus === "send-error"}
      ❌ 发送失败，请重试
    {:else}
      发送短信
    {/if}
  </button>
  </div><!-- end scrollable content -->
</div>

<!-- Mobile route content. The App owns the header and persistent bottom tab bar. -->
{#if mobilePage}
  <section
    data-mobile-composer
    class="lg:hidden min-h-[calc(100dvh-126px)] bg-white"
    aria-labelledby="mobile-composer-title"
  >
    <div
      class="sticky top-[52px] z-10 bg-white border-b border-stone-200 px-4 py-3"
    >
      <h2
        id="mobile-composer-title"
        class="text-lg font-bold data-value header-effect-target"
      >
        发送短信
      </h2>
    </div>

    <div class="p-4">
      <!-- SIM Card Selection -->
      <div class="mb-4 relative sim-input-container">
        <label
          for="mobile-sim-selection"
          class="block text-sm font-medium text-stone-600 mb-2"
        >
          发送卡号
        </label>
        <input
          id="mobile-sim-selection"
          type="text"
          value={selectedSimDisplay}
          onfocus={() => {
            showSimDropdown = true;
            simSearch = "";
          }}
          oninput={(e) => {
            showSimDropdown = true;
            simSearch = e.target.value;
            selectedSimDisplay = e.target.value;
            recipientSIM = "";
          }}
          placeholder="输入卡号筛选或选择发送卡..."
          class="w-full px-4 py-2 cyber-input"
        />

        <!-- SIM Cards Dropdown -->
        {#if showSimDropdown && filteredSims.length > 0}
          <div
            class="absolute top-full left-0 right-0 mt-1 tech-card border border-stone-200 rounded-lg shadow-xl shadow-gray-900 max-h-60 overflow-y-auto z-50"
          >
            <div class="p-2">
              <div
                class="text-xs text-stone-400 px-2 py-1 border-b border-stone-200 mb-1"
              >
                可用发送卡 ({filteredSims.length})
              </div>
              {#each filteredSims as phone}
                <button
                  onclick={() => selectSim(phone)}
                  class="w-full text-left px-3 py-2 hover:bg-stone-200 rounded-md transition-colors text-sm flex items-center gap-2"
                >
                  <span class="text-lg">{phone.flag}</span>
                  <div class="flex-1">
                    <div class="font-mono">
                      {(phone.number && phone.number !== "null") ? phone.number : (phone.iccid ? `ICCID: ${phone.iccid.slice(-6)}` : "Unknown")}
                    </div>
                    {#if phone.operator_name}
                      <div class="text-xs text-stone-400">{phone.operator_name}</div>
                    {/if}
                  </div>
                  {#if phone.signal_strength}
                    <div class="text-xs text-stone-400">
                      信号: {phone.signal_strength}%
                    </div>
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <!-- Recipient Number -->
      <div class="mb-4 relative recipient-input-container">
        <label
          for="mobile-recipient-number"
          class="block text-sm font-medium text-stone-600 mb-2"
        >
          接收号码
        </label>
        <div class="flex gap-2">
          <!-- Country Code Selector -->
          <div class="relative country-code-container">
            <button
              type="button"
              onclick={() => showCountryDropdown = !showCountryDropdown}
              class="px-3 py-2 cyber-input flex items-center gap-1 min-w-[90px] justify-between"
            >
              <span class="font-mono">{selectedCountryCode}</span>
              <svg class="w-4 h-4 text-stone-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {#if showCountryDropdown}
              <div class="absolute top-full left-0 mt-1 tech-card border border-stone-200 rounded-lg shadow-xl shadow-gray-900 max-h-60 overflow-y-auto z-50 min-w-[200px]">
                <div class="p-2">
                  {#each countryCodes as cc}
                    <button
                      onclick={() => selectCountryCode(cc.code)}
                      class="w-full text-left px-3 py-2 hover:bg-stone-200 rounded-md transition-colors text-sm flex items-center gap-2 {selectedCountryCode === cc.code ? 'bg-stone-200' : ''}"
                    >
                      <span class="font-mono w-12">{cc.code}</span>
                      <span class="text-stone-500">{cc.country}</span>
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
          <!-- Phone Number Input -->
          <input
            id="mobile-recipient-number"
            type="text"
            bind:value={recipientNumber}
            onfocus={() => (showRecipientHistory = true)}
            oninput={(e) => {
              showRecipientHistory = true;
              recipientSearch = e.target.value;
            }}
            placeholder="输入手机号..."
            class="flex-1 px-4 py-2 cyber-input"
          />
        </div>

        <!-- Recipient History Dropdown -->
        {#if showRecipientHistory && filteredRecipients.length > 0}
          <div
            class="absolute top-full left-0 right-0 mt-1 tech-card border border-stone-200 rounded-lg shadow-xl shadow-gray-900 max-h-48 overflow-y-auto z-50"
          >
            <div class="p-2">
              <div
                class="text-xs text-stone-400 px-2 py-1 border-b border-stone-200 mb-1"
              >
                历史接收号码
              </div>
              {#each filteredRecipients as recipient}
                <button
                  onclick={() => selectRecipient(recipient)}
                  class="w-full text-left px-3 py-2 hover:bg-stone-200 rounded-md transition-colors text-sm flex items-center gap-2"
                >
                  <svg
                    class="w-4 h-4 text-stone-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <span class="font-mono">{recipient}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <!-- Message Templates -->
      <div class="mb-4">
        <div
          id="mobile-template-label"
          class="block text-sm font-medium text-stone-600 mb-2"
        >
          快速模板
        </div>
        <div
          class="flex flex-wrap gap-2"
          role="group"
          aria-labelledby="mobile-template-label"
        >
          {#each messageTemplates as template}
            <button
              onclick={() => insertTemplate(template.content)}
              class="px-3 py-1 text-xs bg-stone-100 text-stone-600 border border-stone-200 rounded-full hover:bg-stone-200 transition-colors"
            >
              {template.name}
            </button>
          {/each}
        </div>
      </div>

      <!-- Message Content -->
      <div class="mb-4">
        <label
          for="mobile-message-content"
          class="block text-sm font-medium text-stone-600 mb-2"
        >
          短信内容
        </label>
        <textarea
          id="mobile-message-content"
          bind:value={messageContent}
          placeholder="输入短信内容..."
          rows="4"
          class="w-full px-4 py-2 cyber-input resize-none"
        ></textarea>
        <div class="mt-1 text-xs text-stone-400">
          字数：{messageContent.length} / 500
        </div>
      </div>

      <!-- Send Button -->
      <button
        onclick={handleSend}
        disabled={sendingStatus === "sending"}
        class="w-full py-3 font-medium rounded-lg transition-all duration-300 text-white
          disabled:opacity-50 disabled:cursor-not-allowed
          {sendingStatus === 'success'
            ? 'bg-emerald-500 hover:bg-emerald-600'
            : sendingStatus === 'validation-error' || sendingStatus === 'send-error'
              ? 'bg-red-500 hover:bg-red-600'
              : 'bg-orange-500 hover:bg-orange-600'}"
      >
        {#if sendingStatus === "sending"}
          <span class="flex items-center justify-center">
            <svg
              class="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                class="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                stroke-width="4"
              ></circle>
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              ></path>
            </svg>
            发送中...
          </span>
        {:else if sendingStatus === "success"}
          ✅ 发送成功
        {:else if sendingStatus === "validation-error"}
          ❌ 请填写完整信息
        {:else if sendingStatus === "send-error"}
          ❌ 发送失败，请重试
        {:else}
          发送短信
        {/if}
      </button>
    </div>
  </section>
{/if}
