import { describe, expect, test } from 'bun:test';
import { createMenuBarModel } from './menu-model.js';

function readyState(overrides = {}) {
  return {
    auth: 'signed_in',
    smsAi: 'ready',
    browser: 'ready',
    browserDetail: null,
    settings: {
      installationName: 'HMBP',
      dashboardUrl: 'https://sexy.qzz.io',
    },
    error: null,
    ...overrides,
  };
}

function item(model, id) {
  return model.items.find((candidate) => candidate.id === id);
}

function statusItems(model) {
  return model.items.filter((entry) => entry.id?.startsWith('status-'));
}

describe('Balance Agent menu bar model', () => {
  test('shows a compact ready menu with the actual launch-at-login state', () => {
    const model = createMenuBarModel(readyState(), { openAtLogin: true });
    expect(model.appearance).toBe('ready');
    expect(model.tooltip).toContain('就绪');
    expect(model.items.map((entry) => entry.label).filter(Boolean)).toContain('Balance Agent · HMBP');
    expect(item(model, 'agent-header').enabled).not.toBe(false);
    expect(statusItems(model).slice(0, 3).map((entry) => entry.indicator)).toEqual([
      'ready', 'ready', 'ready',
    ]);
    expect(statusItems(model).slice(0, 3).every((entry) => entry.enabled !== false)).toBe(true);
    expect(item(model, 'open-dashboard').enabled).toBe(true);
    expect(item(model, 'open-at-login')).toMatchObject({ type: 'checkbox', checked: true });
  });

  test('prioritizes human verification over ordinary busy state', () => {
    const model = createMenuBarModel(readyState({
      browser: 'busy',
      browserDetail: 'human_verification_required',
    }));
    expect(model.appearance).toBe('attention');
    expect(model.tooltip).toContain('需要操作');
    expect(item(model, 'show-verification').label).toBe('显示验证窗口');
    expect(item(model, 'status-browser')).toMatchObject({
      label: '浏览器查询 · 需要人工验证',
      indicator: 'attention',
    });
  });

  test('uses a busy presentation while a capability is processing', () => {
    const model = createMenuBarModel(readyState({ smsAi: 'busy' }));
    expect(model.appearance).toBe('busy');
    expect(model.tooltip).toContain('查询中');
    expect(item(model, 'status-sms-ai').indicator).toBe('attention');
  });

  test('disables Dashboard navigation until its URL is configured', () => {
    const model = createMenuBarModel({
      auth: 'signed_out',
      smsAi: 'stopped',
      browser: 'configuration_required',
      settings: {},
    });
    expect(model.appearance).toBe('idle');
    expect(item(model, 'open-dashboard').enabled).toBe(false);
    expect(statusItems(model).slice(0, 3).map((entry) => entry.indicator)).toEqual([
      'inactive', 'inactive', 'inactive',
    ]);
    expect(item(model, 'show-verification')).toBeUndefined();
  });

  test('surfaces a bounded error without expanding the menu indefinitely', () => {
    const model = createMenuBarModel(readyState({ error: 'x'.repeat(200) }));
    const error = model.items.find((entry) => entry.label?.startsWith('异常 ·'));
    expect(model.appearance).toBe('error');
    expect(error.indicator).toBe('error');
    expect(error.label.length).toBeLessThan(90);
  });
});
