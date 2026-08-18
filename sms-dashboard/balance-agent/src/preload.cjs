const { contextBridge, ipcRenderer } = require('electron');
// Route renderer console.* calls to the main-process log file via IPC transport.
require('electron-log/preload.js');

contextBridge.exposeInMainWorld('balanceAgent', {
  getState: () => ipcRenderer.invoke('agent:get-state'),
  saveSettings: (settings) => ipcRenderer.invoke('agent:save-settings', settings),
  testAI: (settings) => ipcRenderer.invoke('agent:test-ai', settings),
  testConfiguration: (settings) => ipcRenderer.invoke('agent:test-configuration', settings),
  signIn: () => ipcRenderer.invoke('agent:sign-in'),
  signOut: () => ipcRenderer.invoke('agent:sign-out'),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('agent:set-open-at-login', enabled),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('agent:state', handler);
    return () => ipcRenderer.removeListener('agent:state', handler);
  },
  onOpenAtLogin: (listener) => {
    const handler = (_event, enabled) => listener(enabled);
    ipcRenderer.on('agent:open-at-login', handler);
    return () => ipcRenderer.removeListener('agent:open-at-login', handler);
  },
});
