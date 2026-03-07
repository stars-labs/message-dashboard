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
  let description = "";
  let saving = false;
  let error = null;

  $: if (phone) {
    carrier = phone.carrier || "";
    if (!country && phoneNumber) {
      country = inferCountryFromNumber(phoneNumber) || "";
    }
    description = `${phone.iccid} - ${phone.operator_name || "Unknown Operator"}`;
  }

  async function handleSave() {
    if (!phoneNumber.trim()) {
      error = "请输入电话号码";
      return;
    }

    saving = true;
    error = null;

    try {
      const response = await api.iccidMappings.create({
        iccid: phone.iccid,
        phone_number: phoneNumber,
        carrier: carrier || phone.carrier || "",
        country: country || "",
        description: description || "",
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
    description = "";
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
            for="dialog-description"
            class="block text-sm font-medium text-stone-500 mb-1">备注</label
          >
          <input
            id="dialog-description"
            type="text"
            bind:value={description}
            placeholder="可选的描述信息"
            class="w-full px-3 py-2 cyber-input"
          />
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
