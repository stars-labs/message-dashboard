import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';
import PullToRefresh from './PullToRefresh.svelte';

let originalMatchMedia;
let originalStandaloneDescriptor;

beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({ matches: false });
  originalStandaloneDescriptor = Object.getOwnPropertyDescriptor(
    window.navigator,
    'standalone',
  );
  Object.defineProperty(window.navigator, 'standalone', {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  if (originalStandaloneDescriptor) {
    Object.defineProperty(
      window.navigator,
      'standalone',
      originalStandaloneDescriptor,
    );
  } else {
    delete window.navigator.standalone;
  }
  cleanup();
});

function dispatchTouch(target, type, { x = 0, y = 0 } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touches = type === 'touchend' || type === 'touchcancel'
    ? []
    : [{ clientX: x, clientY: y }];
  Object.defineProperty(event, 'touches', { value: touches });
  target.dispatchEvent(event);
  return event;
}

describe('PullToRefresh', () => {
  test('does not bind the custom gesture in regular iOS Safari', async () => {
    Object.defineProperty(window.navigator, 'standalone', {
      configurable: true,
      value: false,
    });
    const original = Element.prototype.addEventListener;
    const registrations = [];
    Element.prototype.addEventListener = function addEventListener(type, ...args) {
      if (type.startsWith('touch') && this.hasAttribute?.('data-pull-to-refresh-root')) {
        registrations.push(type);
      }
      return original.call(this, type, ...args);
    };

    try {
      render(PullToRefresh);
      await tick();
      expect(registrations).toEqual([]);
    } finally {
      Element.prototype.addEventListener = original;
    }
  });

  test('binds the custom gesture in an iOS home-screen app', async () => {
    const original = Element.prototype.addEventListener;
    const registrations = [];
    Element.prototype.addEventListener = function addEventListener(type, ...args) {
      if (type.startsWith('touch') && this.hasAttribute?.('data-pull-to-refresh-root')) {
        registrations.push(type);
      }
      return original.call(this, type, ...args);
    };

    try {
      render(PullToRefresh);
      await tick();
      expect(registrations).toEqual(['touchstart', 'touchend', 'touchcancel']);
    } finally {
      Element.prototype.addEventListener = original;
    }
  });

  test('binds mobile touch listeners to a rendered box', () => {
    const { container } = render(PullToRefresh);
    const root = container.querySelector('[data-pull-to-refresh-root]');

    expect(root).toBeTruthy();
    expect(root.classList.contains('block')).toBe(true);
    expect(root.classList.contains('contents')).toBe(false);
  });

  test('does not permanently register a non-passive move listener', async () => {
    const original = Element.prototype.addEventListener;
    let registrations = 0;
    Element.prototype.addEventListener = function addEventListener(type, ...args) {
      if (type === 'touchmove' && this.hasAttribute?.('data-pull-to-refresh-root')) {
        registrations += 1;
      }
      return original.call(this, type, ...args);
    };

    try {
      render(PullToRefresh);
      await tick();
      expect(registrations).toBe(0);
    } finally {
      Element.prototype.addEventListener = original;
    }
  });

  test('uses a compositor transform instead of animating layout height', () => {
    const { container } = render(PullToRefresh);
    const indicator = container.querySelector('[data-pull-to-refresh-indicator]');

    expect(indicator).toBeTruthy();
    expect(indicator.style.transform).toContain('translate3d');
    expect(indicator.style.height).toBe('');
  });

  test('finger jitter does not cancel a tap', async () => {
    const { container } = render(PullToRefresh);
    const root = container.querySelector('[data-pull-to-refresh-root]');
    await tick();

    dispatchTouch(root, 'touchstart', { y: 100 });
    const move = dispatchTouch(root, 'touchmove', { y: 104 });
    dispatchTouch(root, 'touchend');

    expect(move.defaultPrevented).toBe(false);
  });

  test('an intentional pull is claimed and refreshes on release', async () => {
    let refreshes = 0;
    const { container } = render(PullToRefresh, {
      props: { onRefresh: () => { refreshes += 1; } },
    });
    const root = container.querySelector('[data-pull-to-refresh-root]');
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
      props: { onRefresh: () => { refreshes += 1; } },
    });
    const root = container.firstElementChild;
    await tick();

    dispatchTouch(root, 'touchstart', { y: 100 });
    dispatchTouch(root, 'touchmove', { y: 400 });
    dispatchTouch(root, 'touchcancel');

    expect(refreshes).toBe(0);
  });
});
