import { contextBridge, ipcRenderer } from 'electron';

const api = {
  platform: process.platform,
  chat: {
    send: (message: string) => ipcRenderer.invoke('chat:send', { message }),
    onStream: (cb: (chunk: string) => void) => {
      const listener = (_e: unknown, chunk: string) => cb(chunk);
      ipcRenderer.on('chat:stream', listener);
      return () => {
        ipcRenderer.removeListener('chat:stream', listener);
      };
    },
    onDone: (cb: (fullText: string) => void) => {
      const listener = (_e: unknown, text: string) => cb(text);
      ipcRenderer.on('chat:done', listener);
      return () => {
        ipcRenderer.removeListener('chat:done', listener);
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
