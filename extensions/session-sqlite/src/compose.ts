import { join } from 'node:path';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createKvStoreFactory, SQLiteSessionStore } from './index';

export interface SessionCompose {
  sessionStore: SQLiteSessionStore;
  kvStoreFactory: ReturnType<typeof createKvStoreFactory>;
}

export function compose(ctx: WiringContext): SessionCompose {
  const dbPath = join(ctx.dataDir, 'sessions.db');
  return {
    sessionStore: new SQLiteSessionStore(dbPath),
    kvStoreFactory: createKvStoreFactory(dbPath),
  };
}
