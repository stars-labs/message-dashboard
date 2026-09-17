import { describe, expect, test } from 'bun:test';
import { createRingtone } from './call-ringtone.js';

function fakeAudioContext() {
  const created = { oscillators: 0, closed: false, resumed: false };
  class FakeContext {
    constructor() { FakeContext.last = this; this.currentTime = 0; this.destination = {}; }
    createOscillator() {
      created.oscillators += 1;
      return { type: '', frequency: {}, connect() {}, start() {}, stop() {} };
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
      };
    }
    resume() { created.resumed = true; }
    close() { created.closed = true; }
  }
  return { FakeContext, created };
}

describe('incoming call ringtone', () => {
  test('rings on start and stops cleanly', () => {
    const { FakeContext, created } = fakeAudioContext();
    const ringtone = createRingtone(FakeContext);

    expect(ringtone.start()).toBe(true);
    expect(ringtone.ringing).toBe(true);
    expect(created.oscillators).toBeGreaterThan(0);

    ringtone.stop();
    expect(ringtone.ringing).toBe(false);
    expect(created.closed).toBe(true);
  });

  test('starting twice keeps a single pattern running', () => {
    const { FakeContext } = fakeAudioContext();
    const ringtone = createRingtone(FakeContext);

    ringtone.start();
    expect(ringtone.start()).toBe(false);
    ringtone.stop();
  });

  test('a browser that blocks audio does not break call handling', () => {
    const Blocked = function Blocked() { throw new Error('autoplay blocked'); };
    const ringtone = createRingtone(Blocked);

    expect(ringtone.start()).toBe(false);
    expect(ringtone.ringing).toBe(false);
    expect(() => ringtone.stop()).not.toThrow();
  });

  test('no AudioContext at all is handled', () => {
    const ringtone = createRingtone(undefined);
    expect(ringtone.start()).toBe(false);
  });
});
