// P3 — SQL schema and per-connection pragmas of every SQLite store. For each store:
// `SELECT type,name,sql FROM sqlite_master`, then `synchronous`, `journal_mode`,
// `busy_timeout`, `foreign_keys` and `user_version` read off the store's OWN handle
// (the same `db` seam the `durability posture` tests use), because these are
// per-connection settings and a second connection proves nothing. Each store opens on
// its own temp file so WAL is real. Catches schema drift, the per-store `synchronous`
// posture (CLAUDE.md table) and `busy_timeout` drift.
//
// Relative imports: most of these packages are not wiring dependencies, so they have
// no workspace link to resolve from here.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterAll, describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../../../../../apps/web-api/src/stores/idempotency-store';
import { SQLiteCallLog } from '../../../../../extensions/call-log/src/index';
import { SQLiteChannelTranscriptStore } from '../../../../../extensions/channel-transcript-sqlite/src/index';
import { DashboardsService } from '../../../../../extensions/dashboard/src/dashboards.service';
import { SQLiteDeliveryLedger } from '../../../../../extensions/delivery-ledger/src/index';
import { SQLiteGoalStore } from '../../../../../extensions/goal-store/src/index';
import { SQLiteInboundDedupStore } from '../../../../../extensions/inbound-dedup/src/index';
import { SQLiteInboundSpool } from '../../../../../extensions/inbound-spool/src/index';
import { SQLiteJobStore } from '../../../../../extensions/job-store/src/index';
import { KanbanStore } from '../../../../../extensions/kanban-store/src/index';
import { VectorMemoryProvider } from '../../../../../extensions/memory-vector/src/index';
import { SQLiteNotifyQueue } from '../../../../../extensions/notify-queue/src/index';
import { SQLiteObservabilityStore } from '../../../../../extensions/observability-sqlite/src/store';
import { SQLiteOutboxStore } from '../../../../../extensions/outbox/src/store';
import { SQLiteCardStore } from '../../../../../extensions/session-cards/src/index';
import { SqliteApiKeyStore } from '../../../../../extensions/session-sqlite/src/api-key-store';
import { SQLiteContextLog } from '../../../../../extensions/session-sqlite/src/context-log';
import { SQLiteSessionStore } from '../../../../../extensions/session-sqlite/src/index';
import { SQLiteUsageLedger } from '../../../../../extensions/session-sqlite/src/usage-ledger';
import { SQLiteA2aTaskStore } from '../../../../a2a/src/sqlite-task-store';
import { initPairingDb } from '../../../../safety/channel/src/pairing-store';
import { assertParity } from './harness';

interface Handle {
  pragma(source: string): unknown;
  prepare(sql: string): { all(): unknown[] };
}

interface Opened {
  /** The store's own connection. */
  handle: Handle;
  close: () => void;
}

const PRAGMAS = ['synchronous', 'journal_mode', 'busy_timeout', 'foreign_keys', 'user_version'];

const root = mkdtempSync(join(tmpdir(), 'ethos-parity-ddl-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `db` is private on every store; reading it is the seam the durability tests use. */
function handleOf(store: object): Handle {
  const db = Reflect.get(store, 'db') as Handle | undefined;
  if (!db) throw new Error(`${store.constructor.name} exposes no db handle`);
  return db;
}

function ownHandle(store: { close(): void }): Opened {
  return { handle: handleOf(store), close: () => store.close() };
}

const fakeEmbed = async (): Promise<Float32Array> => new Float32Array(384);

type Opener = (file: string, dir: string) => Opened;

/** Every store, keyed by the name it appears under in the fixture. */
const STORES: Record<string, Opener> = {
  'a2a task store': (f) => ownHandle(new SQLiteA2aTaskStore(f)),
  'call-log': (f) => ownHandle(new SQLiteCallLog({ path: f })),
  'channel-transcript-sqlite': (f) => ownHandle(new SQLiteChannelTranscriptStore(f)),
  dashboard: (f) => {
    const svc = new DashboardsService({ dbPath: f });
    return { handle: svc.getDb() as unknown as Handle, close: () => svc.close() };
  },
  'delivery-ledger': (f) => ownHandle(new SQLiteDeliveryLedger(f)),
  'goal-store': (f) => ownHandle(new SQLiteGoalStore(f)),
  'inbound-dedup': (f) => ownHandle(new SQLiteInboundDedupStore(f)),
  'inbound-spool': (f) => ownHandle(new SQLiteInboundSpool(f)),
  'job-store': (f) => ownHandle(new SQLiteJobStore(f)),
  'kanban-store': (f) => ownHandle(new KanbanStore(f)),
  'memory-vector': (_f, dir) =>
    ownHandle(
      new VectorMemoryProvider({ dir, embedFn: fakeEmbed, storage: new InMemoryStorage() }),
    ),
  'notify-queue': (f) => ownHandle(new SQLiteNotifyQueue(f)),
  'observability-sqlite': (f) => ownHandle(new SQLiteObservabilityStore(f)),
  outbox: (f) => ownHandle(new SQLiteOutboxStore(f)),
  'session-cards': (f) => ownHandle(new SQLiteCardStore(f)),
  'session-sqlite api-key store': (f) => ownHandle(new SqliteApiKeyStore(f)),
  'session-sqlite context log (sessions.db)': (f) => {
    // `sessions` must exist before the context log's CREATE TABLE ... REFERENCES.
    const sessions = new SQLiteSessionStore(f);
    const log = new SQLiteContextLog(f);
    return {
      handle: handleOf(log),
      close: () => {
        log.close();
        sessions.close();
      },
    };
  },
  'session-sqlite session store': (f) => ownHandle(new SQLiteSessionStore(f)),
  'session-sqlite usage ledger': (f) => ownHandle(new SQLiteUsageLedger(f)),
  'web-api idempotency-store': (f) => ownHandle(new IdempotencyStore(f)),
};

function firstValue(rows: unknown): unknown {
  const row = (rows as Array<Record<string, unknown>>)[0];
  return row ? Object.values(row)[0] : null;
}

function snapshot(handle: Handle): { ddl: unknown[]; pragmas: Record<string, unknown> } {
  const ddl = handle.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all();
  const pragmas: Record<string, unknown> = {};
  for (const name of PRAGMAS) pragmas[name] = firstValue(handle.pragma(name));
  return { ddl, pragmas };
}

describe('P3 SQLite DDL and pragma parity', () => {
  it('matches the DDL fixture', () => {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [name, open] of Object.entries(STORES)) {
      const dir = join(root, `s${n++}`);
      mkdirSync(dir, { recursive: true });
      const opened = open(join(dir, 'store.db'), dir);
      try {
        out[name] = snapshot(opened.handle);
      } finally {
        opened.close();
      }
    }

    // initPairingDb takes a handle the CLI opens itself (gateway.ts sets WAL first);
    // there is no store object to read per-connection settings off, so DDL only.
    const pairingDir = join(root, 'pairing');
    mkdirSync(pairingDir, { recursive: true });
    const pairing = new Database(join(pairingDir, 'pairing.db'));
    try {
      pairing.pragma('journal_mode = WAL');
      initPairingDb(pairing);
      out['initPairingDb (apps/ethos)'] = {
        ddl: snapshot(pairing as unknown as Handle).ddl,
        pragmas: null,
      };
    } finally {
      pairing.close();
    }

    expect(Object.keys(out).length).toBe(Object.keys(STORES).length + 1);
    assertParity('p3-ddl', out);
  }, 120_000);
});
