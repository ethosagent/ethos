import type { InitiativeFile } from '@ethosagent/initiative-runner';
import type {
  ExplorationRow,
  ExplorationState,
  InitiativeRow,
  InitiativeStore,
  InitiativeVerdict,
} from '@ethosagent/types';

// The one place Gate 1, Gate 2 and self-start decisions are applied. The CLI
// (apps/ethos/src/lib/initiatives-manage.ts), the web-api InitiativesService and the channel
// buttons all call `decideInitiative`; none of them writes a `decisions` row itself. The row is
// written only by `SQLiteInitiativeStore.recordDecision` (reached through `port.store`).
// Pinned by apps/ethos/src/commands/__tests__/initiatives-cli.test.ts and
// apps/web-api/src/__tests__/routes/initiatives-rpc.test.ts ('decide records decided_by').

export type DecideGate = 'gate1_explore' | 'gate2_adopt' | 'self_start';

/** What the owner chose. Surface-neutral: no CLI flags, no HTTP shapes. */
export interface InitiativeDecision {
  /** An exploration id for the two gates; an initiative id for `self_start`. */
  target: string;
  gate: DecideGate;
  verdict: InitiativeVerdict;
  /** The brief option adopted (Gate 2 `adopt` only). */
  option?: string | null;
  reason?: string | null;
}

/** The slice of a composed port the decision needs; `InitiativeCliPort` satisfies it. */
export interface InitiativeDecidePort {
  store: Pick<InitiativeStore, 'getExploration' | 'getInitiative' | 'recordDecision'>;
  file(initiativeId: string): Promise<InitiativeFile | null>;
  digDeeper(input: {
    explorationId: string;
    decidedBy: string;
    file: InitiativeFile;
    now: Date;
  }): ExplorationRow;
}

export type InitiativeDecideResult =
  | {
      ok: true;
      exploration?: ExplorationRow;
      initiative?: InitiativeRow;
      /** `make_mine`: nothing is recorded here; the owner confirms the rewrite in chat. */
      makeMine?: true;
    }
  | {
      ok: false;
      /** `conflict` is the wrong state, e.g. "EXP-0007 is exploring, not briefed". */
      kind: 'not_found' | 'conflict' | 'invalid';
      message: string;
    };

const VERDICTS: Record<DecideGate, readonly InitiativeVerdict[]> = {
  gate1_explore: ['approve', 'reject', 'snooze'],
  gate2_adopt: ['adopt', 'dig_deeper', 'park'],
  self_start: ['keep', 'make_mine', 'stop'],
};

const fail = (
  kind: 'not_found' | 'conflict' | 'invalid',
  message: string,
): InitiativeDecideResult => ({ ok: false, kind, message });

function exploration(
  port: InitiativeDecidePort,
  id: string,
  want: ExplorationState,
): ExplorationRow | InitiativeDecideResult {
  const e = port.store.getExploration(id);
  if (!e) return fail('not_found', `exploration ${id} does not exist`);
  return e.state === want ? e : fail('conflict', `${id} is ${e.state}, not ${want}`);
}

/**
 * Apply one decision as `decidedBy` (`owner:cli`, `owner:web`, ...). A wrong state returns a
 * typed `conflict` and writes nothing; the store transition rolls back on any other refusal.
 */
export async function decideInitiative(
  port: InitiativeDecidePort,
  d: InitiativeDecision,
  ctx: { decidedBy: string; now?: Date },
): Promise<InitiativeDecideResult> {
  if (!VERDICTS[d.gate].includes(d.verdict)) {
    return fail('invalid', `verdict ${d.verdict} does not belong to ${d.gate}`);
  }
  const record = (option: string | null) =>
    port.store.recordDecision({
      target: d.target,
      gate: d.gate,
      verdict: d.verdict,
      reason: d.reason ?? null,
      option,
      decidedBy: ctx.decidedBy,
    });

  if (d.gate === 'self_start') {
    const row = port.store.getInitiative(d.target);
    if (!row) return fail('not_found', `initiative ${d.target} does not exist`);
    if (row.state !== 'self_started') {
      return fail('conflict', `${d.target} is ${row.state}, not self_started`);
    }
    if (d.verdict === 'make_mine') return { ok: true, initiative: row, makeMine: true };
    record(null);
    return { ok: true, initiative: port.store.getInitiative(d.target) ?? row };
  }

  const e = exploration(port, d.target, d.gate === 'gate1_explore' ? 'proposed' : 'briefed');
  if (!('id' in e)) return e;
  if (d.verdict === 'dig_deeper') {
    const file = await port.file(e.initiativeId);
    if (!file) return fail('invalid', `initiative ${e.initiativeId} has no valid file`);
    port.digDeeper({
      explorationId: e.id,
      decidedBy: ctx.decidedBy,
      file,
      now: ctx.now ?? new Date(),
    });
  } else {
    record(d.verdict === 'adopt' ? (d.option ?? null) : null);
  }
  return { ok: true, exploration: port.store.getExploration(e.id) ?? e };
}
