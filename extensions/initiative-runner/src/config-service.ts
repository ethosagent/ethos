import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { clampInitiativeBudgets } from '@ethosagent/constitution';
import { nextRunForSchedule } from '@ethosagent/cron';
import { sensitiveDenyPaths } from '@ethosagent/storage-fs';
import {
  assertSafeId,
  type Constitution,
  canTransition,
  type GuidanceMapping,
  INITIATIVE_TRANSITIONS,
  type InitiativeConfigPort,
  type InitiativeState,
  type InitiativeStore,
  type Storage,
} from '@ethosagent/types';
import { parse, stringify } from 'yaml';
import {
  AUTONOMY_MODES,
  type InitiativeFile,
  InitiativeFileSchema,
  type InitiativeSettings,
} from './config-schema';
import { mapGuidance } from './guidance';
import { nextSlotAfter } from './slots';
import { checkSources } from './sources';

type SaveInput = Parameters<InitiativeConfigPort['save']>[0];
type SaveResult = Awaited<ReturnType<InitiativeConfigPort['save']>>;
type Refusal = { ok: false; error: string };

/** Constitution defaults for `maxSelfStarted` and `selfStartPoolUsdPerDay`. */
export const MAX_SELF_STARTED_DEFAULT = 2;
export const SELF_START_POOL_USD_DEFAULT = 0.5;
const RESERVED_IDS: readonly string[] = ['settings'];

export interface InitiativeConfigServiceDeps {
  /** Compose-time Storage; the only writer of `initiatives/*.yaml`. */
  storage: Storage;
  dataDir: string;
  store: Pick<
    InitiativeStore,
    'upsertInitiative' | 'appendConfigVersion' | 'getInitiative' | 'list' | 'transitionInitiative'
  >;
  constitution: () => Promise<Constitution>;
  settings: (personalityId: string) => Promise<InitiativeSettings>;
  toolset: (personalityId: string) => readonly string[];
  schedule: (initiativeId: string) => void;
  now?: () => number;
}

const refuse = (error: string): Refusal => ({ ok: false, error });

