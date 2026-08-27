import { describe, expect, test } from 'bun:test';
import {
  getMobileTabDragX,
  getMobileTabIndexAtPoint,
  getMobileTabs,
  getMobileTabState,
} from './mobile-tab-state.js';

describe('mobile tab selection state', () => {
  test('positions the balance tab after the device tab for an administrator', () => {
    expect(getMobileTabState({
      currentView: 'balances',
      showMoreMenu: false,
      canManagePhones: true,
    })).toEqual({ count: 5, index: 2 });
  });

  test('closes the device gap for a viewer', () => {
    expect(getMobileTabState({
      currentView: 'balances',
      showMoreMenu: false,
      canManagePhones: false,
    })).toEqual({ count: 4, index: 1 });
  });

  test('selects More for its sheet and nested routes', () => {
    expect(getMobileTabState({
      currentView: 'dashboard',
      showMoreMenu: true,
      canManagePhones: true,
    })).toEqual({ count: 5, index: 4 });
    expect(getMobileTabState({
      currentView: 'filters',
      showMoreMenu: false,
      canManagePhones: false,
    })).toEqual({ count: 4, index: 3 });
  });

  test('exposes the same ordered targets used by pointer navigation', () => {
    expect(getMobileTabs(true)).toEqual([
      'dashboard',
      'iccid-mappings',
      'balances',
      'send',
      'more',
    ]);
    expect(getMobileTabs(false)).toEqual([
      'dashboard',
      'balances',
      'send',
      'more',
    ]);
  });

  test('tracks the tab and continuous pill position under a pointer', () => {
    const geometry = { left: 0, width: 500, count: 5 };

    expect(getMobileTabIndexAtPoint({ clientX: 250, ...geometry })).toBe(2);
    expect(getMobileTabDragX({ clientX: 250, ...geometry })).toBe(200);
    expect(getMobileTabDragX({ clientX: -20, ...geometry })).toBe(0);
    expect(getMobileTabDragX({ clientX: 520, ...geometry })).toBe(400);
  });
});
