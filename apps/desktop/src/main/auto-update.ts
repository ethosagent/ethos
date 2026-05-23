import { autoUpdater } from 'electron-updater';

export function initAutoUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', () => {
    autoUpdater.downloadUpdate();
  });

  autoUpdater.checkForUpdates();
}
