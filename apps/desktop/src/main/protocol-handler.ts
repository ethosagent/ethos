import { app, type BrowserWindow } from 'electron';

export function registerProtocolHandler(getMainWindow: () => BrowserWindow | null) {
  app.setAsDefaultProtocolClient('ethos');

  app.on('open-url', (_event, url) => {
    handleProtocolUrl(url, getMainWindow);
  });

  app.on('second-instance', (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith('ethos://'));
    if (url) handleProtocolUrl(url, getMainWindow);
  });
}

function handleProtocolUrl(url: string, getMainWindow: () => BrowserWindow | null) {
  const parsed = new URL(url);
  const code = parsed.searchParams.get('code');
  const state = parsed.searchParams.get('state');
  if (!code || !state) return;
  const win = getMainWindow();
  if (win) {
    win.webContents.send('oauth:callback', { code, state });
  }
}
