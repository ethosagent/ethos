import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

export interface SessionStoreConfig {
  sessionDir: string;
  botKey: string;
}

export function resolveSessionDir(config: SessionStoreConfig): string {
  const dir = join(config.sessionDir, config.botKey);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
