import { describe, expect, test } from 'bun:test';
import { createCallSession } from './call-session.js';

type LogEntry = readonly [string, ...unknown[]];

interface FakeTrack {
  kind: string;
  enabled: boolean;
  stop(): void;
}

interface FakeStream {
  id: string;
}

interface Sdp {
  type: RTCSdpType;
  sdp: string;
}

/** Minimal fake PeerConnection that records the negotiation sequence. */
function fakePeerFactory(log: LogEntry[], { connect = true } = {}) {
  const created: FakePeer[] = [];
  class FakePeer {
    connectionState = 'new';
    localDescription: Sdp | null = null;
    ontrack: ((event: { streams: readonly FakeStream[]; track: FakeTrack }) => void) | null = null;
    private readonly listeners = new Set<() => void>();

    constructor(config: { iceServers: RTCIceServer[] }) {
      log.push(['pc', config.iceServers]);
      created.push(this);
    }

    addTransceiver(track: FakeTrack, init: { direction: string }) {
      log.push(['addTransceiver', track.kind, init.direction]);
      return { mid: '0' };
    }

    createOffer() {
      return Promise.resolve({ type: 'offer', sdp: 'local-offer' } as const);
    }

    createAnswer() {
      return Promise.resolve({ type: 'answer', sdp: 'local-answer' } as const);
    }

    setLocalDescription(desc: Sdp) {
      log.push(['setLocal', desc.type]);
      this.localDescription = desc;
      return Promise.resolve();
    }

    setRemoteDescription(desc: Sdp) {
      log.push(['setRemote', desc.type, desc.sdp]);
      if (desc.type === 'answer' && connect) {
        queueMicrotask(() => {
          this.connectionState = 'connected';
          this.listeners.forEach((fn) => {
            fn();
          });
        });
      }
      return Promise.resolve();
    }

    addEventListener(_name: string, fn: () => void) {
      this.listeners.add(fn);
    }

    removeEventListener(_name: string, fn: () => void) {
      this.listeners.delete(fn);
    }

    close() {
      log.push(['close']);
      this.connectionState = 'closed';
    }
  }
  return { FakePeer, created };
}

function fakeDeps({
  connectOffer = { type: 'offer', sdp: 'pull-offer' },
  connect = true,
  dialError = null,
}: {
  connectOffer?: { type: 'offer'; sdp: string } | null;
  connect?: boolean;
  dialError?: Error | null;
} = {}) {
  const log: LogEntry[] = [];
  const stopped: boolean[] = [];
  const track: FakeTrack = {
    kind: 'audio',
    enabled: true,
    stop: () => {
      stopped.push(true);
    },
  };
  const sfuAnswer = { type: 'answer', sdp: 'sfu-answer' } as const;
  const api = {
    dial: (args: object) => {
      log.push(['api.dial', args]);
      if (dialError) return Promise.reject(dialError);
      return Promise.resolve({ call: { id: 'c' }, answer: sfuAnswer });
    },
    answer: (args: object) => {
      log.push(['api.answer', args]);
      return Promise.resolve({ call: { id: 'c' }, answer: sfuAnswer });
    },
    connect: (callId: string) => {
      log.push(['api.connect', callId]);
      return Promise.resolve({ call: { id: 'c' }, offer: connectOffer });
    },
    renegotiate: (args: object) => {
      log.push(['api.renegotiate', args]);
      return Promise.resolve({ call: { id: 'c' } });
    },
    hangup: (callId?: string) => {
      log.push(['api.hangup', callId]);
      return Promise.resolve({ call: null });
    },
  };
  const peers = fakePeerFactory(log, { connect });
  const audioElement: { srcObject: FakeStream | null; play(): Promise<void> } = {
    srcObject: null,
    play: () => Promise.resolve(),
  };
  const deps = {
    api,
    fetchIce: () => Promise.resolve([{ urls: 'turn:x' }]),
    RTCPeerConnection: peers.FakePeer,
    getUserMedia: () =>
      Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track] }),
    streamOf: (only: FakeTrack): FakeStream => ({ id: `wrapped-${only.kind}` }),
    audioElement,
    connectTimeoutMs: 20,
  };
  return { deps, log, stopped, peers, track };
}

async function failureOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

function named(log: readonly LogEntry[], name: string): boolean {
  return log.some(([entry]) => entry === name);
}

