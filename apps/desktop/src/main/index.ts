import type { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme, type Tray } from 'electron';
import { initAutoUpdater } from './auto-update';
import { startBackend, stopBackend } from './backend';
import { registerGlobalShortcuts, unregisterGlobalShortcuts } from './global-shortcut';
import { registerIpcHandlers } from './ipc';
import { showMinimizeNotification } from './notifications';
import { registerQuickChatIpc, showQuickChat } from './quick-chat-window';
import { isBackgroundMode, logBackgroundStartup } from './startup-mode';
import { store } from './store';
import { createTray, destroyTray } from './tray';

let mainWindow: BrowserWindow | null = null;
let trayInstance: Tray | null = null;
let isQuitting = false;
let desktopActivated = false;

function activateDesktop(): void {
  if (desktopActivated) return;
  desktopActivated = true;
  startBackend(3001);
  trayInstance = createTray(() => mainWindow, createWindow);
  if (mainWindow && !mainWindow.isDestroyed()) {
    registerGlobalShortcuts(mainWindow, showQuickChat);
  }
}

function createWindow(): void {
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

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }

  registerQuickChatIpc(mainWindow);
  if (desktopActivated) {
    registerGlobalShortcuts(mainWindow, showQuickChat);
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();

  const hidden = isBackgroundMode();

  if (hidden && store.get('onboardingComplete', false)) {
    logBackgroundStartup();
    activateDesktop();
  } else {
    createWindow();
    if (store.get('onboardingComplete', false)) {
      activateDesktop();
    }
  }

  (app as unknown as EventEmitter).on('ethos:onboarding-complete', () => {
    activateDesktop();
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
      createWindow();
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
