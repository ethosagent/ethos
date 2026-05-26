import type { BrowserWindow } from 'electron';
import { app, globalShortcut, Notification } from 'electron';
import { store } from './store';

export function registerGlobalShortcuts(mainWindow: BrowserWindow, onQuickChat: () => void): void {
  const mainHotkeyRegistered = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (!mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
      return;
    }

    if (!mainWindow.isFocused()) {
      mainWindow.focus();
      return;
    }

    if (process.platform === 'darwin') {
      app.hide();
    } else {
      mainWindow.hide();
    }
  });

  if (!mainHotkeyRegistered) {
    console.warn('Failed to register global shortcut: CommandOrControl+Shift+Space');

    if (!store.get('hasShownHotkeyConflict')) {
      new Notification({
        title: 'Hotkey conflict',
        body: 'Cmd+Shift+Space is in use by another app. Use the tray icon instead.',
      }).show();
      store.set('hasShownHotkeyConflict', true);
    }
  }

  const quickChatRegistered = globalShortcut.register('CommandOrControl+Shift+/', onQuickChat);

  if (!quickChatRegistered) {
    console.warn('Failed to register global shortcut: CommandOrControl+Shift+/');
  }
}

export function unregisterGlobalShortcuts(): void {
  globalShortcut.unregisterAll();
}
