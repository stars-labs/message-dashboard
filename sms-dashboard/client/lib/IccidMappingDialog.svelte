<script>
  import { api } from "./api";
  import { COUNTRIES, inferCountryFromNumber } from "./countries.js";
  import { SIM_SERVICE_TYPES, SIM_SERVICE_TYPE_SOURCES } from "./sim-service-type.js";
  import { SIM_ROLES } from "./sim-role.js";

  let {
    phone = null,
    show = $bindable(false),
    onsuccess = null,
    onclose = null,
  } = $props();

  let phoneNumber = $state("");
  let carrier = $state("");
  let country = $state("");
  let notes = $state("");
  let imei = $state("");
  let simIndex = $state("");
  let status = $state("");
  let serviceType = $state("unknown");
  let serviceTypeSource = $state("");
  let simRole = $state("standalone");
  let primaryIccid = $state("");
  let saving = $state(false);
  let error = $state(null);

  // Repopulate the form fields whenever a new phone is passed in. The legacy
  // version used a reactive `$: if (phone)` block; $effect tracks the same
  // dependency and runs after every change to `phone`.
  $effect(() => {
    if (!phone) return;
    phoneNumber = phone.phone_number || phone.number || "";
    carrier = phone.carrier || "";
    country = phone.country || "";
    notes = phone.notes || "";
    imei = phone.equipment_id || phone.imei || "";
    status = phone.is_active || phone.status || "inactive";
    serviceType = phone.service_type || "unknown";
    serviceTypeSource = phone.service_type_source || "";
    simRole = phone.sim_role || "standalone";
    primaryIccid = phone.primary_iccid || "";
    if (!country && phoneNumber) {
      country = inferCountryFromNumber(phoneNumber) || "";
    }
    simIndex = phone.sim_index !== null && phone.sim_index !== undefined
      ? String(phone.sim_index)
      : "";
  });

  async function handleSave() {
    if (!phoneNumber.trim()) {
      error = "请输入电话号码";
      return;
    }

    if (!simIndex || parseInt(simIndex) < 1 || parseInt(simIndex) > 95) {
      error = "请输入有效的 SIM 索引 (1-95)";
      return;
    }

    if (serviceType !== "unknown" && !serviceTypeSource) {
      error = "请选择计费类型的确认来源";
      return;
    }

    saving = true;
    error = null;

    try {
      const response = await api.iccidMappings.create({
        iccid: phone.iccid,
        phone_number: phoneNumber,
        sim_index: simIndex ? parseInt(simIndex) : null,
        country_code: country || null,
        carrier: carrier || null,
        imei: imei || null,
        notes: notes || null,
        service_type: serviceType,
        service_type_source: serviceType === "unknown" ? null : serviceTypeSource,
        sim_role: simRole,
        primary_iccid: simRole === "secondary" ? primaryIccid : null,
        // NO status field - computed dynamically by API
      });

      if (response.success) {
        onsuccess?.({
          phone_iccid: phone.iccid,
          phone_number: phoneNumber,
        });
        close();
      } else {
        error = response.error || "保存失败";
      }
    } catch (err) {
      error = err.message || "保存失败";
    } finally {
      saving = false;
    }
  }

  function close() {
    show = false;
    phoneNumber = "";
    carrier = "";
    country = "";
    notes = "";
    imei = "";
    simIndex = "";
    status = "";
    serviceType = "unknown";
    serviceTypeSource = "";
    error = null;
    onclose?.();
  }
</script>

