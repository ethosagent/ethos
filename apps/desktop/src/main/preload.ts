import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-contract';

const api = {
  onboarding: {
    state: () => ipcRenderer.invoke(IPC_CHANNELS['onboarding:state']),
    validateProvider: (req: { provider: string; apiKey: string; baseUrl?: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS['onboarding:validateProvider'], req),
    complete: (req: { provider: string; model: string; apiKey: string; personalityId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS['onboarding:complete'], req),
  },
  personalities: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS['personalities:list']),
  },
  health: {
    check: (req: { port: number }) => ipcRenderer.invoke(IPC_CHANNELS['health:check'], req),
  },
  theme: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS['theme:get']),
  },
};

contextBridge.exposeInMainWorld('ethos', api);

export type EthosApi = typeof api;
