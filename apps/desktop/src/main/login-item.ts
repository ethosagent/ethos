import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

async function setLoginItemMac(enabled: boolean): Promise<void> {
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
}

async function getLoginItemMac(): Promise<boolean> {
  return app.getLoginItemSettings().openAtLogin;
}

async function setLoginItemWindows(enabled: boolean): Promise<void> {
  const Registry = require('winreg');
  const key = new Registry({
    hive: Registry.HKCU,
    key: '\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  });

  return new Promise<void>((resolve, reject) => {
    if (enabled) {
      key.set('Ethos', Registry.REG_SZ, `"${process.execPath}" --hidden`, (err: Error | null) => {
        if (err) reject(new Error(`Failed to enable launch at login on Windows: ${err.message}`));
        else resolve();
      });
    } else {
      key.remove('Ethos', (err: Error | null) => {
        if (err) reject(new Error(`Failed to disable launch at login on Windows: ${err.message}`));
        else resolve();
      });
    }
  });
}

async function getLoginItemWindows(): Promise<boolean> {
  const Registry = require('winreg');
  const key = new Registry({
    hive: Registry.HKCU,
    key: '\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  });

  return new Promise<boolean>((resolve) => {
    key.get('Ethos', (err: Error | null, item: { value: string } | null) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(item !== null);
    });
  });
}

function desktopFilePath(): string {
  const configDir = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '~', '.config');
  return join(configDir, 'autostart', 'ethos.desktop');
}

const DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=Ethos
Exec=${process.execPath} --hidden
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;

async function setLoginItemLinux(enabled: boolean): Promise<void> {
  const filePath = desktopFilePath();

  if (enabled) {
    await fs.mkdir(join(filePath, '..'), { recursive: true });
    await fs.writeFile(filePath, DESKTOP_ENTRY, 'utf-8');
  } else {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new Error(`Failed to remove autostart entry on Linux: ${(err as Error).message}`);
      }
    }
  }
}

async function getLoginItemLinux(): Promise<boolean> {
  try {
    await fs.access(desktopFilePath());
    return true;
  } catch {
    return false;
  }
}

export async function setLoginItem(enabled: boolean): Promise<void> {
  switch (process.platform) {
    case 'darwin':
      return setLoginItemMac(enabled);
    case 'win32':
      return setLoginItemWindows(enabled);
    case 'linux':
      return setLoginItemLinux(enabled);
    default:
      throw new Error(`Unsupported platform for login item management: ${process.platform}`);
  }
}

export async function getLoginItem(): Promise<boolean> {
  switch (process.platform) {
    case 'darwin':
      return getLoginItemMac();
    case 'win32':
      return getLoginItemWindows();
    case 'linux':
      return getLoginItemLinux();
    default:
      throw new Error(`Unsupported platform for login item management: ${process.platform}`);
  }
}
