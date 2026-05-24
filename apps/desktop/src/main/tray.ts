import path from 'node:path';
import type { BrowserWindow, NativeImage } from 'electron';
import { app, Menu, nativeImage, Tray } from 'electron';
import {
  checkForUpdates,
  getPendingUpdateVersion,
  onUpdateReady,
  quitAndInstall,
} from './auto-update';

function getIconDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets', 'tray');
  }
  return path.join(app.getAppPath(), 'assets', 'tray');
}

function iconPath(baseName: string): string {
  const dir = getIconDir();
  if (process.platform === 'darwin') {
    return path.join(dir, `${baseName}Template.png`);
  }
  return path.join(dir, `${baseName}.png`);
}

const icons = {
  idle: () => nativeImage.createFromPath(iconPath('Idle')),
  botActive: () => nativeImage.createFromPath(iconPath('Active')),
  error: () => nativeImage.createFromPath(iconPath('Error')),
  thinking: (frame: number): NativeImage => {
    const padded = String(frame).padStart(2, '0');
    return nativeImage.createFromPath(path.join(getIconDir(), `Thinking${padded}.png`));
  },
};

let tray: Tray | null = null;
let thinkingTimer: ReturnType<typeof setInterval> | null = null;

export type TrayState = 'idle' | 'botActive' | 'error' | 'thinking';

function clearThinkingTimer(): void {
  if (thinkingTimer !== null) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
}

export function setTrayState(trayInstance: Tray, state: TrayState): void {
  clearThinkingTimer();

  if (state === 'thinking') {
    let frame = 0;
    trayInstance.setImage(icons.thinking(frame));
    thinkingTimer = setInterval(() => {
      frame = (frame + 1) % 16;
      trayInstance.setImage(icons.thinking(frame));
    }, 100);
    return;
  }

  trayInstance.setImage(icons[state]());
}

let cachedGetWindow: (() => BrowserWindow | null) | null = null;
let cachedEnsureWindow: (() => void) | null = null;

function buildContextMenu(): Menu {
  const getWindow = cachedGetWindow;
  const ensureWindow = cachedEnsureWindow;

  function showWindow(): void {
    const win = getWindow?.();
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    } else {
      ensureWindow?.();
    }
  }

  const pendingVersion = getPendingUpdateVersion();

  const updateItem = pendingVersion
    ? {
        label: `Restart to update to v${pendingVersion}`,
        click: () => {
          quitAndInstall();
        },
      }
    : {
        label: 'Check for updates',
        click: () => {
          checkForUpdates();
        },
      };

  return Menu.buildFromTemplate([
    {
      label: 'Open Ethos',
      click: showWindow,
    },
    {
      label: 'New chat',
      click: () => {
        const win = getWindow?.();
        if (win && !win.isDestroyed()) {
          win.show();
          win.focus();
          win.webContents.send('chat:new');
        } else {
          ensureWindow?.();
        }
      },
    },
    { type: 'separator' },
    updateItem,
    { type: 'separator' },
    {
      label: 'Quit Ethos',
      click: () => {
        app.quit();
      },
    },
  ]);
}

export function rebuildTrayMenu(): void {
  if (tray) {
    tray.setContextMenu(buildContextMenu());
  }
}

export function createTray(getWindow: () => BrowserWindow | null, ensureWindow: () => void): Tray {
  if (tray) {
    return tray;
  }

  cachedGetWindow = getWindow;
  cachedEnsureWindow = ensureWindow;

  tray = new Tray(icons.idle());
  tray.setToolTip('Ethos');

  tray.setContextMenu(buildContextMenu());

  onUpdateReady(() => {
    rebuildTrayMenu();
  });

  if (process.platform === 'darwin') {
    tray.on('click', () => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
      } else {
        ensureWindow();
      }
    });
  }

  return tray;
}

export function destroyTray(): void {
  clearThinkingTimer();
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
