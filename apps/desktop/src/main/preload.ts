import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-contract';

const api = {
  platform: process.platform,
  port: 3001,
  onboarding: {
    state: () => ipcRenderer.invoke(IPC_CHANNELS['onboarding:state']),
    validateProvider: (req: {
      provider: string;
      apiKey: string;
      baseUrl?: string;
      model?: string;
    }) => ipcRenderer.invoke(IPC_CHANNELS['onboarding:validateProvider'], req),
    complete: (req: { provider: string; model: string; apiKey: string; personalityId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS['onboarding:complete'], req),
  },
  personalities: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS['personalities:list']),
  },
  backend: {
    getPort: () => ipcRenderer.invoke(IPC_CHANNELS['backend:port']),
    start: (req: { port: number }) => ipcRenderer.invoke(IPC_CHANNELS['backend:start'], req),
  },
  health: {
    check: (req: { port: number }) => ipcRenderer.invoke(IPC_CHANNELS['health:check'], req),
  },
  theme: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS['theme:get']),
  },
  settings: {
    getAdvancedMode: () => ipcRenderer.invoke(IPC_CHANNELS['advancedMode:get']),
    setAdvancedMode: (req: { enabled: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS['advancedMode:set'], req),
    setTheme: (req: { theme: 'dark' | 'light' | 'system' }) =>
      ipcRenderer.invoke(IPC_CHANNELS['theme:set'], req),
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS['config:get']),
    updateConfig: (req: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC_CHANNELS['config:update'], req),
    openConfigFolder: () => ipcRenderer.invoke(IPC_CHANNELS['shell:openConfigFolder']),
    exportData: () => ipcRenderer.invoke(IPC_CHANNELS['export:data']),
    pruneRetention: (req: {
      retentionDays: number;
      traceLogDays: number;
      observabilityDays: number;
    }) => ipcRenderer.invoke(IPC_CHANNELS['retention:prune'], req),
  },
  navigate: {
    onSession: (cb: (sessionId: string) => void) => {
      const listener = (_e: unknown, sessionId: string) => cb(sessionId);
      ipcRenderer.on('navigate:session', listener);
      return () => {
        ipcRenderer.removeListener('navigate:session', listener);
      };
    },
  },
  keychain: {
    set: (req: { key: string; value: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS['keychain:set'], req),
    preview: (req: { key: string }) => ipcRenderer.invoke(IPC_CHANNELS['keychain:preview'], req),
  },
};

contextBridge.exposeInMainWorld('ethos', api);

export type EthosApi = typeof api;
