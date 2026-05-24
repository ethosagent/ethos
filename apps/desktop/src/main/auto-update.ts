import updaterPkg from 'electron-updater';

const { autoUpdater } = updaterPkg;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let pendingVersion: string | null = null;
let onUpdateReadyCallback: (() => void) | null = null;

/**
 * Returns the version string if an update has been downloaded, or null.
 */
export function getPendingUpdateVersion(): string | null {
  return pendingVersion;
}

/**
 * Quits the app and installs the downloaded update.
 * Only call this when `getPendingUpdateVersion()` is non-null.
 */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

/**
 * Register a callback that fires when an update finishes downloading.
 * Used by tray.ts to rebuild its context menu.
 */
export function onUpdateReady(callback: () => void): void {
  onUpdateReadyCallback = callback;
}

let isChecking = false;

/**
 * Checks for updates with a concurrency guard.
 * Silently ignores errors — network failures, expired feeds, and bad
 * signatures are expected and non-fatal during update checks.
 */
export async function checkForUpdates(): Promise<void> {
  if (isChecking) return;
  isChecking = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    // Update check failures are expected and non-fatal.
  } finally {
    isChecking = false;
  }
}

export function initAutoUpdater(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    pendingVersion = info.version;
    onUpdateReadyCallback?.();
  });

  checkForUpdates();
  setInterval(() => {
    checkForUpdates();
  }, CHECK_INTERVAL_MS);
}
