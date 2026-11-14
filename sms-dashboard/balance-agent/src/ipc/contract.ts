import * as v from 'valibot';
import { RUNNER_STATES } from '../../../shared/api/balance-runners.js';

export const CHANNEL = Object.freeze({
  getState: 'agent:get-state',
  saveSettings: 'agent:save-settings',
  testAI: 'agent:test-ai',
  testConfiguration: 'agent:test-configuration',
  signIn: 'agent:sign-in',
  signOut: 'agent:sign-out',
  setOpenAtLogin: 'agent:set-open-at-login',
  state: 'agent:state',
  openAtLogin: 'agent:open-at-login',
});

const Text = v.optional(v.pipe(v.string(), v.trim()), '');

export const Settings = v.object({
  dashboardUrl: Text,
  auth0Issuer: Text,
  auth0ClientId: Text,
  auth0Audience: Text,
  aiBaseUrl: Text,
  aiModel: Text,
  aiProtocol: Text,
  installationName: Text,
  installationId: Text,
});

export type Settings = v.InferOutput<typeof Settings>;

export const BLANK_SETTINGS: Settings = v.parse(Settings, {});

export const SettingsForm = v.object({
  ...v.partial(v.omit(Settings, ['installationId'])).entries,
  aiToken: v.optional(v.string()),
});

export type SettingsForm = v.InferInput<typeof SettingsForm>;

const CapabilityState = v.picklist([...RUNNER_STATES, 'stopped']);

export const AgentState = v.object({
  auth: v.picklist(['signed_out', 'authorizing', 'signed_in']),
  smsAi: CapabilityState,
  smsAiDetail: v.nullable(v.string()),
  browser: CapabilityState,
  browserDetail: v.nullable(v.string()),
  login: v.nullable(v.object({ userCode: v.string(), verificationUri: v.optional(v.string()) })),
  error: v.nullable(v.string()),
  settings: Settings,
  hasAiToken: v.boolean(),
  openAtLogin: v.boolean(),
});

export type AgentState = v.InferOutput<typeof AgentState>;

export const CheckResult = v.object({ ok: v.boolean(), message: v.string() });

export type CheckResult = v.InferOutput<typeof CheckResult>;

export const AiTestResult = v.variant('ok', [
  v.object({ ok: v.literal(true), latencyMs: v.number(), message: v.string() }),
  v.object({ ok: v.literal(false), message: v.string() }),
]);

export type AiTestResult = v.InferOutput<typeof AiTestResult>;

export const ConfigurationResults = v.object({
  dashboard: CheckResult,
  ai: AiTestResult,
  browser: CheckResult,
});

export type ConfigurationResults = v.InferOutput<typeof ConfigurationResults>;

export interface BalanceAgentApi {
  getState(): Promise<AgentState>;
  saveSettings(settings: SettingsForm): Promise<AgentState>;
  testAI(settings: SettingsForm): Promise<AiTestResult>;
  testConfiguration(settings: SettingsForm): Promise<ConfigurationResults>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  setOpenAtLogin(enabled: boolean): Promise<boolean>;
  onState(listener: (state: AgentState) => void): () => void;
  onOpenAtLogin(listener: (enabled: boolean) => void): () => void;
}
