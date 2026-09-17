import { describe, expect, test } from 'bun:test';
import { createCallSession } from './call-session.js';

/** Minimal fake PeerConnection that records the negotiation sequence. */
function fakePeerFactory(log, { connect = true } = {}) {
  return class FakePeer {
    constructor(config) {
      log.push(['pc', config.iceServers]);
      this.connectionState = 'new';
      this.listeners = new Set();
      this.localDescription = null;
      FakePeer.last = this;
    }
    addTransceiver(track, init) {
      log.push(['addTransceiver', track.kind, init.direction]);
      return { mid: '0' };
    }
    async createOffer() {
      return { type: 'offer', sdp: 'local-offer' };
    }
    async createAnswer() {
      return { type: 'answer', sdp: 'local-answer' };
    }
    async setLocalDescription(desc) {
      log.push(['setLocal', desc.type]);
      this.localDescription = desc;
    }
    async setRemoteDescription(desc) {
      log.push(['setRemote', desc.type, desc.sdp]);
      if (desc.type === 'answer' && connect) {
        queueMicrotask(() => {
          this.connectionState = 'connected';
          this.listeners.forEach((fn) => fn());
        });
      }
    }
    addEventListener(_name, fn) {
      this.listeners.add(fn);
    }
    removeEventListener(_name, fn) {
      this.listeners.delete(fn);
    }
    close() {
      log.push(['close']);
      this.connectionState = 'closed';
    }
  };
}

function fakeDeps({ connectOffer = { type: 'offer', sdp: 'pull-offer' }, connect = true, dialError = null } = {}) {
  const log = [];
  const stopped = [];
  const track = { kind: 'audio', stop: () => stopped.push(true) };
  const api = {
    async dial(args) {
      log.push(['api.dial', args]);
      if (dialError) throw dialError;
      return { call: { id: 'c' }, answer: { type: 'answer', sdp: 'sfu-answer' } };
    },
    async answer(args) {
      log.push(['api.answer', args]);
      return { call: { id: 'c' }, answer: { type: 'answer', sdp: 'sfu-answer' } };
    },
    async connect() {
      log.push(['api.connect']);
      return { call: { id: 'c' }, offer: connectOffer };
    },
    async renegotiate(args) {
      log.push(['api.renegotiate', args]);
      return { call: { id: 'c' } };
    },
    async hangup() {
      log.push(['api.hangup']);
      return { call: null };
    },
  };
  const deps = {
    api,
    fetchIce: async () => [{ urls: 'turn:x' }],
    RTCPeerConnection: fakePeerFactory(log, { connect }),
    getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
    audioElement: { srcObject: null },
    connectTimeoutMs: 20,
  };
  return { deps, log, stopped };
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
      ['api.dial', { iccid: '8965', number: '+6592953543', offer: { type: 'offer', sdp: 'local-offer' }, mid: '0' }],
      ['setRemote', 'answer', 'sfu-answer'],
      ['api.connect'],
      ['setRemote', 'offer', 'pull-offer'],
      ['setLocal', 'answer'],
      ['api.renegotiate', { answer: { type: 'answer', sdp: 'local-answer' } }],
    ]);
    expect(session.active).toBe(true);
  });

  test('answer uses the answer route and skips renegotiation when none is required', async () => {
    const { deps, log } = fakeDeps({ connectOffer: null });
    const session = createCallSession(deps);

    await session.answer();

    const apiCalls = log.filter(([name]) => name.startsWith('api.')).map(([name]) => name);
    expect(apiCalls).toEqual(['api.answer', 'api.connect']);
  });

  test('the far-end track is played through the audio element', async () => {
    const { deps } = fakeDeps();
    const session = createCallSession(deps);
    await session.dial({ iccid: '8965', number: '+6592953543' });

    const stream = { id: 'remote' };
    deps.RTCPeerConnection.last.ontrack({ streams: [stream], track: {} });

    expect(deps.audioElement.srcObject).toBe(stream);
  });
});

describe('call session teardown', () => {
  test('hangup stops the mic, closes the connection and releases the lock', async () => {
    const { deps, log, stopped } = fakeDeps();
    const session = createCallSession(deps);
    await session.dial({ iccid: '8965', number: '+6592953543' });

    await session.hangup();

    expect(stopped).toHaveLength(1);
    expect(log.slice(-2)).toEqual([['close'], ['api.hangup']]);
    expect(session.active).toBe(false);
  });

  test('a connection that never comes up fails and hangs up', async () => {
    const { deps, log, stopped } = fakeDeps({ connect: false });
    const session = createCallSession(deps);

    await expect(session.dial({ iccid: '8965', number: '+6592953543' })).rejects.toThrow('音频连接超时');

    expect(stopped).toHaveLength(1);
    expect(log.at(-1)).toEqual(['api.hangup']);
    expect(log.some(([name]) => name === 'api.connect')).toBe(false);
  });

  test('a refused dial releases local media without leaving a peer open', async () => {
    const { deps, log, stopped } = fakeDeps({ dialError: new Error('Another call is already active') });
    const session = createCallSession(deps);

    await expect(session.dial({ iccid: '8965', number: '+6592953543' })).rejects.toThrow('Another call');

    expect(stopped).toHaveLength(1);
    expect(log).toContainEqual(['close']);
  });

  test('release mid-negotiation stops the sequence without a second hangup', async () => {
    const { deps, log } = fakeDeps();
    const session = createCallSession(deps);
    const original = deps.api.dial;
    deps.api.dial = async (args) => {
      session.release();
      return original(args);
    };

    await expect(session.dial({ iccid: '8965', number: '+6592953543' })).rejects.toThrow('通话已结束');

    expect(log.some(([name]) => name === 'api.hangup')).toBe(false);
    expect(log.some(([name]) => name === 'api.connect')).toBe(false);
  });
});
