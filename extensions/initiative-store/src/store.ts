import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';
import {
  type BriefRow,
  canTransition,
  type DecisionRow,
  type DraftRow,
  type DraftStatus,
  EthosError,
  EXPLORATION_TRANSITIONS,
  type ExplorationRow,
  type ExplorationState,
  type FindingRow,
  type GateId,
  type IdeaRow,
  INITIATIVE_TRANSITIONS,
  type InitiativeLedgerPort,
  type InitiativeOrigin,
  type InitiativeRow,
  type InitiativeState,
  type InitiativeStore,
  type InitiativeVerdict,
  type QuestionRow,
  type WindowKind,
  type WindowRow,
} from '@ethosagent/types';
import { selectDrafts, settleDraftRow } from './drafts';
import { clampExplorationBudget, extendExplorationRow, reactionClockRow } from './lifecycle';
import { INITIATIVE_STORE_SCHEMA_VERSION, SCHEMA } from './schema';

/** `<dataDir>/initiatives.db`. */
export function initiativesDbPath(dataDir: string): string {
  return join(dataDir, 'initiatives.db');
}

export interface SQLiteInitiativeStoreOptions {
  /** Clock in epoch ms; tests inject it. */
  now?: () => number;
  /**
   * The operator's daily cap for an initiative, in USD. The store does not know
   * config; wiring binds this to the clamped config value. Defaults to 0.
   */
  capFor?: (initiativeId: string) => number;
  /** `usd_per_exploration` per initiative; a proposal's budget is clamped to it. Unset = no clamp. */
  explorationCapFor?: (initiativeId: string) => number;
}

const DAY_MS = 86_400_000;
/** States in which an exploration still occupies a slot against the open-exploration cap. */
const OPEN_EXPLORATION_STATES = ['proposed', 'exploring', 'stalled'] as const;

interface InitiativeDbRow {
  id: string;
  personality_id: string;
  origin: string;
  parent_id: string | null;
  state: string;
  config_path: string;
  config_hash: string;
  version: number;
}

interface IdeaDbRow {
  id: string;
  initiative_id: string;
  origin: string;
  text: string;
  source_ref: string | null;
  created_at: string;
}

interface ExplorationDbRow {
  id: string;
  initiative_id: string;
  idea_id: string | null;
  question: string;
  state: string;
  budget_usd: number;
  spent_usd: number;
  estimate_usd: number | null;
  deadline: string;
}

interface WindowDbRow {
  id: string;
  initiative_id: string;
  exploration_id: string | null;
  kind: string;
  started: string;
  ended: string | null;
  spent_usd: number;
  tools_used: string;
  reads: string;
  checkpoint: string | null;
  end_reason: string | null;
}

interface QuestionDbRow {
  id: string;
  initiative_id: string;
  exploration_id: string | null;
  text: string;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}

const INITIATIVE_COLS =
  'id, personality_id, origin, parent_id, state, config_path, config_hash, version';
const EXPLORATION_COLS =
  'id, initiative_id, idea_id, question, state, budget_usd, spent_usd, estimate_usd, deadline';

function toInitiative(r: InitiativeDbRow): InitiativeRow {
  return {
    id: r.id,
    personalityId: r.personality_id,
    origin: r.origin as InitiativeOrigin,
    parentId: r.parent_id,
    state: r.state as InitiativeState,
    configPath: r.config_path,
    configHash: r.config_hash,
    version: r.version,
  };
}

function toIdea(r: IdeaDbRow): IdeaRow {
  return {
    id: r.id,
    initiativeId: r.initiative_id,
    origin: r.origin === 'human' ? 'human' : 'agent',
    text: r.text,
    sourceRef: r.source_ref,
    createdAt: r.created_at,
  };
}

function toExploration(r: ExplorationDbRow): ExplorationRow {
  return {
    id: r.id,
    initiativeId: r.initiative_id,
    ideaId: r.idea_id,
    question: r.question,
    state: r.state as ExplorationState,
    budgetUsd: r.budget_usd,
    spentUsd: r.spent_usd,
    deadline: r.deadline,
    estimateUsd: r.estimate_usd,
  };
}

