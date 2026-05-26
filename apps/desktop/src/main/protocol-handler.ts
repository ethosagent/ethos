import { app, type BrowserWindow } from 'electron';
import type { NotificationRouter } from '@ethosagent/types';
import type { OAuthCoordinator } from '@ethosagent/plugin-sdk';

interface ProtocolHandlerDeps {
  getMainWindow: () => BrowserWindow | null;
  oauthCoordinator?: OAuthCoordinator;
  notificationRouter?: NotificationRouter;
}

export function registerProtocolHandler(deps: ProtocolHandlerDeps) {
  app.setAsDefaultProtocolClient('ethos');

  app.on('open-url', (_event, url) => {
    handleProtocolUrl(url, deps);
  });

  app.on('second-instance', (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith('ethos://'));
    if (url) handleProtocolUrl(url, deps);
  });
}

function handleProtocolUrl(url: string, deps: ProtocolHandlerDeps) {
  const parsed = new URL(url);
  const code = parsed.searchParams.get('code');
  const state = parsed.searchParams.get('state');
  if (!code || !state) return;

  if (parsed.host === 'oauth' && parsed.pathname === '/callback' && deps.oauthCoordinator && deps.notificationRouter) {
    deps.oauthCoordinator.handleCallback(code, state, deps.notificationRouter).catch(() => {
      // fail-open: OAuth callback errors are surfaced by the coordinator
    });
    return;
  }

  const win = deps.getMainWindow();
  if (win) {
    win.webContents.send('oauth:callback', { code, state });
  }
}