describe('call session negotiation', () => {
  test('dial publishes the mic, connects, then answers the pull offer', async () => {
    const { deps, log } = fakeDeps();
    const session = createCallSession(deps);

    await session.dial({ iccid: '8965', number: '+6592953543' });

    expect(log).toEqual([
      ['pc', [{ urls: 'turn:x' }]],
      ['addTransceiver', 'audio', 'sendrecv'],
      ['setLocal', 'offer'],
      [
        'api.dial',
        {
          iccid: '8965',
          number: '+6592953543',
          offer: { type: 'offer', sdp: 'local-offer' },
          mid: '0',
        },
      ],
      ['setRemote', 'answer', 'sfu-answer'],
      ['api.connect', 'c'],
      ['setRemote', 'offer', 'pull-offer'],
      ['setLocal', 'answer'],
      ['api.renegotiate', { answer: { type: 'answer', sdp: 'local-answer' }, callId: 'c' }],
    ]);
    expect(session.active).toBe(true);
  });

  test('answer uses the answer route and skips renegotiation when none is required', async () => {
    const { deps, log } = fakeDeps({ connectOffer: null });
    const session = createCallSession(deps);

    await session.answer();

    const apiCalls = log.map(([name]) => name).filter((name) => name.startsWith('api.'));
    expect(apiCalls).toEqual(['api.answer', 'api.connect']);
  });

  test('the far-end track is played through the audio element', async () => {
    const { deps, peers, track } = fakeDeps();
    const session = createCallSession(deps);
    await session.dial({ iccid: '8965', number: '+6592953543' });

    const stream = { id: 'remote' };
    peers.created.at(-1)?.ontrack?.({ streams: [stream], track });
    expect(deps.audioElement.srcObject).toBe(stream);

    peers.created.at(-1)?.ontrack?.({ streams: [], track });
    expect(deps.audioElement.srcObject).toEqual({ id: 'wrapped-audio' });
  });

  test('mute disables the microphone track without renegotiating', async () => {
    const { deps, log, track } = fakeDeps();
    const session = createCallSession(deps);
    await session.dial({ iccid: '8965', number: '+6592953543' });
    const before = log.length;

    expect(session.setMuted(true)).toBe(true);
    expect(track.enabled).toBe(false);
    expect(session.muted).toBe(true);

    session.setMuted(false);
    expect(session.muted).toBe(false);
    expect(log).toHaveLength(before);
  });
});

describe('call session teardown', () => {
  test('hangup stops the mic, closes the connection and releases the lock', async () => {
    const { deps, log, stopped } = fakeDeps();
    const session = createCallSession(deps);
    await session.dial({ iccid: '8965', number: '+6592953543' });

    await session.hangup();

    expect(stopped).toHaveLength(1);
    expect(log.slice(-2)).toEqual([['close'], ['api.hangup', 'c']]);
    expect(session.active).toBe(false);
  });

  test('a connection that never comes up fails and hangs up', async () => {
    const { deps, log, stopped } = fakeDeps({ connect: false });
    const session = createCallSession(deps);

    expect(await failureOf(session.dial({ iccid: '8965', number: '+6592953543' }))).toBe(
      '音频连接超时',
    );

    expect(stopped).toHaveLength(1);
    expect(log.at(-1)).toEqual(['api.hangup', 'c']);
    expect(named(log, 'api.connect')).toBe(false);
  });

  test('a refused dial releases local media without leaving a peer open', async () => {
    const { deps, log, stopped } = fakeDeps({
      dialError: new Error('Another call is already active'),
    });
    const session = createCallSession(deps);

    expect(await failureOf(session.dial({ iccid: '8965', number: '+6592953543' }))).toBe(
      'Another call is already active',
    );

    expect(stopped).toHaveLength(1);
    expect(log).toContainEqual(['close']);
    expect(named(log, 'api.hangup')).toBe(false);
  });

  test('release mid-negotiation stops the sequence without a second hangup', async () => {
    const { deps, log } = fakeDeps();
    const session = createCallSession(deps);
    const original = deps.api.dial;
    deps.api.dial = (args) => {
      session.release();
      return original(args);
    };

    expect(await failureOf(session.dial({ iccid: '8965', number: '+6592953543' }))).toBe(
      '通话已结束',
    );

    expect(named(log, 'api.hangup')).toBe(false);
    expect(named(log, 'api.connect')).toBe(false);
  });
});
