import { contextBridge, ipcRenderer } from 'electron';

const api = {
  platform: process.platform,
  chat: {
    send: (message: string) => ipcRenderer.invoke('chat:send', message),
    onStream: (cb: (chunk: string) => void) => {
      ipcRenderer.on('chat:stream', (_e: unknown, chunk: string) => cb(chunk));
      return () => {
        ipcRenderer.removeAllListeners('chat:stream');
      };
    },
    onDone: (cb: (fullText: string) => void) => {
      ipcRenderer.on('chat:done', (_e: unknown, text: string) => cb(text));
      return () => {
        ipcRenderer.removeAllListeners('chat:done');
      };
    },
  },
  quickChat: {
    close: () => ipcRenderer.send('quick-chat:close'),
    openInMain: () => ipcRenderer.send('quick-chat:open-in-main'),
  },
};

contextBridge.exposeInMainWorld('ethos', api);

export type QuickChatApi = typeof api;
