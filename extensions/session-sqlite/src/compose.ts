import { join } from 'node:path';
import type { WiringContext } from '@ethosagent/types';
import { SQLiteContextLog } from './context-log';
import { createKvStoreFactory, SQLiteSessionStore } from './index';
import { SQLiteUsageLedger } from './usage-ledger';

export interface SessionCompose {
  sessionStore: SQLiteSessionStore;
  kvStoreFactory: ReturnType<typeof createKvStoreFactory>;
  /** Model-visible ⟺ logged (plan/phases/model-visible-logged.md, Phase B).
   *  Shares `sessions.db` with `sessionStore` — same file, separate type (D5). */
  contextLog: SQLiteContextLog;
  /** Non-turn model calls (background-usage-accounting D3). Same file, own handle, FULL. */
  usageLedger: SQLiteUsageLedger;
}

export function compose(ctx: WiringContext): SessionCompose {
  const dbPath = join(ctx.dataDir, 'sessions.db');
  return {
    sessionStore: new SQLiteSessionStore(dbPath),
    kvStoreFactory: createKvStoreFactory(dbPath),
    contextLog: new SQLiteContextLog(dbPath),
    usageLedger: new SQLiteUsageLedger(dbPath),
  };
}
