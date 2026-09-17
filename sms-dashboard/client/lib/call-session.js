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

function waitForConnected(pc, timeoutMs) {
  if (pc.connectionState === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
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
export function createCallSession(deps) {
  const { fetchIce, api, RTCPeerConnection, getUserMedia, audioElement } = deps;
  const connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

  let pc = null;
  let mic = null;
  let closed = false;

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
  async function run(start) {
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
      const offer = { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
      const started = await start({ offer, mid: transceiver.mid });
      assertOpen();
      await pc.setRemoteDescription(started.answer);

      await waitForConnected(pc, connectTimeoutMs);
      assertOpen();

      const connected = await api.connect();
      assertOpen();
      if (connected.offer) {
        await pc.setRemoteDescription(connected.offer);
        await pc.setLocalDescription(await pc.createAnswer());
        const answer = { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
        await api.renegotiate({ answer });
      }
    } catch (error) {
      const wasClosed = closed;
      release();
      if (!wasClosed) await api.hangup().catch(() => {});
      throw error;
    }
  }

  return {
    dial: ({ iccid, number }) => run(({ offer, mid }) => api.dial({ iccid, number, offer, mid })),
    answer: () => run(({ offer, mid }) => api.answer({ offer, mid })),
    /** Local hang-up: stop media and release the fleet lock. */
    async hangup() {
      release();
      await api.hangup();
    },
    /** The call ended elsewhere (far end, daemon, another tab): stop media only. */
    release,
    /**
     * Mute by disabling the microphone track rather than renegotiating: the
     * audio path stays up, so unmuting is instant and the far end hears nothing
     * in between.
     */
    setMuted(muted) {
      mic?.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
      return Boolean(muted);
    },
    get muted() {
      const tracks = mic?.getAudioTracks() ?? [];
      return tracks.length > 0 && tracks.every((track) => track.enabled === false);
    },
    get active() {
      return !closed && pc !== null;
    },
  };
}
