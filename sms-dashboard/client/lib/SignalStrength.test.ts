import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import SignalStrength from './SignalStrength.svelte';

afterEach(cleanup);

function litBars(container: HTMLElement): number {
  return [...container.querySelectorAll('.w-1.rounded-sm')].filter(
    (bar) => !bar.classList.contains('bg-stone-200'),
  ).length;
}

describe('SignalStrength', () => {
  test('lights one bar per quarter of signal for an online modem', () => {
    for (const [signal, bars] of [
      [90, 4],
      [60, 3],
      [30, 2],
      [10, 1],
      [0, 0],
    ] as const) {
      const { container } = render(SignalStrength, {
        props: { signal, status: 'active', compact: true },
      });
      expect(litBars(container)).toBe(bars);
      cleanup();
    }
  });

  test('reads a missing signal as none', () => {
    const { container } = render(SignalStrength, {
      props: { signal: null, status: 'active', compact: true },
    });
    expect(litBars(container)).toBe(0);
  });

  test('labels the quality in the full view', () => {
    const { container } = render(SignalStrength, { props: { signal: 80, status: 'online' } });
    expect(container.textContent).toContain('优秀');
  });
});