function describe(err: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return err.issues
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lineDiff(before: string, after: string): string {
  const a = new Set(before.split('\n'));
  const b = new Set(after.split('\n'));
  return [
    ...before
      .split('\n')
      .filter((l) => !b.has(l))
      .map((l) => `- ${l}`),
    ...after
      .split('\n')
      .filter((l) => !a.has(l))
      .map((l) => `+ ${l}`),
  ].join('\n');
}

/**
 * R6: an agent child may only narrow its parent. Looser means more `exclude`
 * entries dropped, a mode later in AUTONOMY_MODES (ask < free_under < free), a
 * higher `ask_above_usd` (absent = unbounded) or any larger budget field.
 */
const WINDOW_PROBE_START = new Date('2026-01-01T00:00:00Z');
const WINDOWS_PER_DAY_MAX = 1000;

/** How many times these schedules fire in one day (counted from a fixed probe day; capped). */
function windowsPerDay(schedules: readonly string[]): number {
  const end = WINDOW_PROBE_START.getTime() + 86_400_000;
  let n = 0;
  for (const schedule of schedules) {
    let cursor = WINDOW_PROBE_START;
    for (let i = 0; i < WINDOWS_PER_DAY_MAX; i++) {
      const next = nextRunForSchedule(schedule, cursor);
      if (next === null || next.getTime() >= end) break;
      n++;
      cursor = next;
    }
  }
  return n;
}

/**
 * A draft inherits nothing it can loosen: no more excluded paths dropped, no looser autonomy, no
 * bigger budget, and (timeline) no more windows per day, no longer window and no longer default
 * run than the parent. Pinned by `__tests__/initiative-draft-no-widen.test.ts`.
 * Limitation: the windows-per-day count is measured on one probe day, so a cron that fires only
 * on some weekdays is judged by that day alone.
 */
function widening(parent: InitiativeFile, child: InitiativeFile): string | null {
  const missing = parent.exclude.find((e) => !child.exclude.includes(e));
  if (missing !== undefined) return `exclude: the parent's "${missing}" must stay excluded`;
  const rank = (m: InitiativeFile['autonomy']['mode']) => AUTONOMY_MODES.indexOf(m);
  if (rank(child.autonomy.mode) > rank(parent.autonomy.mode)) {
    return `autonomy: "${child.autonomy.mode}" is looser than the parent's "${parent.autonomy.mode}"`;
  }
  if (child.autonomy.mode === 'free_under' && parent.autonomy.mode === 'free_under') {
    const cap = (d: InitiativeFile) => d.autonomy.ask_above_usd ?? Number.POSITIVE_INFINITY;
    if (cap(child) > cap(parent)) return "autonomy.ask_above_usd: higher than the parent's";
  }
  for (const k of ['usd_per_day', 'usd_per_exploration', 'max_open_explorations'] as const) {
    if (child.budget[k] > parent.budget[k])
      return `budget.${k}: exceeds the parent's ${parent.budget[k]}`;
  }
  const t = (d: InitiativeFile) => d.timeline;
  if (windowsPerDay(t(child).explore_windows) > windowsPerDay(t(parent).explore_windows)) {
    return "timeline.explore_windows: more windows per day than the parent's";
  }
  for (const k of ['window_minutes', 'default_days'] as const) {
    if (t(child)[k] > t(parent)[k]) return `timeline.${k}: exceeds the parent's ${t(parent)[k]}`;
  }
  return null;
}

/** Guidance for "our code/repo" maps to read_file only when a `repo` source covers it. */
function mapForSources(doc: InitiativeFile, toolset: readonly string[]): GuidanceMapping[] {
  return mapGuidance(
    doc.guidance.map((g) => g.text),
    { toolset, level: 'initiative' },
  ).map((m) =>
    m.status === 'mapped' &&
    m.mapsTo.includes('read_file') &&
    !doc.sources.some((s) => typeof s === 'object')
      ? { ...m, status: 'unreachable', mapsTo: [], reason: 'no repo source covers it' }
      : m,
  );
}

/**
 * L10: the single writer of `personalities/<id>/initiatives/<id>.yaml`.
 * Every refusal returns the exact reason and leaves the file untouched.
 * Pinned by `__tests__/config-service.test.ts`, `initiative-sources-roots.test.ts`
 * and `initiative-draft-no-widen.test.ts`.
 */
export class InitiativeConfigService implements InitiativeConfigPort {
  private readonly now: () => number;

  constructor(private readonly deps: InitiativeConfigServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private dir(personalityId: string): string {
    return join(this.deps.dataDir, 'personalities', personalityId, 'initiatives');
  }

  private async blocked(): Promise<string[]> {
    return sensitiveDenyPaths([this.deps.dataDir]);
  }

  async save(input: SaveInput): Promise<SaveResult> {
    try {
      assertSafeId(input.personalityId, 'personality');
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }
    return input.op === 'create' || input.op === 'update'
      ? this.saveDraft(input)
      : this.saveState(input);
  }

  private async readDoc(path: string): Promise<InitiativeFile | Refusal | null> {
    const raw = await this.deps.storage.read(path);
    if (raw === null) return null;
    let doc: unknown;
    try {
      doc = parse(raw);
    } catch (err) {
      return refuse(
        `${path} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const r = InitiativeFileSchema.safeParse(doc);
    return r.success ? r.data : refuse(`${path} is invalid: ${describe(r.error)}`);
  }

  private async saveDraft(input: SaveInput): Promise<SaveResult> {
    const { personalityId, op } = input;
    if (!isRecord(input.draft)) return refuse('draft must be a mapping');
    const raw = input.draft;

    const id = raw.id;
    if (typeof id !== 'string') return refuse('id: must be a string');
    try {
      assertSafeId(id, 'initiative');
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }
    if (RESERVED_IDS.includes(id)) return refuse(`id "${id}" is reserved`);

    const path = join(this.dir(personalityId), `${id}.yaml`);
    const row = this.deps.store.getInitiative(id);
    if (row !== null && row.personalityId !== personalityId) {
      return refuse(`id "${id}" belongs to another personality`);
    }
    const found = await this.readDoc(path);
    // O-4: an owner update may replace a file that no longer parses (the stuck
    // hand edit); the runner and `create` may not. Pinned by config-service.test.ts.
    const stuck =
      found !== null &&
      'ok' in found &&
      op === 'update' &&
      input.confirmedBy === 'owner_chat' &&
      row !== null;
    if (found !== null && 'ok' in found && !stuck) return found;
    const existing = found !== null && 'ok' in found ? null : found;
    if (op === 'create' && (found !== null || row !== null)) {
      return refuse(`initiative "${id}" already exists; use update`);
    }
    if (op === 'update' && (found === null || row === null)) {
      return refuse(`initiative "${id}" does not exist; use create`);
    }

    const constitution = await this.deps.constitution();
    const blocked = await this.blocked();
    const readableRoots = constitution.initiatives?.readableRoots ?? [];

    const base = {
      ...raw,
      version: (existing?.version ?? (stuck ? row?.version : 0) ?? 0) + 1,
      state:
        existing?.state ??
        (stuck ? row?.state : undefined) ??
        (raw.origin === 'agent' ? 'self_started' : 'active'),
    };
    const parsed = InitiativeFileSchema.safeParse(base);
    if (!parsed.success) return refuse(describe(parsed.error));
    const doc = parsed.data;

    if ((doc.origin === 'agent') !== (input.confirmedBy === 'runner')) {
      return refuse(
        doc.origin === 'agent'
          ? 'an agent-origin initiative is saved only by the runner'
          : 'the runner may save only agent-origin initiatives',
      );
    }

    if (existing !== null && existing.origin !== doc.origin) {
      return refuse(`origin cannot change (this initiative is ${existing.origin}-origin)`);
    }

    const settings = await this.deps.settings(personalityId);
    let parentSources: InitiativeFile['sources'] | undefined;
    let parentDoc: InitiativeFile | undefined;
    if (doc.origin === 'agent') {
      if (!settings.selfStart) return refuse('self-start is off for this personality (selfStart)');
      const cap = constitution.initiatives?.maxSelfStarted ?? MAX_SELF_STARTED_DEFAULT;
      const open = this.deps.store.list({ personalityId, states: ['self_started'] });
      if (existing === null && open.length >= cap) {
        return refuse(`self-start pool is full (${open.length} of ${cap})`);
      }
      if (doc.parent_id === undefined)
        return refuse('parent_id: an agent initiative needs a parent');
      const parentRow = this.deps.store.getInitiative(doc.parent_id);
      if (parentRow === null || parentRow.personalityId !== personalityId) {
        return refuse(`parent "${doc.parent_id}" not found`);
      }
      const parent = await this.readDoc(parentRow.configPath);
      if (parent === null) return refuse(`parent "${doc.parent_id}" has no file`);
      if ('ok' in parent) return parent;
      parentSources = parent.sources;
      parentDoc = parent;
    }

    const sources = checkSources(doc.sources, { readableRoots, blocked, parentSources });
    if (!sources.ok) return refuse(sources.error);

    if (parentDoc !== undefined) {
      const widened = widening(parentDoc, doc);
      if (widened !== null) return refuse(widened);
    }

    const clamp = clampInitiativeBudgets(
      {
        settings: { dailyBudgetUsd: settings.dailyBudgetUsd },
        initiative: {
          usdPerDay: doc.budget.usd_per_day,
          usdPerExploration: doc.budget.usd_per_exploration,
        },
      },
      constitution.initiatives,
    );
    doc.budget.usd_per_day = clamp.usdPerDay;
    doc.budget.usd_per_exploration = clamp.usdPerExploration;
    const clamps = [...clamp.clamps];
    if (doc.origin === 'agent') {
      const pool = constitution.initiatives?.selfStartPoolUsdPerDay ?? SELF_START_POOL_USD_DEFAULT;
      if (doc.budget.usd_per_day > pool) {
        clamps.push(`usd_per_day: ${doc.budget.usd_per_day} lowered to ${pool} (self-start pool)`);
        doc.budget.usd_per_day = pool;
      }
    }

    // O-2 (leaning): budget, sources and autonomy change spend or reach, so the
    // runner may not change them on an existing initiative; wording saves directly.
    if (existing !== null && input.confirmedBy === 'runner') {
      const reach = (d: InitiativeFile) => JSON.stringify([d.sources, d.budget, d.autonomy]);
      if (reach(existing) !== reach(doc)) {
        return refuse('changing budget, sources or autonomy needs the owner to confirm');
      }
    }

    const guidance = mapForSources(doc, this.deps.toolset(personalityId));
    const refused = guidance.find((m) => m.status === 'refused');
    if (refused)
      return refuse(`guidance "${refused.text}" refused: ${refused.reason ?? 'not allowed'}`);
    doc.guidance = doc.guidance.map((g, i) => ({
      ...g,
      status: guidance[i]?.status,
      maps_to: guidance[i]?.mapsTo,
    }));

    await this.persist({ doc, path, personalityId, input, before: existing });
    return { ok: true, id, version: doc.version, clamps, guidance, ...this.nextSurvey(doc) };
  }

  private async saveState(input: SaveInput): Promise<SaveResult> {
    const { personalityId, op } = input;
    const id = isRecord(input.draft) ? input.draft.id : undefined;
    const target = typeof id === 'string' ? id : undefined;
    const row = target === undefined ? null : this.deps.store.getInitiative(target);
    if (target === undefined || row === null)
      return refuse('state changes need draft.id of an existing initiative');
    if (row.personalityId !== personalityId)
      return refuse(`initiative "${target}" belongs to another personality`);
    if (input.confirmedBy === 'runner')
      return refuse('the runner cannot pause, resume or end an initiative');
    const doc = await this.readDoc(row.configPath);
    if (doc === null) return refuse(`initiative "${target}" has no file`);
    if ('ok' in doc) return doc;

    const hops: InitiativeState[] =
      op === 'pause'
        ? ['paused']
        : op === 'resume'
          ? ['active']
          : row.state === 'active'
            ? ['review', 'ended']
            : ['ended'];
    // The ledger row is the lifecycle authority: keep/stop change only the row, not the file.
    let from: InitiativeState = row.state;
    for (const to of hops) {
      if (!canTransition(INITIATIVE_TRANSITIONS, from, to)) {
        return refuse(`cannot ${op} an initiative that is ${row.state}`);
      }
      from = to;
    }
    for (const to of hops)
      this.deps.store.transitionInitiative(target, to, `${op} by ${input.confirmedBy}`);
    const next: InitiativeFile = { ...doc, version: doc.version + 1, state: from };
    await this.persist({ doc: next, path: row.configPath, personalityId, input, before: doc });
    return {
      ok: true,
      id: target,
      version: next.version,
      clamps: [],
      guidance: [],
      ...this.nextSurvey(next),
    };
  }

  /** `nextSurveyAt`: the next explore-window slot after now (slots.ts, the tick's own helper). */
  private nextSurvey(doc: InitiativeFile): { nextSurveyAt?: string } {
    // A paused, ended or stopped initiative is not surveyed, so there is no next slot to promise.
    if (doc.state === 'paused' || doc.state === 'ended' || doc.state === 'stopped') return {};
    const at = nextSlotAfter(doc.timeline.explore_windows, new Date(this.now()));
    return at === null ? {} : { nextSurveyAt: at };
  }

  private async persist(a: {
    doc: InitiativeFile;
    path: string;
    personalityId: string;
    input: SaveInput;
    before: InitiativeFile | null;
  }): Promise<void> {
    const { doc, path, personalityId, input, before } = a;
    const text = stringify(doc);
    const previous = before === null ? '' : stringify(before);
    await this.deps.storage.mkdir(this.dir(personalityId));
    await this.deps.storage.writeAtomic(path, text);
    const hash = createHash('sha256').update(text).digest('hex');
    this.deps.store.upsertInitiative({
      id: doc.id,
      personalityId,
      origin: doc.origin,
      parentId: doc.parent_id ?? null,
      state: doc.state,
      configPath: path,
      configHash: hash,
      version: doc.version,
    });
    this.deps.store.appendConfigVersion({
      initiativeId: doc.id,
      version: doc.version,
      hash,
      diff: lineDiff(previous, text),
      sessionId: input.sessionId,
      confirmedBy: input.confirmedBy,
    });
    this.deps.schedule(doc.id);
  }

  /** Re-validate every file; an invalid hand edit pauses that initiative with the reason (O-4). */
  async load(personalityId: string): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    assertSafeId(personalityId, 'personality');
    const dir = this.dir(personalityId);
    const names = (await this.deps.storage.list(dir)).filter(
      (n) => n.endsWith('.yaml') && n !== 'settings.yaml',
    );
    const constitution = await this.deps.constitution();
    const blocked = await this.blocked();
    const readableRoots = constitution.initiatives?.readableRoots ?? [];
    const out: Array<{ id: string; ok: boolean; error?: string }> = [];
    const sorted = names.sort();
    const docs = await Promise.all(sorted.map((name) => this.readDoc(join(dir, name))));
    for (const [i, name] of sorted.entries()) {
      const id = name.slice(0, -'.yaml'.length);
      const doc = docs[i] ?? null;
      let error: string | undefined;
      if (doc !== null && 'ok' in doc) error = doc.error;
      else if (doc !== null) {
        const s = checkSources(doc.sources, { readableRoots, blocked });
        if (!s.ok) error = s.error;
        else if (doc.id !== id) error = `id "${doc.id}" does not match the file name "${name}"`;
      }
      if (error === undefined) {
        out.push({ id, ok: true });
        continue;
      }
      const row = this.deps.store.getInitiative(id);
      if (row !== null && canTransition(INITIATIVE_TRANSITIONS, row.state, 'paused')) {
        this.deps.store.transitionInitiative(id, 'paused', error);
      }
      out.push({ id, ok: false, error });
    }
    return out;
  }
}
