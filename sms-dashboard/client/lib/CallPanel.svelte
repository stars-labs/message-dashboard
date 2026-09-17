<script>
  import {
    callElapsedSeconds,
    callOutcomeLabel,
    formatCallTime,
    isMissedCall,
    callSim,
    callStateLabel,
    callTone,
    canAnswer,
    canDial,
    canHangup,
    canReject,
    formatDuration,
    isValidE164,
    matchesPhoneQuery,
    normaliseNumber,
  } from './call-client.js';
  import { formatCardNumber } from './card-number.js';

  // Media (microphone, RTCPeerConnection) is owned by the parent and injected
  // through these callbacks, so this panel stays testable without a browser.
  let {
    call = null,
    phones = [],
    busy = false,
    error = null,
    muted = false,
    daemonOnline = true,
    history = [],
    historyLoading = false,
    onDial = null,
    onAnswer = null,
    onHangup = null,
    onToggleMute = null,
    onClose = null,
  } = $props();

  let number = $state('');
  let iccid = $state('');
  let simQuery = $state('');
  let simListOpen = $state(false);
  let localError = $state(null);
  let now = $state(Date.now());

  // The timer only ticks while a call is up, so an idle dashboard does no work.
  $effect(() => {
    if (!call || call.state === 'ringing') return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  let tone = $derived(callTone(call));
  let label = $derived(callStateLabel(call));
  let sim = $derived(callSim(call, phones));
  let elapsed = $derived(call && call.state !== 'ringing' ? callElapsedSeconds(call, now) : 0);

  let callable = $derived(phones.filter((phone) => phone.iccid && phone.number));
  let matches = $derived(callable.filter((phone) => matchesPhoneQuery(phone, simQuery)).slice(0, 40));
  let selected = $derived(callable.find((phone) => phone.iccid === iccid) ?? null);
  let normalised = $derived(normaliseNumber(number));
  let numberReady = $derived(isValidE164(normalised));
  let dialReady = $derived(Boolean(selected) && numberReady && daemonOnline && !busy);

  function pickSim(phone) {
    iccid = phone.iccid;
    simQuery = '';
    simListOpen = false;
    localError = null;
  }

  /** Tapping a log row loads it back into the dialer, ready to call again. */
  function reuse(entry) {
    const sim = callable.find((phone) => phone.iccid === entry.iccid);
    if (sim) {
      iccid = sim.iccid;
      simListOpen = false;
    }
    if (entry.remote_number) number = entry.remote_number;
    localError = sim ? null : '这通电话用的卡现在不可用，请另选一张卡';
  }

  function submitDial() {
    localError = null;
    if (!selected) {
      localError = '请选择用于拨出的卡';
      simListOpen = true;
      return;
    }
    if (!numberReady) {
      localError = '号码需为国际格式，例如 +6591234567';
      return;
    }
    onDial?.({ iccid, number: normalised });
  }

  const TONE_DOT = {
    ringing: 'bg-emerald-500 animate-pulse',
    active: 'bg-emerald-500',
    pending: 'bg-amber-500 animate-pulse',
    idle: 'bg-stone-300',
  };
</script>

<section
  aria-label="语音通话"
  class="bg-white border border-stone-200 rounded-lg overflow-hidden flex flex-col
    max-h-[min(80vh,560px)]"
>
  <header class="flex items-center gap-2 px-4 py-3 border-b border-stone-200 shrink-0">
    <span class="w-2 h-2 rounded-full shrink-0 {TONE_DOT[tone]}"></span>
    <div class="flex-1 min-w-0">
      <h2 class="text-sm font-semibold text-stone-900 leading-tight">
        {call ? label : '语音通话'}
      </h2>
      <p class="text-[11px] text-stone-400 mt-0.5 truncate">
        {#if call && sim}
          {formatCardNumber(sim.sim_index)} · {sim.number ?? sim.iccid}
        {:else if call}
          卡 {call.iccid}
        {:else}
          同一时间只能进行一路通话
        {/if}
      </p>
    </div>
    {#if onClose}
      <button
        type="button"
        onclick={() => onClose?.()}
        title="关闭"
        aria-label="关闭通话面板"
        class="w-8 h-8 flex items-center justify-center rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-700 shrink-0"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/>
        </svg>
      </button>
    {/if}
  </header>

  <!-- Screen readers get the state change even when the panel is not focused. -->
  <p class="sr-only" aria-live="polite">{call ? `${label}${call.number ? `，${call.number}` : ''}` : '没有进行中的通话'}</p>

  <div class="flex-1 overflow-y-auto">
    {#if call}
      <div class="px-4 py-4 space-y-4">
        <div class="text-center space-y-1">
          <p class="text-[11px] text-stone-400">
            {call.direction === 'inbound' ? '来电' : '呼叫'}
          </p>
          <p data-testid="call-number" class="text-xl font-mono font-semibold text-stone-900 tracking-tight break-all">
            {call.number ?? '未知号码'}
          </p>
          {#if call.state === 'ringing'}
            <p data-testid="call-state" class="text-xs text-emerald-600 font-medium">正在振铃…</p>
          {:else}
            <p data-testid="call-state" class="text-xs text-stone-500 font-mono tabular-nums">
              {label} · {formatDuration(elapsed)}
            </p>
          {/if}
        </div>

        {#if canAnswer(call)}
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              onclick={() => onHangup?.()}
              disabled={busy}
              class="h-11 rounded-md bg-red-600 text-white text-sm font-medium
                hover:bg-red-700 disabled:opacity-50"
            >拒接</button>
            <button
              type="button"
              onclick={() => onAnswer?.()}
              disabled={busy}
              class="h-11 rounded-md bg-emerald-600 text-white text-sm font-medium
                hover:bg-emerald-700 disabled:opacity-50"
            >接听</button>
          </div>
        {:else if canHangup(call)}
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              onclick={() => onToggleMute?.()}
              disabled={busy || call.state !== 'active'}
              aria-pressed={muted}
              class="h-11 rounded-md border text-sm font-medium disabled:opacity-40
                {muted
                  ? 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100'
                  : 'bg-white border-stone-200 text-stone-700 hover:bg-stone-50'}"
            >{muted ? '已静音' : '静音'}</button>
            <button
              type="button"
              onclick={() => onHangup?.()}
              disabled={busy}
              class="h-11 rounded-md bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50"
            >挂断</button>
          </div>
        {/if}
      </div>
    {:else if canDial(call)}
      <div class="px-4 py-3 space-y-3">
        <!-- SIM picker: 90+ cards, so it is a searchable list rather than a select. -->
        <div class="space-y-1">
          <span class="text-[11px] text-stone-500">用哪张卡拨出</span>
          {#if selected && !simListOpen}
            <button
              type="button"
              onclick={() => { simListOpen = true; }}
              class="w-full h-11 px-3 flex items-center gap-2 rounded-md border border-stone-200 bg-white
                text-left hover:bg-stone-50"
            >
              <span class="font-mono text-sm font-semibold text-stone-800 shrink-0">
                {formatCardNumber(selected.sim_index)}
              </span>
              {#if selected.flag}<span class="text-base leading-none shrink-0">{selected.flag}</span>{/if}
              <span class="font-mono text-[13px] text-stone-700 truncate">{selected.number}</span>
              <span class="ml-auto text-[11px] text-stone-400 shrink-0">更换</span>
            </button>
          {:else}
            <input
              bind:value={simQuery}
              onfocus={() => (simListOpen = true)}
              aria-label="搜索拨出卡"
              placeholder="卡号 / 号码 / 运营商 / ICCID"
              class="w-full h-11 rounded-md border border-stone-200 px-3 text-sm"
            />
            <div class="border border-stone-200 rounded-md divide-y divide-stone-100 max-h-48 overflow-y-auto">
              {#each matches as phone (phone.iccid)}
                <button
                  type="button"
                  onclick={() => pickSim(phone)}
                  class="w-full px-3 py-2.5 flex items-center gap-2 text-left hover:bg-stone-50
                    {phone.iccid === iccid ? 'bg-[#fff7ed]' : ''}"
                >
                  <span class="font-mono text-sm font-semibold text-stone-800 w-8 shrink-0">
                    {formatCardNumber(phone.sim_index)}
                  </span>
                  {#if phone.flag}<span class="text-base leading-none shrink-0">{phone.flag}</span>{/if}
                  <span class="font-mono text-[13px] text-stone-700 truncate">{phone.number}</span>
                  {#if phone.carrier}
                    <span class="ml-auto text-[11px] text-stone-400 shrink-0">{phone.carrier}</span>
                  {/if}
                </button>
              {:else}
                <p class="px-3 py-3 text-xs text-stone-400">没有匹配的卡</p>
              {/each}
            </div>
          {/if}
        </div>

        <label class="block space-y-1">
          <span class="text-[11px] text-stone-500">对方号码</span>
          <input
            bind:value={number}
            onkeydown={(event) => event.key === 'Enter' && dialReady && submitDial()}
            aria-label="对方号码"
            inputmode="tel"
            autocomplete="tel"
            placeholder="+6591234567"
            class="w-full h-11 rounded-md border px-3 text-sm font-mono
              {number && !numberReady ? 'border-amber-300 bg-amber-50' : 'border-stone-200'}"
          />
        </label>
        {#if number && !numberReady}
          <p class="text-[11px] text-amber-700">需要国际格式：国家码 + 号码，例如 +6591234567</p>
        {/if}

        <button
          type="button"
          onclick={submitDial}
          disabled={!dialReady}
          class="w-full h-11 rounded-md bg-emerald-600 text-white text-sm font-medium
            hover:bg-emerald-700 disabled:bg-stone-200 disabled:text-stone-400"
        >{busy ? '正在拨号…' : '拨打'}</button>

        {#if !daemonOnline}
          <p class="text-[11px] text-stone-500 bg-stone-50 border border-stone-200 rounded-md px-3 py-2">
            采集服务离线，现在无法拨打或接听。恢复后会自动可用。
          </p>
        {/if}
      </div>

      <!-- Call log. Tapping a row loads it back into the dialer. -->
      <div class="border-t border-stone-100">
        <p class="px-4 pt-3 pb-1 text-[11px] text-stone-400">通话记录</p>
        {#if historyLoading && history.length === 0}
          <p class="px-4 pb-3 text-xs text-stone-400">正在加载…</p>
        {:else if history.length === 0}
          <p class="px-4 pb-3 text-xs text-stone-400">还没有通话记录</p>
        {:else}
          <ul class="divide-y divide-stone-100">
            {#each history as entry (entry.id)}
              {@const missed = isMissedCall(entry)}
              <li>
                <button
                  type="button"
                  onclick={() => reuse(entry)}
                  class="w-full px-4 py-2.5 flex items-center gap-2.5 text-left hover:bg-stone-50"
                >
                  <!-- Inbound arrows point in, outbound point out; missed is red. -->
                  <svg
                    class="w-3.5 h-3.5 shrink-0 {missed ? 'text-rose-500' : entry.direction === 'inbound' ? 'text-emerald-600' : 'text-stone-400'}"
                    fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"
                  >
                    {#if entry.direction === 'inbound'}
                      <path stroke-linecap="round" stroke-linejoin="round" d="M19 5L9 15m0 0h6m-6 0V9"/>
                    {:else}
                      <path stroke-linecap="round" stroke-linejoin="round" d="M5 19L15 9m0 0H9m6 0v6"/>
                    {/if}
                  </svg>
                  <span class="flex-1 min-w-0">
                    <span class="block font-mono text-[13px] truncate {missed ? 'text-rose-700 font-medium' : 'text-stone-800'}">
                      {entry.remote_number ?? '未知号码'}
                    </span>
                    <span class="block text-[11px] text-stone-400 truncate">
                      {formatCardNumber(entry.sim_index)}
                      {#if entry.outcome !== 'answered'}· {callOutcomeLabel(entry)}{/if}
                    </span>
                  </span>
                  <span class="text-right shrink-0">
                    <span class="block text-[11px] text-stone-400 tabular-nums">{formatCallTime(entry.started_at)}</span>
                    {#if entry.outcome === 'answered'}
                      <span class="block text-[11px] text-stone-500 font-mono tabular-nums">
                        {formatDuration(entry.duration_seconds)}
                      </span>
                    {/if}
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </div>

  {#if localError || error}
    <p role="alert" class="px-4 py-2.5 text-xs text-rose-700 bg-rose-50 border-t border-rose-100 shrink-0">
      {localError ?? error}
    </p>
  {/if}
</section>
