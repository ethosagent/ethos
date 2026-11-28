import type { Storage } from '@ethosagent/types';
import { createInitiativeCliPort } from '@ethosagent/wiring';
import { type ExploringNowSnapshot, setExploringNowSource } from './exploring-now';

const REFRESH_MS = 5000;

/**
 * Newest open window of `personalityId` (same rule as web-api InitiativesService.exploringNow).
 * Returns null when `initiatives.db` is absent: createInitiativeCliPort never creates it
 * (pinned by apps/ethos/src/commands/__tests__/initiatives-cli.test.ts).
 */
export async function readCurrentWindow(deps: {
  storage: Storage;
  dataDir: string;
  personalityId: string;
}): Promise<ExploringNowSnapshot | null> {
  const port = await createInitiativeCliPort({ storage: deps.storage, dataDir: deps.dataDir });
  if (!port) return null;
  try {
    let best: ExploringNowSnapshot | null = null;
    let bestExplorationId: string | null = null;
    for (const row of port.store.list({ personalityId: deps.personalityId })) {
      for (const w of port.store.windows(row.id)) {
        if (w.ended !== null || (best && w.started <= best.started)) continue;
        bestExplorationId = w.explorationId;
        best = {
          windowId: w.id,
          initiativeId: row.id,
          initiativeTitle: row.id,
          question: null,
          started: w.started,
          costSoFarUsd: w.spentUsd,
          readOnly: true,
        };
      }
    }
    if (!best) return null;
    best.initiativeTitle = (await port.file(best.initiativeId))?.title ?? best.initiativeId;
    best.question = bestExplorationId
      ? (port.store.getExploration(bestExplorationId)?.question ?? null)
      : null;
    return best;
  } finally {
    port.close();
  }
}

/**
 * Registers the TUI's exploring-now source (read by StatusBar via ExploringNowLine) and keeps
 * it fresh. The source is synchronous, so it serves the last refresh; a failed refresh blanks it.
 * Limitation: only the launch personality's windows show; a /personality switch is not followed.
 * Returns a stop function.
 */
export function startExploringNowFeed(deps: {
  storage: Storage;
  dataDir: string;
  personalityId: string;
  intervalMs?: number;
}): () => void {
  let current: ExploringNowSnapshot | null = null;
  let busy = false;
  const refresh = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      current = await readCurrentWindow(deps);
    } catch {
      current = null; // a broken ledger must not break the TUI; the strip just goes blank
    } finally {
      busy = false;
    }
  };
  setExploringNowSource(() => current);
  void refresh();
  const timer = setInterval(() => void refresh(), deps.intervalMs ?? REFRESH_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    setExploringNowSource(null);
  };
}
