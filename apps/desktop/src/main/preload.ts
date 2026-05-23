import { contextBridge, ipcRenderer } from 'electron';

const api = {
  onboarding: {
    state: () => ipcRenderer.invoke('onboarding:state'),
    validateProvider: (req: { provider: string; apiKey: string; baseUrl?: string }) =>
      ipcRenderer.invoke('onboarding:validateProvider', req),
    complete: (req: { provider: string; model: string; apiKey: string; personalityId: string }) =>
      ipcRenderer.invoke('onboarding:complete', req),
  },
  personalities: {
    list: () => ipcRenderer.invoke('personalities:list'),
  },
  keychain: {
    set: (req: { key: string; value: string }) => ipcRenderer.invoke('keychain:set', req),
    get: (req: { key: string }) => ipcRenderer.invoke('keychain:get', req),
  },
  health: {
    check: (req: { port: number }) => ipcRenderer.invoke('health:check', req),
  },
  theme: {
    get: () => ipcRenderer.invoke('theme:get'),
  },
};

contextBridge.exposeInMainWorld('ethos', api);

export type EthosApi = typeof api;
