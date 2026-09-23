import { Worker } from 'node:worker_threads';

/**
 * Hold `dbPath`'s write lock (`BEGIN IMMEDIATE`) from a WORKER for `holdMs`,
 * resolving once the lock is held. A worker, not a second handle on this
 * thread: `@ethosagent/sqlite` is synchronous, so a same-thread holder could
 * never release while the call under test blocks. Plain CommonJS source, so no
 * TypeScript transform is involved in the worker. Same shape as
 * `extensions/goal-store/src/__tests__/lease.test.ts`.
 */
export async function holdWriteLock(dbPath: string, holdMs = 300): Promise<Worker> {
  const holder = new Worker(
    `const { DatabaseSync } = require('node:sqlite');
     const { workerData, parentPort } = require('node:worker_threads');
     const db = new DatabaseSync(workerData.dbPath);
     db.exec('PRAGMA busy_timeout = 5000');
     db.exec('BEGIN IMMEDIATE');
     parentPort.postMessage('held');
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
     db.exec('COMMIT');
     db.close();`,
    { eval: true, workerData: { dbPath, holdMs } },
  );
  await new Promise<void>((resolve, reject) => {
    holder.once('message', () => resolve());
    holder.once('error', reject);
  });
  return holder;
}
