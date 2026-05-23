import path from 'node:path';
import type { BrowserWindow, NativeImage } from 'electron';
import { app, Menu, nativeImage, Tray } from 'electron';

const ICON_DIR = path.join(__dirname, '..', 'assets', 'tray');

function iconPath(baseName: string): string {
  if (process.platform === 'darwin') {
    return path.join(ICON_DIR, `${baseName}Template.png`);
  }
  return path.join(ICON_DIR, `${baseName}.png`);
}

const icons = {
  idle: () => nativeImage.createFromPath(iconPath('Idle')),
  botActive: () => nativeImage.createFromPath(iconPath('Active')),
  error: () => nativeImage.createFromPath(iconPath('Error')),
  thinking: (frame: number): NativeImage => {
    const padded = String(frame).padStart(2, '0');
    return nativeImage.createFromPath(path.join(ICON_DIR, `Thinking${padded}.png`));
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

export function createTray(mainWindow: BrowserWindow): Tray {
  if (tray) {
    return tray;
  }

  tray = new Tray(icons.idle());
  tray.setToolTip('Ethos');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Ethos',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: 'New chat',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('chat:new');
      },
    },
    { type: 'separator' },
    {
      label: 'Check for updates',
      click: async () => {
        const updaterPkg = await import('electron-updater');
        const { autoUpdater } = updaterPkg;
        autoUpdater.checkForUpdates();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Ethos',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  if (process.platform === 'darwin') {
    tray.on('click', () => {
      mainWindow.show();
      mainWindow.focus();
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
