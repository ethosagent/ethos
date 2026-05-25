import updaterPkg from 'electron-updater';

const { autoUpdater } = updaterPkg;

export function initAutoUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.checkForUpdates();
}