{#if show && phone}
  <div
    class="fixed inset-0 bg-stone-900/50 flex items-center justify-center z-50 p-4"
  >
    <div class="tech-card max-w-md w-full max-h-full flex flex-col">
      <div class="p-4 sm:p-6 flex-shrink-0 border-b border-stone-100">
        <h3 class="text-lg font-bold data-value high-contrast">设置 ICCID 映射</h3>
      </div>

      <div class="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
        <div>
          <label
            for="dialog-iccid"
            class="block text-sm font-medium text-stone-500 mb-1">ICCID</label
          >
          <input
            id="dialog-iccid"
            type="text"
            value={phone.iccid}
            disabled
            class="w-full px-3 py-2 cyber-input bg-stone-50 text-stone-500 cursor-not-allowed font-mono text-sm"
          />
        </div>

        <div>
          <label
            for="dialog-phone-number"
            class="block text-sm font-medium text-stone-500 mb-1"
          >
            电话号码 <span class="text-red-500">*</span>
          </label>
          <input
            id="dialog-phone-number"
            type="tel"
            bind:value={phoneNumber}
            placeholder="+86138xxxxx 或 138xxxxx"
            class="w-full px-3 py-2 cyber-input"
          />
        </div>

        <div>
          <label
            for="dialog-country"
            class="block text-sm font-medium text-stone-500 mb-1">国家</label
          >
          <select
            id="dialog-country"
            bind:value={country}
            class="w-full px-3 py-2 cyber-input"
          >
            <option value="">选择国家...</option>
            {#each COUNTRIES as countryOption}
              <option value={countryOption.code}>
                {countryOption.flag} {countryOption.name}
              </option>
            {/each}
          </select>
        </div>

        <div>
          <label
            for="dialog-carrier"
            class="block text-sm font-medium text-stone-500 mb-1">运营商</label
          >
          <input
            id="dialog-carrier"
            type="text"
            bind:value={carrier}
            placeholder="例如: China Mobile, Singtel"
            class="w-full px-3 py-2 cyber-input"
          />
        </div>

        <div>
          <label
            for="dialog-sim-index"
            class="block text-sm font-medium text-stone-500 mb-1"
          >
            SIM 索引 (sim_index) <span class="text-red-500">*</span>
          </label>
          <input
            id="dialog-sim-index"
            type="number"
            bind:value={simIndex}
            placeholder="1-95"
            min="1"
            max="95"
            required
            class="w-full px-3 py-2 cyber-input"
          />
        </div>

        <div>
          <label for="dialog-service-type" class="block text-sm font-medium text-stone-500 mb-1">计费类型</label>
          <select
            id="dialog-service-type"
            bind:value={serviceType}
            onchange={() => { if (serviceType === "unknown") serviceTypeSource = ""; }}
            class="w-full px-3 py-2 cyber-input"
          >
            {#each SIM_SERVICE_TYPES as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>

        <div>
          <label for="dialog-service-type-source" class="block text-sm font-medium text-stone-500 mb-1">确认来源</label>
          <select
            id="dialog-service-type-source"
            bind:value={serviceTypeSource}
            disabled={serviceType === "unknown"}
            class="w-full px-3 py-2 cyber-input disabled:bg-stone-50 disabled:text-stone-300"
          >
            <option value="">选择确认来源...</option>
            {#each SIM_SERVICE_TYPE_SOURCES as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
          <p class="mt-1 text-xs text-stone-400">只能人工根据运营商账户、客服、合同/账单或明确服务短信确认。</p>
        </div>

        <div>
          <label for="dialog-sim-role" class="block text-sm font-medium text-stone-500 mb-1">主副卡</label>
          <select
            id="dialog-sim-role"
            bind:value={simRole}
            class="w-full px-3 py-2 cyber-input"
          >
            {#each SIM_ROLES as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
          <p class="mt-1 text-xs text-stone-400">中国 SIM 的主副卡关系。副卡余额随主卡,余额查询会跳过副卡。</p>
        </div>

        {#if simRole === "secondary"}
          <div>
            <label for="dialog-primary-iccid" class="block text-sm font-medium text-stone-500 mb-1">主卡 ICCID</label>
            <input
              id="dialog-primary-iccid"
              type="text"
              bind:value={primaryIccid}
              placeholder="粘贴主卡的 ICCID"
              required
              class="w-full px-3 py-2 cyber-input font-mono text-sm"
            />
          </div>
        {/if}

        <div>
          <label
            for="dialog-imei"
            class="block text-sm font-medium text-stone-500 mb-1">IMEI (设备绑定)</label
          >
          <input
            id="dialog-imei"
            type="text"
            bind:value={imei}
            placeholder="可选 - 指定此SIM卡应该在哪个设备"
            class="w-full px-3 py-2 cyber-input font-mono text-sm"
          />
        </div>

        <div>
          <label
            for="dialog-notes"
            class="block text-sm font-medium text-stone-500 mb-1">备注</label
          >
          <textarea
            id="dialog-notes"
            bind:value={notes}
            placeholder="可选的备注信息"
            rows="2"
            class="w-full px-3 py-2 cyber-input resize-none"
          ></textarea>
        </div>

        <!-- Status display (read-only, computed from hardware) -->
        <div>
          <label class="block text-sm font-medium text-stone-500 mb-1">状态</label>
          <div class="text-sm px-3 py-2 bg-stone-50 rounded-lg border border-stone-200">
            <span class:text-green-600={status === 'active'} class:text-stone-400={status === 'inactive'}>
              {status === 'active' ? '✓ 活动' : '○ 未激活'}
            </span>
            <span class="text-stone-400 ml-2">(自动检测)</span>
          </div>
        </div>

        {#if error}
          <div
            class="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg text-sm"
          >
            {error}
          </div>
        {/if}
      </div>

      <div class="p-4 sm:p-6 mt-auto flex justify-end gap-3 flex-shrink-0 border-t border-stone-100 bg-stone-50/50 rounded-b-xl">
        <button
          onclick={close}
          disabled={saving}
          class="px-4 py-2 tech-button disabled:opacity-50"
        >
          取消
        </button>
        <button
          onclick={handleSave}
          disabled={saving}
          class="px-4 py-2 bg-stone-800 text-white rounded-lg hover:bg-stone-900 transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {#if saving}
            <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
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
            保存中...
          {:else}
            保存
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}
