import type { BrowserWindow, Tray } from 'electron';
import { Notification } from 'electron';
import { store } from './store';

export function showMinimizeNotification(tray: Tray): void {
  if (store.get('hasShownMinimizeHint')) {
    return;
  }

  const title = 'Ethos is still running';
  const body = 'Find it in your menu bar.';

  if (process.platform === 'win32') {
    tray.displayBalloon({ title, content: body });
  } else {
    new Notification({ title, body }).show();
  }

  store.set('hasShownMinimizeHint', true);
}

interface BackgroundNotificationOpts {
  title: string;
  body: string;
  route?: string;
}

export function showBackgroundNotification(
  mainWindow: BrowserWindow,
  opts: BackgroundNotificationOpts,
): void {
  if (mainWindow.isVisible()) {
    return;
  }

  const notification = new Notification({
    title: opts.title,
    body: opts.body,
  });

  notification.on('click', () => {
    mainWindow.show();
    mainWindow.focus();
    if (opts.route) {
      mainWindow.webContents.send('navigate:session', opts.route);
    }
  });

  notification.show();
}
