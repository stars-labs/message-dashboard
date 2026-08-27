import { describe, expect, test } from 'bun:test';
import { getMobileTabState } from './mobile-tab-state.js';

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
});
