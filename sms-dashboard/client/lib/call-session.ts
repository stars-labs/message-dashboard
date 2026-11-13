// One browser-side voice call: microphone, RTCPeerConnection to the Realtime
// SFU, and the Worker round trips that bridge it to the modem on the Pi.
//
//   getUserMedia -> offer -> dial|answer (Worker publishes the mic, returns answer)
//   -> wait for the PeerConnection -> connect (Worker creates the Pi adapters and
//   pulls the modem track) -> renegotiate when the SFU asks for it.
//
// Every browser API is injected so the sequence is testable without WebRTC.

/** A PeerConnection that has not connected in this long will not connect. */
export const CONNECT_TIMEOUT_MS = 15_000;

/** The PeerConnection surface this drives. */
interface ConnectionLike {
  connectionState: string;
  localDescription: { type: string; sdp: string } | null;
  ontrack: ((event: { streams?: MediaStream[]; track: MediaStreamTrack }) => void) | null;
  addTransceiver(track: MediaStreamTrack, init: { direction: string }): { mid: string | null };
  createOffer(): Promise<{ type: string; sdp: string }>;
  createAnswer(): Promise<{ type: string; sdp: string }>;
  setLocalDescription(description: unknown): Promise<void>;
  setRemoteDescription(description: unknown): Promise<void>;
  addEventListener(type: 'connectionstatechange', listener: () => void): void;
  removeEventListener(type: 'connectionstatechange', listener: () => void): void;
  close(): void;
}

/** The call API call-session drives, matching callApi in call-client.ts. */
export interface CallSessionApi {
  dial(params: { iccid: string; number: string; offer: unknown; mid: string | null }): Promise<{ call: { id: string }; answer: unknown }>;
  answer(params: { offer: unknown; mid: string | null }): Promise<{ call: { id: string }; answer: unknown }>;
  connect(callId: string): Promise<{ offer?: unknown }>;
  renegotiate(params: { answer: unknown; callId: string }): Promise<unknown>;
  hangup(callId?: string): Promise<unknown>;
}

export interface CallSessionDeps {
  fetchIce: () => Promise<RTCIceServer[]>;
  api: CallSessionApi;
  RTCPeerConnection: new (config: { iceServers: RTCIceServer[]; bundlePolicy: string }) => ConnectionLike;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  audioElement: HTMLAudioElement | null;
  connectTimeoutMs?: number;
}

function waitForConnected(pc: ConnectionLike, timeoutMs: number): Promise<void> {
  if (pc.connectionState === 'connected') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('音频连接超时'));
    }, timeoutMs);
    const onChange = () => {
      if (pc.connectionState === 'connected') {
        cleanup();
        resolve();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        cleanup();
        reject(new Error('音频连接失败'));
      }
    };
    function cleanup() {
      clearTimeout(timer);
      pc.removeEventListener('connectionstatechange', onChange);
    }
    pc.addEventListener('connectionstatechange', onChange);
  });
}

/**
 * @param {object} deps
 * @param {() => Promise<RTCIceServer[]>} deps.fetchIce
 * @param {{dial, answer, connect, renegotiate, hangup}} deps.api  see call-client.js callApi
 * @param {typeof RTCPeerConnection} deps.RTCPeerConnection
 * @param {(constraints: MediaStreamConstraints) => Promise<MediaStream>} deps.getUserMedia
 * @param {HTMLAudioElement} deps.audioElement  plays the far end
 * @param {number} [deps.connectTimeoutMs]
 */
export function createCallSession(deps: CallSessionDeps) {
  const { fetchIce, api, RTCPeerConnection, getUserMedia, audioElement } = deps;
  const connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

  let pc: ConnectionLike | null = null;
  let mic: MediaStream | null = null;
  let closed = false;
  let callId: string | null = null;

  function release() {
    closed = true;
    mic?.getTracks().forEach((track) => track.stop());
    mic = null;
    if (pc) {
      pc.ontrack = null;
      pc.close();
      pc = null;
    }
    if (audioElement) audioElement.srcObject = null;
  }

  function assertOpen() {
    if (closed) throw new Error('通话已结束');
  }

  /** `start` is api.dial or api.answer, bound to its own arguments. */
  async function run(start: (offer: { offer: unknown; mid: string | null }) => Promise<{ call: { id: string }; answer: unknown }>) {
    try {
      mic = await getUserMedia({ audio: true, video: false });
      assertOpen();
      const iceServers = await fetchIce();
      assertOpen();

      pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
      pc.ontrack = (event) => {
        if (audioElement) {
          audioElement.srcObject = event.streams?.[0] ?? new MediaStream([event.track]);
          audioElement.play?.().catch(() => {});
        }
      };
      const transceiver = pc.addTransceiver(mic.getAudioTracks()[0], { direction: 'sendrecv' });

      await pc.setLocalDescription(await pc.createOffer());
      const local = pc.localDescription!;
      const offer = { type: local.type, sdp: local.sdp };
      const started = await start({ offer, mid: transceiver.mid });
      assertOpen();
      callId = started.call.id;
      await pc.setRemoteDescription(started.answer);

      await waitForConnected(pc, connectTimeoutMs);
      assertOpen();

      const connected = await api.connect(callId);
      assertOpen();
      if (connected.offer) {
        await pc.setRemoteDescription(connected.offer);
        await pc.setLocalDescription(await pc.createAnswer());
        const localAnswer = pc.localDescription!;
        const answer = { type: localAnswer.type, sdp: localAnswer.sdp };
        await api.renegotiate({ answer, callId });
      }
    } catch (error) {
      const wasClosed = closed;
      release();
      if (!wasClosed && callId) await api.hangup(callId).catch(() => {});
      throw error;
    }
  }

  return {
    dial: ({ iccid, number }: { iccid: string; number: string }) => run(({ offer, mid }) => api.dial({ iccid, number, offer, mid })),
    answer: () => run(({ offer, mid }) => api.answer({ offer, mid })),
    /** Local hang-up: stop media and release the fleet lock. */
    async hangup() {
      release();
      if (callId) await api.hangup(callId);
    },
    /** The call ended elsewhere (far end, daemon, another tab): stop media only. */
    release,
    /**
     * Mute by disabling the microphone track rather than renegotiating: the
     * audio path stays up, so unmuting is instant and the far end hears nothing
     * in between.
     */
    setMuted(muted: boolean): boolean {
      mic?.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
      return Boolean(muted);
    },
    get muted(): boolean {
      const tracks = mic?.getAudioTracks() ?? [];
      return tracks.length > 0 && tracks.every((track) => track.enabled === false);
    },
    get active(): boolean {
      return !closed && pc !== null;
    },
  };
}
