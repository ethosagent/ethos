import { type AgingState, DEFAULT_AGING_STATE } from './tool-result-aging';
import type { LoopDeps } from './turn-context';

// Phase 1a — aging state is persisted per session so the batched-at-crossings
// invariant survives across turns. Best-effort: any storage error degrades to
// the default (no aging) rather than breaking the turn.
function agingStatePath(dataDir: string, sessionId: string): string {
  return `${dataDir}/aging/${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

function parseAgingState(raw: string): AgingState {
  try {
    const v = JSON.parse(raw) as Partial<AgingState>;
    const level = v.level === 'soft' || v.level === 'hard' ? v.level : 'none';
    const soft = Array.isArray(v.soft)
      ? v.soft.filter((s): s is string => typeof s === 'string')
      : [];
    const hard = Array.isArray(v.hard)
      ? v.hard.filter((s): s is string => typeof s === 'string')
      : [];
    return { level, soft, hard };
  } catch {
    return DEFAULT_AGING_STATE;
  }
}

export async function loadAgingState(
  storage: LoopDeps['storage'],
  dataDir: string | undefined,
  sessionId: string,
): Promise<AgingState> {
  if (!storage || !dataDir) return DEFAULT_AGING_STATE;
  try {
    const raw = await storage.read(agingStatePath(dataDir, sessionId));
    return raw ? parseAgingState(raw) : DEFAULT_AGING_STATE;
  } catch {
    return DEFAULT_AGING_STATE;
  }
}

export async function saveAgingState(
  storage: LoopDeps['storage'],
  dataDir: string | undefined,
  sessionId: string,
  state: AgingState,
): Promise<void> {
  if (!storage || !dataDir) return;
  try {
    await storage.mkdir(`${dataDir}/aging`);
    await storage.writeAtomic(agingStatePath(dataDir, sessionId), JSON.stringify(state));
  } catch {
    // Best-effort — a persistence miss just re-derives the state next turn.
  }
}
