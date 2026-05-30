import type { OAuthCoordinator } from '@ethosagent/plugin-sdk';
import type { NotificationRouter } from '@ethosagent/types';
import { app, type BrowserWindow } from 'electron';

interface ProtocolHandlerDeps {
  getMainWindow: () => BrowserWindow | null;
  oauthCoordinator?: OAuthCoordinator;
  notificationRouter?: NotificationRouter;
  onPluginOAuthCallback?: (opts: {
    pluginId: string;
    oauthRef: string;
    requestToken: string;
  }) => Promise<void>;
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

const PLUGIN_ID_MAP: Record<string, string> = {
  zerodha: 'tools-india-broker-zerodha',
};

function handleProtocolUrl(url: string, deps: ProtocolHandlerDeps) {
  const parsed = new URL(url);

  // Zerodha (and future plugin) OAuth callback: ethos://auth/<oauthRef>?request_token=XXX
  if (parsed.host === 'auth') {
    const oauthRef = parsed.pathname.replace(/^\//, '');
    const requestToken = parsed.searchParams.get('request_token');
    if (oauthRef && requestToken && deps.onPluginOAuthCallback) {
      const pluginId = PLUGIN_ID_MAP[oauthRef];
      if (pluginId) {
        deps.onPluginOAuthCallback({ pluginId, oauthRef, requestToken }).catch(() => {});
      }
    }
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.focus();
    }
    return;
  }

  const code = parsed.searchParams.get('code');
  const state = parsed.searchParams.get('state');
  if (!code || !state) return;

  if (
    parsed.host === 'oauth' &&
    parsed.pathname === '/callback' &&
    deps.oauthCoordinator &&
    deps.notificationRouter
  ) {
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
