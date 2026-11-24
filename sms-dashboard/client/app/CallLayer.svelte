<script lang="ts">
  import type { MeResponse } from '../../shared/api/auth.js';
  import CallPanel from '../lib/CallPanel.svelte';
  import { isDaemonConnected } from '../lib/daemon-status.js';
  import { overlay } from '../lib/overlay.js';
  import type { CallController } from './call-controller.svelte.js';
  import type { Permission, ViewPhone } from './types.js';

  interface Props {
    user: MeResponse['user'] | null;
    can: Permission;
    calls: CallController;
    phoneNumbers: ViewPhone[];
    daemonStatus: string;
  }

  let { user, can, calls, phoneNumbers, daemonStatus }: Props = $props();
</script>

{#if user && can('messages.read')}
  <!-- Far-end call audio. Always mounted so a session can attach to it at once. -->
  <audio bind:this={calls.audio} autoplay class="hidden"></audio>
{/if}

{#if calls.showPanel && user}
  <!-- Desktop: a panel under the top bar. Mobile: a sheet above the tab bar. -->
  <div
    role="dialog"
    aria-modal="false"
    aria-label="语音通话"
    use:overlay={{ onClose: calls.closePanel }}
    class="fixed z-[60] left-3 right-3 bottom-[calc(var(--mobile-tab-bar-height)+18px)]
      lg:left-auto lg:right-5 lg:top-[58px] lg:bottom-auto lg:w-[340px]
      shadow-[0_16px_40px_rgba(28,25,23,.18)] rounded-lg"
  >
    <CallPanel
      call={calls.activeCall}
      phones={phoneNumbers}
      busy={calls.busy}
      error={calls.error}
      muted={calls.muted}
      daemonOnline={isDaemonConnected(daemonStatus)}
      history={calls.history}
      historyLoading={calls.historyLoading}
      onDial={calls.dial}
      onAnswer={calls.answer}
      onHangup={calls.hangup}
      onToggleMute={calls.toggleMute}
      onClose={calls.closePanel}
    />
  </div>
{/if}
