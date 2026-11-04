// The process-wide plugin host pool (plan plugin-process-isolation D4, D14).
//
// A long-running host (`gateway start`, `serve`, `boot`) opens ONE pool here and
// closes it on shutdown. `createAgentLoop` in ./wiring.ts lends it to every loop
// built while it is open (one per bot, hot-added bots, the system loop), so the
// hosts never thread it by hand and a loop built later cannot forget it. A
// short-lived command opens none: its loop builds its own and disposes it with
// the loop. The other shape — passing `pluginHostPool` at every host call site —
// was rejected: gateway alone has six `createAgentLoop` sites, and a missed one
// would run a second host per bot.
import { join } from 'node:path';
import { type EthosConfig, ethosDir } from '@ethosagent/config';
import type { Storage } from '@ethosagent/types';
import { createPluginHostPool, type PluginHostPool } from '@ethosagent/wiring';
import { logger } from './logger';

let processPool: PluginHostPool | undefined;
let cachedChildEntry: Promise<string | undefined> | undefined;

/**
 * Absolute path of the host child entry: `plugin-host-child.ts` beside this file
 * when run from source (`tsx`), `plugin-host-child.js` beside the bundle in a
 * built install (tsup emits it next to `index.js`, `apps/ethos/tsup.config.ts`).
 * `undefined` when neither exists, which makes a host-configured plugin fail
 * closed (D23) instead of running in-process.
 */
export function resolvePluginHostChildEntry(storage: Storage): Promise<string | undefined> {
  cachedChildEntry ??= (async () => {
    for (const name of ['plugin-host-child.ts', 'plugin-host-child.js']) {
      const candidate = join(import.meta.dirname, name);
      if (await storage.exists(candidate)) return candidate;
    }
    return undefined;
  })();
  return cachedChildEntry;
}

/** Open the process pool. Idempotent; `undefined` when no child entry resolves. */
export async function openProcessPluginHostPool(
  config: Pick<EthosConfig, 'pluginIsolation'>,
  storage: Storage,
): Promise<PluginHostPool | undefined> {
  if (processPool) return processPool;
  const childEntry = await resolvePluginHostChildEntry(storage);
  if (!childEntry) return undefined;
  processPool = createPluginHostPool({
    dataDir: ethosDir(),
    storage,
    childEntry,
    ...(config.pluginIsolation ? { config: config.pluginIsolation } : {}),
    logger,
  });
  return processPool;
}

export function getProcessPluginHostPool(): PluginHostPool | undefined {
  return processPool;
}

/** Dispose the process pool, after every loop that borrowed it has been disposed. */
export async function closeProcessPluginHostPool(): Promise<void> {
  const pool = processPool;
  processPool = undefined;
  await pool?.dispose();
}
