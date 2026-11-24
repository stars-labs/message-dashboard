import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import * as v from 'valibot';
import {
  AgentState,
  AiTestResult,
  CHANNEL,
  ConfigurationResults,
  type BalanceAgentApi,
} from './ipc/contract.js';

const api: BalanceAgentApi = {
  getState: async () => v.parse(AgentState, await ipcRenderer.invoke(CHANNEL.getState)),
  saveSettings: async (settings) =>
    v.parse(AgentState, await ipcRenderer.invoke(CHANNEL.saveSettings, settings)),
  testAI: async (settings) =>
    v.parse(AiTestResult, await ipcRenderer.invoke(CHANNEL.testAI, settings)),
  testConfiguration: async (settings) =>
    v.parse(ConfigurationResults, await ipcRenderer.invoke(CHANNEL.testConfiguration, settings)),
  signIn: async () => {
    await ipcRenderer.invoke(CHANNEL.signIn);
  },
  signOut: async () => {
    await ipcRenderer.invoke(CHANNEL.signOut);
  },
  setOpenAtLogin: async (enabled) =>
    v.parse(v.boolean(), await ipcRenderer.invoke(CHANNEL.setOpenAtLogin, enabled)),
  onState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: unknown) => {
      listener(v.parse(AgentState, state));
    };
    ipcRenderer.on(CHANNEL.state, handler);
    return () => ipcRenderer.removeListener(CHANNEL.state, handler);
  },
  onOpenAtLogin: (listener) => {
    const handler = (_event: IpcRendererEvent, enabled: unknown) => {
      listener(v.parse(v.boolean(), enabled));
    };
    ipcRenderer.on(CHANNEL.openAtLogin, handler);
    return () => ipcRenderer.removeListener(CHANNEL.openAtLogin, handler);
  },
};

contextBridge.exposeInMainWorld('balanceAgent', api);
