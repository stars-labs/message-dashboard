<script>
  import { createEventDispatcher } from "svelte";
  import { api } from "./api";
  import { COUNTRIES, inferCountryFromNumber } from "./countries.js";

  export let phone = null;
  export let show = false;

  const dispatch = createEventDispatcher();

  let phoneNumber = "";
  let carrier = "";
  let country = "";
  let notes = "";
  let imei = "";
  let simIndex = "";
  let status = "";
  let saving = false;
  let error = null;

  $: if (phone) {
    phoneNumber = phone.phone_number || phone.number || "";
    carrier = phone.carrier || "";
    country = phone.country || "";
    notes = phone.notes || "";
    imei = phone.equipment_id || phone.imei || "";
    status = phone.is_active || phone.status || "inactive";
    if (!country && phoneNumber) {
      country = inferCountryFromNumber(phoneNumber) || "";
    }
    simIndex = phone.sim_index !== null && phone.sim_index !== undefined
      ? String(phone.sim_index)
      : "";
  }

  async function handleSave() {
    if (!phoneNumber.trim()) {
      error = "请输入电话号码";
      return;
    }

    if (!simIndex || parseInt(simIndex) < 1 || parseInt(simIndex) > 95) {
      error = "请输入有效的 SIM 索引 (1-95)";
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
        // NO status field - computed dynamically by API
      });

      if (response.success) {
        dispatch("success", {
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
    error = null;
    dispatch("close");
  }
</script>

{#if show && phone}
  <div
    class="fixed inset-0 bg-stone-900/50 flex items-center justify-center z-50"
  >
    <div class="tech-card max-w-md w-full mx-4">
      <h3 class="text-lg font-bold mb-4 data-value high-contrast">设置 ICCID 映射</h3>

      <div class="space-y-4">
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

      <div class="mt-6 flex justify-end gap-3">
        <button
          on:click={close}
          disabled={saving}
          class="px-4 py-2 tech-button disabled:opacity-50"
        >
          取消
        </button>
        <button
          on:click={handleSave}
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
