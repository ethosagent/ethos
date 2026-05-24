import { app } from 'electron';

export function isBackgroundMode(): boolean {
  const isHidden =
    process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden;
  return isHidden;
}

export function logBackgroundStartup(): void {
  process.stderr.write('[ethos] Started in background mode (launch at login)\n');
}
