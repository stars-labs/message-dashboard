// One browser-side voice call: microphone, RTCPeerConnection to the Realtime
// SFU, and the Worker round trips that bridge it to the modem on the Pi.
//
//   getUserMedia -> offer -> dial|answer (Worker publishes the mic, returns answer)
//   -> wait for the PeerConnection -> connect (Worker creates the Pi adapters and
//   pulls the modem track) -> renegotiate when the SFU asks for it.
//
// Every browser API is injected so the sequence is testable without WebRTC.

/** A PeerConnection that has not connected in this long will not connect. */
const CONNECT_TIMEOUT_MS = 15_000;

/** The audio track surface this drives: MediaStreamTrack in a browser. */
interface TrackLike {
  enabled: boolean;
  stop(): void;
}

/** The microphone stream surface this drives: MediaStream in a browser. */
interface MicLike<Track> {
  getTracks(): Track[];
  getAudioTracks(): Track[];
}

/**
 * The PeerConnection surface this drives. `Track` and `Stream` are
 * MediaStreamTrack and MediaStream in a browser.
 */
interface ConnectionLike<Track, Stream> {
  connectionState: string;
  localDescription: { type: string; sdp: string } | null;
  ontrack: ((event: { streams: readonly Stream[]; track: Track }) => void) | null;
  addTransceiver(track: Track, init: { direction: 'sendrecv' }): { mid: string | null };
  createOffer(): Promise<{ type: string; sdp: string }>;
  createAnswer(): Promise<{ type: string; sdp: string }>;
  setLocalDescription(description: { type: string; sdp: string }): Promise<void>;
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void>;
  addEventListener(type: 'connectionstatechange', listener: () => void): void;
  removeEventListener(type: 'connectionstatechange', listener: () => void): void;
  close(): void;
}

/** An SDP offer or answer as the Worker returns it. */
interface Description {
  type: 'offer' | 'answer';
  sdp: string;
}

/** The call API call-session drives, matching callApi in call-client.ts. */
interface CallSessionApi {
  dial(params: {
    iccid: string;
    number: string;
    offer: unknown;
    mid: string | null;
  }): Promise<{ call: { id: string }; answer: Description }>;
  answer(params: {
    offer: unknown;
    mid: string | null;
  }): Promise<{ call: { id: string }; answer: Description }>;
  connect(callId: string): Promise<{ offer: Description | null }>;
  renegotiate(params: { answer: unknown; callId: string }): Promise<unknown>;
  hangup(callId?: string): Promise<unknown>;
}

interface CallSessionDeps<Track extends TrackLike, Stream> {
  fetchIce: () => Promise<RTCIceServer[]>;
  api: CallSessionApi;
  RTCPeerConnection: new (config: {
    iceServers: RTCIceServer[];
    bundlePolicy: 'max-bundle';
  }) => ConnectionLike<Track, Stream>;
  getUserMedia: (constraints: { audio: true; video: false }) => Promise<MicLike<Track>>;
  /** Wraps a far-end track that arrived without a stream: `new MediaStream([track])`. */
  streamOf: (track: Track) => Stream;
  audioElement: { srcObject: Stream | null; play(): Promise<void> } | null;
  connectTimeoutMs?: number;
}

function waitForConnected<Track, Stream>(
  pc: ConnectionLike<Track, Stream>,
  timeoutMs: number,
): Promise<void> {
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

export function createCallSession<Track extends TrackLike, Stream>(
  deps: CallSessionDeps<Track, Stream>,
) {
  const { fetchIce, api, RTCPeerConnection, getUserMedia, streamOf, audioElement } = deps;
  const connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

  let pc: ConnectionLike<Track, Stream> | null = null;
  let mic: MicLike<Track> | null = null;
  let closed = false;
  let callId: string | null = null;

  function release() {
    closed = true;
    mic?.getTracks().forEach((track) => {
      track.stop();
    });
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
  async function run(
    start: (offer: {
      offer: unknown;
      mid: string | null;
    }) => Promise<{ call: { id: string }; answer: Description }>,
  ) {
    try {
      const stream = await getUserMedia({ audio: true, video: false });
      mic = stream;
      assertOpen();
      const iceServers = await fetchIce();
      assertOpen();

      pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
      pc.ontrack = (event) => {
        if (audioElement) {
          audioElement.srcObject = event.streams[0] ?? streamOf(event.track);
          audioElement.play().catch(() => undefined);
        }
      };
      const [track] = stream.getAudioTracks();
      if (!track) throw new Error('麦克风没有可用的音轨');
      const transceiver = pc.addTransceiver(track, { direction: 'sendrecv' });

      await pc.setLocalDescription(await pc.createOffer());
      const local = pc.localDescription;
      if (!local) throw new Error('没能生成本地音频描述');
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
        const localAnswer = pc.localDescription;
        if (!localAnswer) throw new Error('没能生成本地音频应答');
        const answer = { type: localAnswer.type, sdp: localAnswer.sdp };
        await api.renegotiate({ answer, callId });
      }
    } catch (error) {
      const wasClosed = closed;
      release();
      if (!wasClosed && callId) await api.hangup(callId).catch(() => undefined);
      throw error;
    }
  }

  return {
    dial: ({ iccid, number }: { iccid: string; number: string }) =>
      run(({ offer, mid }) => api.dial({ iccid, number, offer, mid })),
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
      return muted;
    },
    get muted(): boolean {
      const tracks = mic?.getAudioTracks() ?? [];
      return tracks.length > 0 && tracks.every((track) => !track.enabled);
    },
    get active(): boolean {
      return !closed && pc !== null;
    },
  };
}
