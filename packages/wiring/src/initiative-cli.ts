import {
  digDeeper,
  InitiativeConfigService,
  type InitiativeFile,
  loadInitiativeSettings,
  parseInitiativeFile,
} from '@ethosagent/initiative-runner';
import {
  computeGateMetrics,
  type GateMetrics,
  initiativesDbPath,
  SQLiteInitiativeStore,
} from '@ethosagent/initiative-store';
import type {
  ExplorationRow,
  InitiativeConfigPort,
  InitiativeStore,
  Storage,
  WindowRow,
} from '@ethosagent/types';
import { readInitiativeConstitution } from './initiatives';

/** What `ethos initiatives` needs besides a running loop: the ledger, its one YAML writer and a few reads. */
export interface InitiativeCliPort {
  /** The ledger. `windows` is the spend ledger the `metrics` subcommand sums. */
  store: InitiativeStore & { windows(initiativeId: string): WindowRow[] };
  /** `InitiativeConfigService`, the only writer of `initiatives/*.yaml` (pause/resume go through it). */
  config: InitiativeConfigPort;
  /** The initiative's parsed YAML; null when the row or the file is missing or invalid. */
  file(initiativeId: string): Promise<InitiativeFile | null>;
  /** Gate 1 / Gate 2 / self-start outcomes since an ISO time, from the decisions ledger. */
  metrics(personalityId: string, sinceIso: string): GateMetrics;
  /** The owner's "dig deeper" (decision row, then a fresh budget and deadline) via the runner's `digDeeper`. */
  digDeeper(input: {
    explorationId: string;
    decidedBy: string;
    file: InitiativeFile;
    now: Date;
  }): ExplorationRow;
  close(): void;
}

/**
 * The CLI's composed entry point. Returns null when `initiatives.db` does not exist, and never
 * creates it: a user who has not saved an initiative gets "nothing here", not an empty database.
 * Pinned by apps/ethos/src/commands/__tests__/initiatives-cli.test.ts.
 */
export async function createInitiativeCliPort(deps: {
  storage: Storage;
  dataDir: string;
}): Promise<InitiativeCliPort | null> {
  const path = initiativesDbPath(deps.dataDir);
  if (!(await deps.storage.exists(path))) return null;
  const sqlite = new SQLiteInitiativeStore(path);
  const config = new InitiativeConfigService({
    storage: deps.storage,
    dataDir: deps.dataDir,
    store: sqlite,
    constitution: () => readInitiativeConstitution(deps.storage, deps.dataDir),
    settings: async (id) => (await loadInitiativeSettings(deps.storage, deps.dataDir, id)).settings,
    toolset: () => [], // only create/update read it; the CLI saves state changes only
    schedule: () => {},
  });
  return {
    store: sqlite,
    config,
    file: async (id) => {
      const row = sqlite.getInitiative(id);
      const raw = row ? await deps.storage.read(row.configPath) : null;
      const parsed = raw === null ? null : parseInitiativeFile(raw);
      return parsed?.ok ? parsed.file : null;
    },
    metrics: (personalityId, sinceIso) => computeGateMetrics(sqlite, personalityId, sinceIso),
    digDeeper: ({ file, ...input }) => digDeeper(sqlite, file, input),
    close: () => sqlite.close(),
  };
}
