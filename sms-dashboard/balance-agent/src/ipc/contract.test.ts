import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { AgentState, AiTestResult, BLANK_SETTINGS, SettingsForm } from './contract.js';

describe('IPC contract', () => {
  test('accepts a settings form and drops fields the renderer may not set', () => {
    const parsed = v.parse(SettingsForm, {
      dashboardUrl: ' https://dashboard.example ',
      installationId: 'forged',
      stray: 1,
      aiToken: ' secret ',
    });
    expect(parsed).toEqual({ dashboardUrl: 'https://dashboard.example', aiToken: ' secret ' });
  });

  test('rejects a settings form with a non-text value', () => {
    expect(v.safeParse(SettingsForm, { aiModel: 5 }).success).toBe(false);
    expect(v.safeParse(SettingsForm, null).success).toBe(false);
  });

  test('rejects a state the main process could not have sent', () => {
    const state = {
      auth: 'signed_out',
      smsAi: 'stopped',
      smsAiDetail: null,
      browser: 'ready',
      browserDetail: null,
      login: null,
      error: null,
      settings: BLANK_SETTINGS,
      hasAiToken: false,
      openAtLogin: false,
    };
    expect(v.safeParse(AgentState, state).success).toBe(true);
    expect(v.safeParse(AgentState, { ...state, auth: 'root' }).success).toBe(false);
    expect(v.safeParse(AgentState, { ...state, hasAiToken: 'yes' }).success).toBe(false);
  });

  test('tells a successful AI check from a failed one by its ok flag', () => {
    expect(v.safeParse(AiTestResult, { ok: true, latencyMs: 3, message: 'ok' }).success).toBe(true);
    expect(v.safeParse(AiTestResult, { ok: true, message: 'ok' }).success).toBe(false);
    expect(v.safeParse(AiTestResult, { ok: false, message: 'no' }).success).toBe(true);
  });
});
