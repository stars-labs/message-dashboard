import { describe, expect, test } from 'bun:test';
import { createRingtone } from './call-ringtone.js';

interface FakeNode {
  name: string;
}

function fakeAudioContext() {
  const created = { oscillators: 0, closed: false, resumed: false };
  const ignore = () => undefined;
  class FakeContext {
    currentTime = 0;
    destination: FakeNode = { name: 'destination' };
    createOscillator() {
      created.oscillators += 1;
      return {
        type: 'sine' as const,
        frequency: { value: 0 },
        connect: ignore,
        start: ignore,
        stop: ignore,
      };
    }
    createGain() {
      return {
        name: 'gain',
        gain: { setValueAtTime: ignore, exponentialRampToValueAtTime: ignore },
        connect: ignore,
      };
    }
    resume() {
      created.resumed = true;
    }
    close() {
      created.closed = true;
    }
  }
  return { FakeContext, created };
}

describe('incoming call ringtone', () => {
  test('rings on start and stops cleanly', () => {
    const { FakeContext, created } = fakeAudioContext();
    const ringtone = createRingtone(FakeContext);

    expect(ringtone.start()).toBe(true);
    expect(ringtone.ringing).toBe(true);
    expect(created.resumed).toBe(true);
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
    class Blocked extends fakeAudioContext().FakeContext {
      constructor() {
        super();
        throw new Error('autoplay blocked');
      }
    }
    const ringtone = createRingtone(Blocked);

    expect(ringtone.start()).toBe(false);
    expect(ringtone.ringing).toBe(false);
    expect(() => {
      ringtone.stop();
    }).not.toThrow();
  });

  test('without WebAudio there is no ringtone', () => {
    expect(createRingtone(undefined).start()).toBe(false);
    expect(createRingtone(null).start()).toBe(false);
  });
});