/** `?, ?, ?` placeholders for an SQL `IN (...)` over `values`. */
function inClause(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

interface BriefDbRow {
  id: string;
  exploration_id: string;
  version: number;
  body_md: string;
  recommended_option: string | null;
  partial: number;
}

function toBrief(r: BriefDbRow): BriefRow {
  return {
    id: r.id,
    explorationId: r.exploration_id,
    version: r.version,
    bodyMd: r.body_md,
    recommendedOption: r.recommended_option,
    partial: r.partial === 1,
  };
}

interface FindingDbRow {
  id: string;
  exploration_id: string;
  claim: string;
  source_ref: string;
  confidence: number;
  created_at: string;
}

function toFinding(r: FindingDbRow): FindingRow {
  return {
    id: r.id,
    explorationId: r.exploration_id,
    claim: r.claim,
    sourceRef: r.source_ref,
    confidence: r.confidence,
    createdAt: r.created_at,
  };
}

interface DecisionDbRow {
  id: string;
  target: string;
  gate: string;
  verdict: string;
  reason: string | null;
  option: string | null;
  decided_by: string;
  at: string;
}

function toDecision(r: DecisionDbRow): DecisionRow {
  return {
    id: r.id,
    target: r.target,
    gate: r.gate as GateId,
    verdict: r.verdict as InitiativeVerdict,
    reason: r.reason,
    option: r.option,
    decidedBy: r.decided_by,
    at: r.at,
  };
}

/** A JSON text column that must hold a string array; anything else reads as empty. */
function parseStrings(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
}

function toWindow(r: WindowDbRow): WindowRow {
  return {
    id: r.id,
    initiativeId: r.initiative_id,
    explorationId: r.exploration_id,
    kind: r.kind as WindowKind,
    started: r.started,
    ended: r.ended,
    spentUsd: r.spent_usd,
    toolsUsed: parseStrings(r.tools_used),
    reads: parseStrings(r.reads),
    checkpoint: r.checkpoint,
    endReason: r.end_reason,
  };
}

function toQuestion(r: QuestionDbRow): QuestionRow {
  return {
    id: r.id,
    initiativeId: r.initiative_id,
    explorationId: r.exploration_id,
    text: r.text,
    answer: r.answer,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
  };
}

/**
 * What a decision implies. `exploration` targets an exploration id (gate 1 and
 * 2), `initiative` an initiative id (self-start). A gate or verdict missing here
 * is refused; `config_change` implies no transition and accepts any verdict.
 */
const IMPLIED: Partial<
  Record<
    GateId,
    Partial<
      Record<
        InitiativeVerdict,
        { exploration: ExplorationState | null } | { initiative: InitiativeState }
      >
    >
  >
> = {
  gate1_explore: {
    approve: { exploration: 'exploring' },
    reject: { exploration: 'rejected' },
    snooze: { exploration: null },
  },
  gate2_adopt: {
    adopt: { exploration: 'adopted' },
    park: { exploration: 'parked' },
    dig_deeper: { exploration: 'exploring' },
  },
  self_start: {
    keep: { initiative: 'active' },
    stop: { initiative: 'stopped' },
    make_mine: { initiative: 'active' },
  },
};

const INDEX_EXPLORATION_STATES = [...OPEN_EXPLORATION_STATES, 'briefed'] as const;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** ~80 chars of `text` around the first case-insensitive match of `needle`. */
function snippet(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = Math.max(0, flat.toLowerCase().indexOf(needle.toLowerCase()));
  const start = Math.max(0, at - 30);
  const end = Math.min(flat.length, at + needle.length + 50);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * SQLite initiative ledger (`<dataDir>/initiatives.db`). One file, STRICT
 * tables, `synchronous = FULL`: a decision row is a promise to the user and the
 * window spend rows enforce a cap the operator was promised, so a power cut must
 * not roll either back (pinned by the `durability posture is FULL` test;
 * .claude/rules/sqlite-durability.md).
 *
 * Ids are readable and per-database monotonic: `EXP-0007`, `F-31`, `I-4`,
 * `B-2`, `W-9`, `D-1`, `Q-3`. A new id is `max(numeric suffix) + 1`, computed
 * inside a `BEGIN IMMEDIATE` transaction (`write`), so two connections cannot
 * mint the same one. Rows are never deleted, so the sequence never reuses an id.
 */
export class SQLiteInitiativeStore implements InitiativeStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly capFor: (initiativeId: string) => number;
  private readonly explorationCapFor: ((initiativeId: string) => number) | undefined;

  constructor(dbPath: string, opts: SQLiteInitiativeStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.capFor = opts.capFor ?? (() => 0);
    this.explorationCapFor = opts.explorationCapFor;
    // mkdir -p the parent: the same raw-fs carve-out the other SQLite stores use
    // (.claude/rules/fs-carveouts-sqlite.md). `:memory:` has no parent.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    migrate(this.db, {
      name: 'initiative-store',
      targetVersion: INITIATIVE_STORE_SCHEMA_VERSION,
      baseline: SCHEMA,
    });
  }

  close(): void {
    this.db.close();
  }

  // ---- internals ---------------------------------------------------------

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Run `fn` in a BEGIN IMMEDIATE transaction (a savepoint when already inside one). */
  private write<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  /** Next `<prefix><n>` for `table`. Call only inside `write`. `pad` zero-pads the number. */
  private nextId(table: string, prefix: string, pad = 0): string {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(CAST(SUBSTR(id, ?) AS INTEGER)), 0) + 1 AS n FROM ${table} WHERE id LIKE ?`,
      )
      .get(prefix.length + 1, `${prefix}%`) as { n: number };
    return `${prefix}${String(row.n).padStart(pad, '0')}`;
  }

  // ---- initiatives -------------------------------------------------------

  /** Called by InitiativeConfigService only. Keeps created_at and the reason columns on update. */
  upsertInitiative(row: InitiativeRow): void {
    const at = this.iso();
    this.db
      .prepare(
        `INSERT INTO initiatives (${INITIATIVE_COLS}, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           personality_id = excluded.personality_id, origin = excluded.origin,
           parent_id = excluded.parent_id, state = excluded.state,
           config_path = excluded.config_path, config_hash = excluded.config_hash,
           version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(
        row.id,
        row.personalityId,
        row.origin,
        row.parentId,
        row.state,
        row.configPath,
        row.configHash,
        row.version,
        at,
        at,
      );
  }

  getInitiative(id: string): InitiativeRow | null {
    const r = this.db.prepare(`SELECT ${INITIATIVE_COLS} FROM initiatives WHERE id = ?`).get(id) as
      | InitiativeDbRow
      | undefined;
    return r ? toInitiative(r) : null;
  }

  appendConfigVersion(v: {
    initiativeId: string;
    version: number;
    hash: string;
    diff: string;
    sessionId: string | null;
    confirmedBy: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO config_versions (initiative_id, version, hash, diff, session_id, confirmed_by, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.initiativeId, v.version, v.hash, v.diff, v.sessionId, v.confirmedBy, this.iso());
  }

  /**
   * Narrow view for ledger tools: only the `InitiativeLedgerPort` methods, bound,
   * on a frozen object. No decision writer, config writer or transition.
   * Pinned by `R13 ledger tool port has no decision writer`.
   */
  ledgerPort(): InitiativeLedgerPort {
    return Object.freeze({
      addIdea: this.addIdea.bind(this),
      propose: this.propose.bind(this),
      proposeInitiativeDraft: this.proposeInitiativeDraft.bind(this),
      addFinding: this.addFinding.bind(this),
      submitBrief: this.submitBrief.bind(this),
      addQuestion: this.addQuestion.bind(this),
      ideas: this.ideas.bind(this),
      budget: this.budget.bind(this),
      ownerOf: this.ownerOf.bind(this),
    });
  }

  // ---- transitions and decisions -----------------------------------------

  /** Throws `INITIATIVE_ILLEGAL_TRANSITION` on a move INITIATIVE_TRANSITIONS does not allow. */
  transitionInitiative(id: string, to: InitiativeState, why: string): void {
    this.write(() => this.moveInitiative(id, to, why));
  }

  /** Throws `INITIATIVE_ILLEGAL_TRANSITION` on a move EXPLORATION_TRANSITIONS does not allow. */
  transitionExploration(id: string, to: ExplorationState, _why: string): void {
    this.write(() => this.moveExploration(id, to));
  }

  /**
   * Approval surfaces only. One transaction: the transition the verdict implies
   * (see IMPLIED) and the decision row. An illegal transition, an unknown target
   * or a verdict that does not belong to the gate throws and writes nothing.
   * `why` is kept only where a column exists: `paused_reason` and `stop_reason`.
   */
  recordDecision(d: Omit<DecisionRow, 'id' | 'at'>): DecisionRow {
    if (d.decidedBy.trim() === '') {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'a decision needs decided_by',
        action: 'Record who made the decision (owner_ui, owner_chat or a user id).',
      });
    }
    const implied = d.gate === 'config_change' ? undefined : IMPLIED[d.gate]?.[d.verdict];
    if (d.gate !== 'config_change' && implied === undefined) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `verdict ${d.verdict} does not belong to ${d.gate}`,
        action: 'Use a verdict that gate offers.',
        details: { gate: d.gate, verdict: d.verdict },
      });
    }
    return this.write(() => {
      let initiativeId: string;
      if (implied && 'exploration' in implied) {
        const e = this.requireExploration(d.target);
        initiativeId = e.initiativeId;
        if (implied.exploration !== null) {
          this.moveExploration(d.target, implied.exploration);
        }
      } else {
        this.requireInitiative(d.target);
        initiativeId = d.target;
        if (implied && 'initiative' in implied) {
          this.moveInitiative(d.target, implied.initiative, d.reason ?? d.verdict);
        }
      }
      const id = this.nextId('decisions', 'DEC-');
      const at = this.iso();
      this.db
        .prepare(
          `INSERT INTO decisions (id, target, gate, verdict, reason, option, decided_by, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, d.target, d.gate, d.verdict, d.reason, d.option, d.decidedBy, at);
      this.db
        .prepare('UPDATE initiatives SET last_reaction_at = ?, updated_at = ? WHERE id = ?')
        .run(at, at, initiativeId);
      return { ...d, id, at };
    });
  }

  private requireInitiative(id: string): InitiativeRow {
    const row = this.getInitiative(id);
    if (!row) {
      throw new EthosError({
        code: 'NOT_FOUND',
        cause: `initiative ${id} does not exist`,
        action: 'Check the initiative id.',
        details: { id },
      });
    }
    return row;
  }

  private requireExploration(id: string): ExplorationRow {
    const row = this.getExploration(id);
    if (!row) {
      throw new EthosError({
        code: 'NOT_FOUND',
        cause: `exploration ${id} does not exist`,
        action: 'Check the exploration id.',
        details: { id },
      });
    }
    return row;
  }

  private moveInitiative(id: string, to: InitiativeState, why: string): void {
    const from = this.requireInitiative(id).state;
    if (!canTransition(INITIATIVE_TRANSITIONS, from, to)) {
      throw new EthosError({
        code: 'INITIATIVE_ILLEGAL_TRANSITION',
        cause: `initiative ${id} cannot move ${from} -> ${to}`,
        action: 'Reload the initiative and choose a decision valid from its current state.',
        details: { id, from, to },
      });
    }
    this.db
      .prepare(
        `UPDATE initiatives SET state = ?, updated_at = ?,
           paused_reason = CASE WHEN ? = 'paused' THEN ? ELSE paused_reason END,
           stop_reason = CASE WHEN ? = 'stopped' THEN ? ELSE stop_reason END
         WHERE id = ?`,
      )
      .run(to, this.iso(), to, why, to, why, id);
  }

  private moveExploration(id: string, to: ExplorationState): void {
    const from = this.requireExploration(id).state;
    if (!canTransition(EXPLORATION_TRANSITIONS, from, to)) {
      throw new EthosError({
        code: 'INITIATIVE_ILLEGAL_TRANSITION',
        cause: `exploration ${id} cannot move ${from} -> ${to}`,
        action: 'Reload the exploration and choose a decision valid from its current state.',
        details: { id, from, to },
      });
    }
    this.db
      .prepare('UPDATE explorations SET state = ?, updated_at = ? WHERE id = ?')
      .run(to, this.iso(), id);
  }

  // ---- ideas, explorations, findings, briefs -----------------------------

  addIdea(i: Omit<IdeaRow, 'id' | 'createdAt'>): IdeaRow {
    return this.write(() => {
      const id = this.nextId('ideas', 'I-');
      const createdAt = this.iso();
      this.db
        .prepare(
          `INSERT INTO ideas (id, initiative_id, origin, text, source_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, i.initiativeId, i.origin, i.text, i.sourceRef, createdAt);
      return { ...i, id, createdAt };
    });
  }

  ownerOf(kind: 'exploration' | 'idea', id: string): string | null {
    const sql =
      kind === 'exploration'
        ? 'SELECT initiative_id FROM explorations WHERE id = ?'
        : 'SELECT initiative_id FROM ideas WHERE id = ?';
    const r = this.db.prepare(sql).get(id) as { initiative_id: string } | undefined;
    return r ? r.initiative_id : null;
  }

  ideas(initiativeId: string): IdeaRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, initiative_id, origin, text, source_ref, created_at FROM ideas
         WHERE initiative_id = ? ORDER BY created_at, rowid`,
      )
      .all(initiativeId) as IdeaDbRow[];
    return rows.map(toIdea);
  }

  /** A new exploration in `proposed`; the estimate is its budget until an owner decides otherwise. */
  propose(p: {
    initiativeId: string;
    ideaId: string | null;
    question: string;
    estimateUsd: number;
    days: number;
  }): ExplorationRow {
    return this.write(() => {
      const id = this.nextId('explorations', 'EXP-', 4);
      const at = this.iso();
      const deadline = new Date(this.now() + p.days * DAY_MS).toISOString();
      const cap = this.explorationCapFor?.(p.initiativeId);
      const budget = cap === undefined ? p.estimateUsd : clampExplorationBudget(p.estimateUsd, cap);
      this.db
        .prepare(
          `INSERT INTO explorations (id, initiative_id, idea_id, question, state, budget_usd,
             spent_usd, estimate_usd, deadline, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'proposed', ?, 0, ?, ?, ?, ?)`,
        )
        .run(id, p.initiativeId, p.ideaId, p.question, budget, p.estimateUsd, deadline, at, at);
      return this.requireExploration(id);
    });
  }

  /** Runner only: a reopened exploration gets a fresh budget and deadline (see lifecycle.ts). */
  extendExploration(id: string, e: { addBudgetUsd: number; deadline: string }): ExplorationRow {
    return this.write(() => {
      this.requireExploration(id);
      extendExplorationRow(this.db, id, e, this.iso());
      return this.requireExploration(id);
    });
  }

  getExploration(id: string): ExplorationRow | null {
    const r = this.db
      .prepare(`SELECT ${EXPLORATION_COLS} FROM explorations WHERE id = ?`)
      .get(id) as ExplorationDbRow | undefined;
    return r ? toExploration(r) : null;
  }

  explorations(initiativeId: string, states?: ExplorationState[]): ExplorationRow[] {
    const filter = states?.length ? ` AND state IN (${inClause(states)})` : '';
    const rows = this.db
      .prepare(
        `SELECT ${EXPLORATION_COLS} FROM explorations WHERE initiative_id = ?${filter}
         ORDER BY created_at, rowid`,
      )
      .all(initiativeId, ...(states ?? [])) as ExplorationDbRow[];
    return rows.map(toExploration);
  }

  addFinding(f: Omit<FindingRow, 'id' | 'createdAt'>): FindingRow {
    return this.write(() => {
      const id = this.nextId('findings', 'F-');
      const createdAt = this.iso();
      this.db
        .prepare(
          `INSERT INTO findings (id, exploration_id, claim, source_ref, confidence, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, f.explorationId, f.claim, f.sourceRef, f.confidence, createdAt);
      return { ...f, id, createdAt };
    });
  }

  /** Versions count per exploration, from 1. */
  submitBrief(b: Omit<BriefRow, 'id' | 'version'>): BriefRow {
    return this.write(() => {
      const id = this.nextId('briefs', 'B-');
      const row = this.db
        .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM briefs WHERE exploration_id = ?')
        .get(b.explorationId) as { v: number };
      this.db
        .prepare(
          `INSERT INTO briefs (id, exploration_id, version, body_md, recommended_option, partial, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          b.explorationId,
          row.v,
          b.bodyMd,
          b.recommendedOption,
          b.partial ? 1 : 0,
          this.iso(),
        );
      return { ...b, id, version: row.v };
    });
  }

  // ---- drafts, questions -------------------------------------------------

  proposeInitiativeDraft(d: { parentId: string; draftYaml: string; why: string }): {
    draftId: string;
  } {
    return this.write(() => {
      const draftId = this.nextId('drafts', 'D-');
      this.db
        .prepare(
          `INSERT INTO drafts (id, parent_id, draft_yaml, why, status, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?)`,
        )
        .run(draftId, d.parentId, d.draftYaml, d.why, this.iso());
      return { draftId };
    });
  }

  drafts(status: DraftStatus): DraftRow[] {
    return selectDrafts(this.db, status);
  }

  settleDraft(id: string, status: 'materialised' | 'refused', refusal: string | null): void {
    this.write(() => settleDraftRow(this.db, id, status, refusal));
  }

  reactionClock(id: string): ReturnType<typeof reactionClockRow> {
    return reactionClockRow(this.db, id);
  }

  addQuestion(q: { initiativeId: string; explorationId: string | null; text: string }): string {
    return this.write(() => {
      const id = this.nextId('questions', 'Q-');
      this.db
        .prepare(
          `INSERT INTO questions (id, initiative_id, exploration_id, text, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, q.initiativeId, q.explorationId, q.text, this.iso());
      return id;
    });
  }

  questions(initiativeId: string): QuestionRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, initiative_id, exploration_id, text, answer, created_at, answered_at FROM questions
         WHERE initiative_id = ? ORDER BY created_at, rowid`,
      )
      .all(initiativeId) as QuestionDbRow[];
    return rows.map(toQuestion);
  }

  // ---- windows and budget ------------------------------------------------

  openWindow(w: { initiativeId: string; explorationId: string | null; kind: WindowKind }): string {
    return this.write(() => {
      const id = this.nextId('windows', 'W-');
      this.db
        .prepare(
          `INSERT INTO windows (id, initiative_id, exploration_id, kind, started) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, w.initiativeId, w.explorationId, w.kind, this.iso());
      return id;
    });
  }

  /**
   * Closes an open window and, in the same transaction, adds its spend to its
   * exploration. A missing or already-closed window throws, so spend is never
   * counted twice.
   */
  closeWindow(
    id: string,
    r: {
      spentUsd: number;
      toolsUsed: string[];
      reads: string[];
      checkpoint: string | null;
      endReason: string;
    },
  ): void {
    this.write(() => {
      const at = this.iso();
      const closed = this.db
        .prepare(
          `UPDATE windows SET ended = ?, spent_usd = ?, tools_used = ?, reads = ?, checkpoint = ?, end_reason = ?
           WHERE id = ? AND ended IS NULL`,
        )
        .run(
          at,
          r.spentUsd,
          JSON.stringify(r.toolsUsed),
          JSON.stringify(r.reads),
          r.checkpoint,
          r.endReason,
          id,
        );
      if (closed.changes === 0) {
        throw new EthosError({
          code: 'NOT_FOUND',
          cause: `window ${id} is not open`,
          action: 'Open a window before closing it; a window closes once.',
          details: { windowId: id },
        });
      }
      const win = this.db.prepare('SELECT exploration_id FROM windows WHERE id = ?').get(id) as {
        exploration_id: string | null;
      };
      if (win.exploration_id !== null) {
        this.db
          .prepare('UPDATE explorations SET spent_usd = spent_usd + ?, updated_at = ? WHERE id = ?')
          .run(r.spentUsd, at, win.exploration_id);
      }
    });
  }

  windows(initiativeId: string): WindowRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, initiative_id, exploration_id, kind, started, ended, spent_usd, tools_used, reads,
                checkpoint, end_reason FROM windows
         WHERE initiative_id = ? ORDER BY started, rowid`,
      )
      .all(initiativeId) as WindowDbRow[];
    return rows.map(toWindow);
  }

  /** `day` is a UTC `YYYY-MM-DD`; spend is the windows that STARTED on it. */
  budget(
    initiativeId: string,
    day: string,
  ): { spentUsd: number; capUsd: number; explorationsOpen: number } {
    const spent = this.db
      .prepare(
        `SELECT COALESCE(SUM(spent_usd), 0) AS s FROM windows
         WHERE initiative_id = ? AND substr(started, 1, 10) = ?`,
      )
      .get(initiativeId, day) as { s: number };
    const open = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM explorations
         WHERE initiative_id = ? AND state IN (${inClause(OPEN_EXPLORATION_STATES)})`,
      )
      .get(initiativeId, ...OPEN_EXPLORATION_STATES) as { n: number };
    return { spentUsd: spent.s, capUsd: this.capFor(initiativeId), explorationsOpen: open.n };
  }

  // ---- recall ------------------------------------------------------------

  list(filter: { personalityId: string; states?: InitiativeState[] }): InitiativeRow[] {
    const states = filter.states ?? [];
    const clause = states.length ? ` AND state IN (${inClause(states)})` : '';
    const rows = this.db
      .prepare(
        `SELECT ${INITIATIVE_COLS} FROM initiatives WHERE personality_id = ?${clause}
         ORDER BY created_at, rowid`,
      )
      .all(filter.personalityId, ...states) as InitiativeDbRow[];
    return rows.map(toInitiative);
  }

  get(id: string): {
    initiative: InitiativeRow;
    explorations: ExplorationRow[];
    briefs: BriefRow[];
    findings: FindingRow[];
  } | null {
    const initiative = this.getInitiative(id);
    if (!initiative) return null;
    const briefs = this.db
      .prepare(
        `SELECT b.id, b.exploration_id, b.version, b.body_md, b.recommended_option, b.partial
         FROM briefs b JOIN explorations e ON e.id = b.exploration_id
         WHERE e.initiative_id = ? ORDER BY b.created_at, b.rowid`,
      )
      .all(id) as BriefDbRow[];
    const findings = this.db
      .prepare(
        `SELECT f.id, f.exploration_id, f.claim, f.source_ref, f.confidence, f.created_at
         FROM findings f JOIN explorations e ON e.id = f.exploration_id
         WHERE e.initiative_id = ? ORDER BY f.created_at, f.rowid`,
      )
      .all(id) as FindingDbRow[];
    return {
      initiative,
      explorations: this.explorations(id),
      briefs: briefs.map(toBrief),
      findings: findings.map(toFinding),
    };
  }

  /**
   * LIKE over findings.claim, briefs.body_md and explorations.question for one
   * personality, findings first, then briefs, then explorations. `%`, `_` and
   * `\` in `q` match literally. LIKE is ASCII case-insensitive; FTS5 is deferred
   * because FTS5 tables cannot be STRICT.
   */
  search(
    personalityId: string,
    q: string,
    limit: number,
  ): Array<{ kind: 'finding' | 'brief' | 'exploration'; id: string; snippet: string }> {
    const needle = q.trim();
    if (needle === '' || limit <= 0) return [];
    const pattern = `%${needle.replace(/[\\%_]/g, '\\$&')}%`;
    const sources = [
      {
        kind: 'finding',
        col: 'x.claim',
        sql: 'findings x JOIN explorations e ON e.id = x.exploration_id',
      },
      {
        kind: 'brief',
        col: 'x.body_md',
        sql: 'briefs x JOIN explorations e ON e.id = x.exploration_id',
      },
      {
        kind: 'exploration',
        col: 'x.question',
        sql: 'explorations x JOIN explorations e ON e.id = x.id',
      },
    ] as const;
    const out: Array<{ kind: 'finding' | 'brief' | 'exploration'; id: string; snippet: string }> =
      [];
    for (const src of sources) {
      const rows = this.db
        .prepare(
          `SELECT x.id AS id, ${src.col} AS text FROM ${src.sql}
           JOIN initiatives i ON i.id = e.initiative_id
           WHERE i.personality_id = ? AND ${src.col} LIKE ? ESCAPE '\\'
           ORDER BY x.created_at, x.rowid LIMIT ?`,
        )
        .all(personalityId, pattern, limit - out.length) as Array<{ id: string; text: string }>;
      for (const r of rows)
        out.push({ kind: src.kind, id: r.id, snippet: snippet(r.text, needle) });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * One line per active or self_started initiative, each followed by one line
   * per open exploration (proposed, exploring, stalled, briefed). Ordered by
   * created_at, rowid and free of anything that changes between calls, so the
   * prompt prefix built from it stays byte-identical (prompt-prefix-stability).
   */
  indexLines(personalityId: string, max: number): string[] {
    const lines: string[] = [];
    for (const ini of this.list({ personalityId, states: ['active', 'self_started'] })) {
      lines.push(`INI ${ini.id} (${ini.state})`);
      for (const e of this.explorations(ini.id, [...INDEX_EXPLORATION_STATES])) {
        lines.push(`${e.id} ${e.state}: ${clip(e.question, 80)} (due ${e.deadline.slice(0, 10)})`);
      }
      if (lines.length >= max) break;
    }
    return lines.slice(0, Math.max(0, max));
  }

  /** Decisions on this personality's initiatives (or their explorations) at or after `sinceIso`. */
  decisionsSince(personalityId: string, sinceIso: string): DecisionRow[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.target, d.gate, d.verdict, d.reason, d.option, d.decided_by, d.at
         FROM decisions d
         LEFT JOIN explorations e ON e.id = d.target
         JOIN initiatives i ON i.id = COALESCE(e.initiative_id, d.target)
         WHERE i.personality_id = ? AND d.at >= ?
         ORDER BY d.at, d.rowid`,
      )
      .all(personalityId, sinceIso) as DecisionDbRow[];
    return rows.map(toDecision);
  }
}
