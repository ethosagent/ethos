// Raw node:fs is an allowed exception here (same as session-sqlite and memory-vector).
// Baileys' useMultiFileAuthState manages its own file layout for auth credentials and pre-keys.
// See CLAUDE.md "Allowed exceptions" — session persistence backends
// that manage their own WAL/file format are exempt from the Storage
// abstraction.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
