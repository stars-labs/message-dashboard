import type { CallLogEntry, LiveCall } from '../../shared/api/calls.js';
import { textOr } from '../../shared/text.js';
import {
  callApi,
  callElapsedSeconds,
  callPollDelay,
  countMissedSince,
  describeCallError,
  fetchCallHistory,
  fetchCallState,
  fetchIceServers,
  formatDuration,
} from '../lib/call-client.js';
import { createRingtone } from '../lib/call-ringtone.js';
import { createCallSession } from '../lib/call-session.js';
import { isoNow } from '../lib/iso-time.js';
import type { Permission } from './types.js';

type CallSession = ReturnType<
  typeof createCallSession<MediaStreamTrack, MediaProvider, RTCTrackEvent>
>;

interface CallAccess {
  isSignedIn: () => boolean;
  can: Permission;
}

function readCallsSeenAt() {
  try {
    return localStorage.getItem('calls.seen_at');
  } catch {
    return null;
  }
}

async function fetchRtcIceServers(): Promise<RTCIceServer[]> {
  const servers = await fetchIceServers();
  return servers.map(({ urls, username, credential }) => ({
    urls,
    ...(username === undefined ? {} : { username }),
    ...(credential === undefined ? {} : { credential }),
  }));
}

export class CallController {
  showPanel = $state(false);
  activeCall = $state<LiveCall | null>(null);
  busy = $state(false);
  error = $state<string | null>(null);
  audio = $state<HTMLAudioElement | null>(null);
  muted = $state(false);
  history = $state<CallLogEntry[]>([]);
  historyLoading = $state(false);
  private seenAt = $state(readCallsSeenAt());
  private clock = $state(Date.now());
  // Non-reactive because it holds browser objects (microphone, PeerConnection).
  private session: CallSession | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight = false;
  private lastRingingCallId: string | null = null;
  private ringtone: ReturnType<typeof createRingtone> | null = null;
  private titleBeforeRing: string | null = null;
  private activeCallId: string | null = null;
  private readonly access: CallAccess;

  duration = $derived(
    this.activeCall && this.activeCall.state !== 'ringing'
      ? formatDuration(callElapsedSeconds(this.activeCall, this.clock))
      : null,
  );

  missedCount = $derived(countMissedSince(this.history, this.seenAt));

  constructor(access: CallAccess) {
    this.access = access;

    $effect(() => {
      if (!this.activeCall || this.activeCall.state === 'ringing') return;
      const timer = setInterval(() => (this.clock = Date.now()), 1000);
      return () => {
        clearInterval(timer);
      };
    });

    // Must be noticeable from another tab: ring and take over the tab title.
    $effect(() => {
      const call = this.activeCall;
      const ringing = call?.direction === 'inbound' && call.state === 'ringing';
      if (!ringing) {
        this.ringtone?.stop();
        if (this.titleBeforeRing !== null) {
          document.title = this.titleBeforeRing;
          this.titleBeforeRing = null;
        }
        return;
      }
      this.ringtone = this.ringtone ?? createRingtone<AudioNode>(window.AudioContext);
      this.ringtone.start();
      this.titleBeforeRing = this.titleBeforeRing ?? document.title;
      document.title = `☎ 来电 ${call.number ?? ''}`.trim();
    });
  }

  // Polling reads KV only (never D1) and pauses while the tab is hidden.
  // A timeout chain, not an interval, so the delay can follow the call state.
  startPolling() {
    if (this.pollTimer || !this.access.can('messages.read')) return;
    const tick = async () => {
      if (document.visibilityState === 'visible') await this.refresh();
      this.pollTimer = setTimeout(
        () => void tick(),
        callPollDelay({ call: this.activeCall, panelOpen: this.showPanel }),
      );
    };
    this.pollTimer = setTimeout(() => void tick(), 0);
    document.addEventListener('visibilitychange', this.pollWhenVisible);
  }

  // A ring that started while the tab was hidden must show immediately on return.
  private pollWhenVisible = () => {
    if (document.visibilityState === 'visible') void this.refresh();
  };

  stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    document.removeEventListener('visibilitychange', this.pollWhenVisible);
  }

  async refresh() {
    if (this.pollInFlight || !this.access.isSignedIn()) return;
    this.pollInFlight = true;
    try {
      this.applyState(await fetchCallState());
    } catch {
      // Keep the last known state; the next tick retries.
    } finally {
      this.pollInFlight = false;
    }
  }

  private applyState(call: LiveCall | null) {
    this.activeCall = call;
    // The call ended elsewhere (far end hung up, daemon, another tab): drop media.
    if (!call && this.session && !this.busy) {
      this.session.release();
      this.session = null;
      this.muted = false;
    }
    if (!call && this.activeCallId) void this.loadHistory();
    this.activeCallId = call?.id ?? null;
    // Surface a new incoming call once, without reopening a panel the user closed.
    if (
      call?.direction === 'inbound' &&
      call.state === 'ringing' &&
      call.id !== this.lastRingingCallId
    ) {
      this.lastRingingCallId = call.id;
      this.showPanel = true;
    }
  }

  async loadHistory() {
    if (!this.access.can('messages.read')) return;
    this.historyLoading = true;
    try {
      const { calls } = await fetchCallHistory({ limit: 30 });
      this.history = calls;
    } catch {
      // A failed log load must not disturb call control.
    } finally {
      this.historyLoading = false;
    }
  }

  openPanel() {
    this.showPanel = true;
    void this.refresh();
    const seenAt = isoNow();
    this.seenAt = seenAt;
    try {
      localStorage.setItem('calls.seen_at', seenAt);
    } catch {
      // Private windows refuse storage; the badge then just returns next reload.
    }
    void this.loadHistory();
  }

  togglePanel() {
    if (this.showPanel) {
      this.showPanel = false;
    } else {
      this.openPanel();
    }
  }

  closePanel = () => {
    this.showPanel = false;
  };

  private newSession() {
    this.session?.release();
    this.muted = false;
    this.session = createCallSession<MediaStreamTrack, MediaProvider, RTCTrackEvent>({
      fetchIce: fetchRtcIceServers,
      api: callApi,
      RTCPeerConnection: window.RTCPeerConnection,
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      streamOf: (track) => new MediaStream([track]),
      audioElement: this.audio,
    });
    return this.session;
  }

  private async runAction(action: () => Promise<unknown>) {
    this.busy = true;
    this.error = null;
    try {
      await action();
    } catch (error) {
      this.error = textOr(describeCallError(error), '通话操作失败');
      this.session = null;
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  dial = ({ iccid, number }: { iccid: string; number: string }) =>
    this.runAction(() => this.newSession().dial({ iccid, number }));

  answer = () => this.runAction(() => this.newSession().answer());

  toggleMute = () => {
    if (!this.session) return;
    this.muted = this.session.setMuted(!this.muted);
  };

  hangup = () =>
    this.runAction(async () => {
      if (this.session) {
        await this.session.hangup();
        this.session = null;
      } else if (this.activeCall?.id) {
        await callApi.hangup(this.activeCall.id);
      }
    });
}
