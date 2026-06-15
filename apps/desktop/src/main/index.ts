import type { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, nativeTheme, session, type Tray } from 'electron';
import { initAutoUpdater } from './auto-update';
import { restartBackendAsync, startBackend, startBackendAsync, stopBackend } from './backend';
import { registerGlobalShortcuts, unregisterGlobalShortcuts } from './global-shortcut';
import { registerIpcHandlers } from './ipc';
import { showMinimizeNotification } from './notifications';
import { registerProtocolHandler } from './protocol-handler';
import { registerQuickChatIpc, showQuickChat } from './quick-chat-window';
import { syncRemoteAuth } from './remote-auth';
import { isBackgroundMode, logBackgroundStartup } from './startup-mode';
import { store } from './store';
import { createTray, destroyTray } from './tray';

let mainWindow: BrowserWindow | null = null;
let trayInstance: Tray | null = null;
let isQuitting = false;
let desktopActivated = false;

function getDataDir(): string {
  return store.get('dataDir') ?? join(homedir(), '.ethos');
}

function readWebToken(): string | null {
  try {
    return readFileSync(join(getDataDir(), 'web-token'), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

async function loadSpaUrl(win: BrowserWindow, port: number): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const cookies = await session.defaultSession.cookies.get({
    url: baseUrl,
    name: 'ethos_auth',
  });
  if (cookies.length > 0) {
    win.loadURL(baseUrl);
    return;
  }
  const token = readWebToken();
  if (token) {
    win.loadURL(`${baseUrl}/auth/exchange?t=${token}`);
  } else {
    win.loadURL(baseUrl);
  }
}

function setupSpaCsp(): void {
  const isDev = process.env.NODE_ENV === 'development';
  const localConnect = isDev ? ' http://localhost:* ws://localhost:*' : '';
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*${localConnect}`,
    "img-src 'self' data: https:",
    "font-src 'self'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

async function startBackendWithRetry(port: number): Promise<number> {
  for (;;) {
    try {
      return await startBackendAsync(port);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'Ethos Backend Failed',
        message: `Could not start the backend server.\n\n${message}`,
        buttons: ['Retry', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 1) {
        app.quit();
        throw err;
      }
    }
  }
}

function activateDesktop(): void {
  if (desktopActivated) return;
  desktopActivated = true;
  const connMode = store.get('connectionMode') ?? 'local';
  if (connMode !== 'remote') {
    startBackend(3001);
  }
  trayInstance = createTray(() => mainWindow, createWindow);
  if (mainWindow && !mainWindow.isDestroyed()) {
    registerGlobalShortcuts(mainWindow, showQuickChat);
  }
}

async function createWindow(): Promise<void> {
  const bounds = store.get('windowBounds');
  const isOnboarding = !store.get('onboardingComplete', false);

  mainWindow = new BrowserWindow({
    width: isOnboarding ? 800 : (bounds?.width ?? 1200),
    height: isOnboarding ? 560 : (bounds?.height ?? 800),
    x: bounds?.x,
    y: bounds?.y,
    resizable: !isOnboarding,
    show: false,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('close', (event: { preventDefault(): void }) => {
    if (isQuitting) return;
    if (!store.get('onboardingComplete', false)) return; // allow close during onboarding
    event.preventDefault();
    const b = mainWindow?.getBounds();
    if (b) store.set('windowBounds', b);
    if (process.platform === 'darwin') {
      app.hide();
    } else {
      mainWindow?.hide();
    }
    if (trayInstance) showMinimizeNotification(trayInstance);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const isDark = nativeTheme.shouldUseDarkColors;
  if (!store.get('theme')) {
    store.set('theme', isDark ? 'dark' : 'light');
  }

  if (store.get('useSpaMode')) {
    const port = store.get('backendPort', 3001);
    const actualPort = await startBackendWithRetry(port);
    store.set('backendPort', actualPort);
    await loadSpaUrl(mainWindow, actualPort);
  } else if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }

  registerQuickChatIpc(mainWindow);
  if (desktopActivated) {
    registerGlobalShortcuts(mainWindow, showQuickChat);
  }
}

app.whenReady().then(async () => {
  // Seed dataDir from --dir CLI arg (takes precedence; saved for subsequent launches)
  const dirFlagIdx = process.argv.indexOf('--dir');
  if (dirFlagIdx !== -1 && process.argv[dirFlagIdx + 1]) {
    store.set('dataDir', process.argv[dirFlagIdx + 1]);
  }

  registerIpcHandlers();
  await syncRemoteAuth();

  registerProtocolHandler({
    getMainWindow: () => mainWindow,
    onPluginOAuthCallback: async ({ pluginId, oauthRef, requestToken }) => {
      try {
        const port = store.get('backendPort', 3001);
        await fetch(`http://localhost:${port}/rpc/plugins.completeOAuth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pluginId, oauthRef, requestToken }),
        });
      } catch {
        // fail-open: OAuth completion errors are surfaced via panel refresh
      }
      const win = mainWindow;
      if (win && !win.isDestroyed()) {
        win.webContents.send('plugin:oauthComplete', { oauthRef });
      }
    },
  });

  if (store.get('useSpaMode')) {
    setupSpaCsp();
  }

  const hidden = isBackgroundMode();

  if (hidden && store.get('onboardingComplete', false)) {
    logBackgroundStartup();
    activateDesktop();
  } else {
    await createWindow();
    if (store.get('onboardingComplete', false)) {
      activateDesktop();
    }
  }

  (app as unknown as EventEmitter).on('ethos:onboarding-complete', () => {
    activateDesktop();
    if (store.get('useSpaMode') && mainWindow && !mainWindow.isDestroyed()) {
      const port = store.get('backendPort', 3001);
      restartBackendAsync(port)
        .then((actualPort) => {
          store.set('backendPort', actualPort);
          if (mainWindow && !mainWindow.isDestroyed()) {
            loadSpaUrl(mainWindow, actualPort);
          }
        })
        .catch((err: unknown) => {
          console.error('[ethos] failed to restart backend after onboarding:', err);
        });
    }
  });

  if (process.env.NODE_ENV !== 'development') {
    initAutoUpdater();
  }

  nativeTheme.on('updated', () => {
    if (store.get('theme') === 'system') {
      const resolved = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
      mainWindow?.webContents.send('theme:changed', resolved);
    }
  });

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow().catch((err: unknown) => {
        console.error('[ethos] failed to create window on activate:', err);
      });
    }
  });
});

app.on('window-all-closed', () => {
  if (!desktopActivated) {
    stopBackend();
    app.quit();
  }
  // After activation, tray keeps app alive
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
  unregisterGlobalShortcuts();
  destroyTray();
});
