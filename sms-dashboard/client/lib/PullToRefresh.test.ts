import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { tick } from 'svelte';
import PullToRefresh from './PullToRefresh.svelte';

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
let originalStandalone: PropertyDescriptor | undefined;

function mediaQueryList(media: string): MediaQueryList {
  return Object.assign(new EventTarget(), {
    matches: false,
    media,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
  });
}

function setStandalone(value: boolean): void {
  Object.defineProperty(window.navigator, 'standalone', { configurable: true, value });
}

beforeEach(() => {
  window.matchMedia = mediaQueryList;
  originalStandalone = Object.getOwnPropertyDescriptor(window.navigator, 'standalone');
  setStandalone(true);
});

afterEach(() => {
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  if (originalStandalone) {
    Object.defineProperty(window.navigator, 'standalone', originalStandalone);
  } else {
    Reflect.deleteProperty(window.navigator, 'standalone');
  }
  cleanup();
});

function element(container: HTMLElement, selector: string): HTMLElement {
  const found = container.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`no ${selector} rendered`);
  return found;
}

function dispatchTouch(target: HTMLElement, type: string, { x = 0, y = 0 } = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touches = type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }];
  Object.defineProperty(event, 'touches', { value: touches });
  target.dispatchEvent(event);
  return event;
}

/**
 * The touch listeners added to elements while `run` renders. Only the gesture
 * root adds any: PullToRefresh has no touch attributes for Svelte to delegate.
 */
async function touchListenersAdded(run: () => Promise<void>): Promise<string[]> {
  const spy = spyOn(Element.prototype, 'addEventListener');
  try {
    await run();
    return spy.mock.calls.map(([type]) => type).filter((type) => type.startsWith('touch'));
  } finally {
    spy.mockRestore();
  }
}

async function renderAndSettle(): Promise<void> {
  render(PullToRefresh);
  await tick();
}

describe('PullToRefresh', () => {
  test('does not bind the custom gesture in regular iOS Safari', async () => {
    setStandalone(false);

    expect(await touchListenersAdded(renderAndSettle)).toEqual([]);
  });

  test('binds the custom gesture in an iOS home-screen app, without a move listener', async () => {
    expect(await touchListenersAdded(renderAndSettle)).toEqual([
      'touchstart',
      'touchend',
      'touchcancel',
    ]);
  });

  test('binds mobile touch listeners to a rendered box', () => {
    const { container } = render(PullToRefresh);
    const root = element(container, '[data-pull-to-refresh-root]');

    expect(root.classList.contains('block')).toBe(true);
    expect(root.classList.contains('contents')).toBe(false);
  });

  test('uses a compositor transform instead of animating layout height', () => {
    const { container } = render(PullToRefresh);
    const indicator = element(container, '[data-pull-to-refresh-indicator]');

    expect(indicator.style.transform).toContain('translate3d');
    expect(indicator.style.height).toBe('');
  });

  test('positions the indicator in the viewport gap above the pulled content', () => {
    const { container } = render(PullToRefresh);
    const indicator = element(container, '[data-pull-to-refresh-indicator]');

    expect(indicator.classList.contains('fixed')).toBe(true);
    expect(indicator.classList.contains('absolute')).toBe(false);
    expect(indicator.classList.contains('top-[env(safe-area-inset-top)]')).toBe(true);
  });

  test('finger jitter does not cancel a tap', async () => {
    const { container } = render(PullToRefresh);
    const root = element(container, '[data-pull-to-refresh-root]');
    await tick();

    dispatchTouch(root, 'touchstart', { y: 100 });
    const move = dispatchTouch(root, 'touchmove', { y: 104 });
    dispatchTouch(root, 'touchend');

    expect(move.defaultPrevented).toBe(false);
  });

  test('an intentional pull is claimed and refreshes on release', async () => {
    let refreshes = 0;
    const { container } = render(PullToRefresh, {
      props: {
        onRefresh: () => {
          refreshes += 1;
        },
      },
    });
    const root = element(container, '[data-pull-to-refresh-root]');
    await tick();

    dispatchTouch(root, 'touchstart', { y: 100 });
    const move = dispatchTouch(root, 'touchmove', { y: 400 });
    dispatchTouch(root, 'touchend');

    expect(move.defaultPrevented).toBe(true);
    expect(refreshes).toBe(1);
  });

  test('a cancelled OS gesture never refreshes', async () => {
    let refreshes = 0;
    const { container } = render(PullToRefresh, {
      props: {
        onRefresh: () => {
          refreshes += 1;
        },
      },
    });
    const root = element(container, '[data-pull-to-refresh-root]');
    await tick();

    dispatchTouch(root, 'touchstart', { y: 100 });
    dispatchTouch(root, 'touchmove', { y: 400 });
    dispatchTouch(root, 'touchcancel');

    expect(refreshes).toBe(0);
  });
});
