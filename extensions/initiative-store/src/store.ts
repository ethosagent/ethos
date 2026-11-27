import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database, { migrate } from '@ethosagent/sqlite';
import {
  type BriefRow,
  type DraftRow,
  type DraftStatus,
  EthosError,
  type ExplorationRow,
  type ExplorationState,
  type FindingRow,
  type IdeaRow,
  type InitiativeLedgerPort,
  type InitiativeOrigin,
  type InitiativeRow,
  type InitiativeState,
  type QuestionRow,
  type WindowKind,
  type WindowRow,
} from '@ethosagent/types';
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

interface DraftDbRow {
  id: string;
  parent_id: string;
  draft_yaml: string;
  why: string;
  status: string;
  refusal: string | null;
  created_at: string;
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

function toDraft(r: DraftDbRow): DraftRow {
  return {
    id: r.id,
    parentId: r.parent_id,
    draftYaml: r.draft_yaml,
    why: r.why,
    status: r.status as DraftStatus,
    refusal: r.refusal,
    createdAt: r.created_at,
  };
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
export class SQLiteInitiativeStore implements InitiativeLedgerPort {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly capFor: (initiativeId: string) => number;

  constructor(dbPath: string, opts: SQLiteInitiativeStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.capFor = opts.capFor ?? (() => 0);
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
      this.db
        .prepare(
          `INSERT INTO explorations (id, initiative_id, idea_id, question, state, budget_usd,
             spent_usd, estimate_usd, deadline, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'proposed', ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          id,
          p.initiativeId,
          p.ideaId,
          p.question,
          p.estimateUsd,
          p.estimateUsd,
          deadline,
          at,
          at,
        );
      return {
        id,
        initiativeId: p.initiativeId,
        ideaId: p.ideaId,
        question: p.question,
        state: 'proposed',
        budgetUsd: p.estimateUsd,
        spentUsd: 0,
        deadline,
        estimateUsd: p.estimateUsd,
      };
    });
  }

  getExploration(id: string): ExplorationRow | null {
    const r = this.db
      .prepare(`SELECT ${EXPLORATION_COLS} FROM explorations WHERE id = ?`)
      .get(id) as ExplorationDbRow | undefined;
    return r ? toExploration(r) : null;
  }

  explorations(initiativeId: string, states?: ExplorationState[]): ExplorationRow[] {
    const filter = states?.length ? ` AND state IN (${states.map(() => '?').join(', ')})` : '';
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
    const rows = this.db
      .prepare(
        `SELECT id, parent_id, draft_yaml, why, status, refusal, created_at FROM drafts
         WHERE status = ? ORDER BY created_at, rowid`,
      )
      .all(status) as DraftDbRow[];
    return rows.map(toDraft);
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
         WHERE initiative_id = ? AND state IN (${OPEN_EXPLORATION_STATES.map(() => '?').join(', ')})`,
      )
      .get(initiativeId, ...OPEN_EXPLORATION_STATES) as { n: number };
    return { spentUsd: spent.s, capUsd: this.capFor(initiativeId), explorationsOpen: open.n };
  }
}
