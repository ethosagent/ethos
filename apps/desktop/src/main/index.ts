import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { initAutoUpdater } from './auto-update';
import { startBackend, stopBackend } from './backend';
import { registerIpcHandlers } from './ipc';
import { store } from './store';

let mainWindow: BrowserWindow | null = null;

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

  mainWindow.on('close', () => {
    if (mainWindow && !store.get('onboardingComplete', false)) return;
    const b = mainWindow?.getBounds();
    if (b) store.set('windowBounds', b);
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
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  if (store.get('onboardingComplete', false)) {
    startBackend(3001);
  }

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
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopBackend();
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackend();
});
