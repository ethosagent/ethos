import { join } from 'node:path';
import {
  assertSafeId,
  EthosError,
  type ExplorationRow,
  IdValidationError,
  type InitiativeRow,
  type PersonalityRegistry,
  type Storage,
} from '@ethosagent/types';
import type {
  ConstitutionInitiatives,
  ConstitutionInitiativesSaveBlock,
  ExploringNowOutputSchema,
  InitiativeActivityOutputSchema,
  InitiativeDecideInput,
  InitiativeDecideOutputSchema,
  InitiativeGetOutputSchema,
  InitiativeListOutputSchema,
  InitiativeMetricsOutputSchema,
  InitiativeSettingsWire,
  InitiativesSettingsOutputSchema,
} from '@ethosagent/web-contracts';
import {
  clampInitiativeSettings,
  createInitiativeCliPort,
  decideInitiative,
  type InitiativeCliPort,
  type InitiativeEnablement,
  initiativeSettingsPath,
  loadInitiativeSettings,
  mapGuidance,
  parseInitiativeFile,
  readInitiativeConstitution,
  renderConstitutionWithInitiatives,
  renderInitiativeSettings,
  validateConstitutionInitiatives,
  validateInitiativeSettings,
} from '@ethosagent/wiring';
import type { z } from 'zod';

// The web side of the initiative engine (plan initiative-engine Task 6.2). This is the ONLY writer
// of `personalities/<id>/initiatives/settings.yaml` and the constitution `initiatives` block: the
// Personality tab and Settings both call it. Writes go through the compose-time Storage with
// `writeAtomic` (RoomPolicyService precedent: a plain operator-surface FsStorage, never a
// turn-scoped one). Reads never create `initiatives.db` (`createInitiativeCliPort` returns null
// when it is absent). Decisions are applied by `decideInitiative` (wiring), never written here.
//
// What keeps an agent out: `initiatives` and `constitution` are not SCOPE_MAP namespaces, so
// bearer keys get 403, and CSRF guards every cookie write. Pinned by
// __tests__/routes/initiatives-rpc.test.ts.
//
// Limitations: locks are in-process (one promise chain); a CLI or hand edit landing between the
// read and the write in another process is not detected. `versions` lists the current version
// only: the config_versions table has no read method on the store.

/** Recorded as `decisions.decided_by`; cookie sessions carry no per-user id (single owner). */
export const WEB_DECIDER = 'owner:web';
const DEFAULT_METRICS_DAYS = 30;
const DEFAULT_ACTIVITY_LIMIT = 50;
const DAY_MS = 86_400_000;

type Out<T extends z.ZodType> = z.infer<T>;

export interface InitiativesServiceOptions {
  storage: Storage;
  dataDir: string;
  personalities: Pick<PersonalityRegistry, 'get' | 'list'>;
  /** Resolved per call: the loop's enablement arrives late (`bindAgentLoop`). */
  enablement?: () => Pick<InitiativeEnablement, 'reload'> | undefined;
  now?: () => Date;
  onError?: (err: unknown) => void;
}

export type DecideServiceResult =
  | ({ ok: true } & Out<typeof InitiativeDecideOutputSchema>)
  | { ok: false; kind: 'not_found' | 'conflict' | 'invalid'; message: string };

export class InitiativesService {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: InitiativesServiceOptions) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async withPort<T>(fn: (port: InitiativeCliPort | null) => Promise<T> | T): Promise<T> {
    const port = await createInitiativeCliPort({
      storage: this.opts.storage,
      dataDir: this.opts.dataDir,
    });
    try {
      return await fn(port);
    } finally {
      port?.close();
    }
  }

  private toolset(personalityId: string): readonly string[] {
    return this.opts.personalities.get(personalityId)?.toolset ?? [];
  }

  private async readFile(row: InitiativeRow) {
    const raw = await this.opts.storage.read(row.configPath);
    if (raw === null) return { raw: null, parsed: null, error: 'initiative file is missing' };
    const parsed = parseInitiativeFile(raw);
    return parsed.ok
      ? { raw, parsed: parsed.file, error: null }
      : { raw, parsed: null, error: parsed.error };
  }

  // -- Initiatives page reads ----------------------------------------------

  async list(input: {
    personalityId?: string | undefined;
    origin?: string | undefined;
    state?: string | undefined;
  }): Promise<Out<typeof InitiativeListOutputSchema>> {
    return this.withPort(async (port) => {
      if (!port) return { items: [] };
      const ids = input.personalityId
        ? [input.personalityId]
        : this.opts.personalities.list().map((p) => p.id);
      const day = (this.opts.now?.() ?? new Date()).toISOString().slice(0, 10);
      const items: Out<typeof InitiativeListOutputSchema>['items'] = [];
      for (const id of ids) {
        for (const row of port.store.list({ personalityId: id })) {
          if (input.origin && row.origin !== input.origin) continue;
          if (input.state && row.state !== input.state) continue;
          const file = await this.readFile(row);
          const budget = port.store.budget(row.id, day);
          items.push({
            id: row.id,
            personalityId: row.personalityId,
            origin: row.origin,
            state: row.state,
            title: file.parsed?.title ?? null,
            version: row.version,
            spendTodayUsd: budget.spentUsd,
            openExplorations: budget.explorationsOpen,
            ...(file.error ? { invalidReason: file.error } : {}),
          });
        }
      }
      return { items };
    });
  }

  async get(id: string): Promise<Out<typeof InitiativeGetOutputSchema>> {
    return this.withPort(async (port) => {
      const detail = port?.store.get(id);
      if (!port || !detail) {
        throw new EthosError({
          code: 'FILE_NOT_FOUND',
          cause: `initiative ${id} does not exist`,
          action: 'Pick an initiative from the list.',
        });
      }
      const file = await this.readFile(detail.initiative);
      if (!file.parsed || file.raw === null) {
        throw new EthosError({
          code: 'CONFIG_INVALID',
          cause: `initiative ${id}: ${file.error}`,
          action: 'Fix the file in chat, then reload.',
        });
      }
      const personalityId = detail.initiative.personalityId;
      return {
        personalityId,
        initiative: file.parsed,
        guidance: mapGuidance(
          file.parsed.guidance.map((g) => g.text),
          { toolset: this.toolset(personalityId), level: 'initiative' },
        ),
        yaml: file.raw,
        versions: [{ version: detail.initiative.version }],
        explorations: detail.explorations.map((e) => {
          const brief = detail.briefs
            .filter((b) => b.explorationId === e.id)
            .reduce<(typeof detail.briefs)[number] | undefined>(
              (a, b) => (!a || b.version > a.version ? b : a),
              undefined,
            );
          return {
            id: e.id,
            question: e.question,
            state: e.state,
            budgetUsd: e.budgetUsd,
            spentUsd: e.spentUsd,
            deadline: e.deadline,
            ...(brief ? { briefMd: brief.bodyMd, recommendedOption: brief.recommendedOption } : {}),
          };
        }),
      };
    });
  }

  async activity(input: {
    initiativeId: string;
    limit?: number | undefined;
  }): Promise<Out<typeof InitiativeActivityOutputSchema>> {
    return this.withPort((port) => {
      const detail = port?.store.get(input.initiativeId);
      if (!port || !detail) return { windows: [] };
      const nowIso = (this.opts.now?.() ?? new Date()).toISOString();
      const windows = port.store
        .windows(input.initiativeId)
        .slice(-(input.limit ?? DEFAULT_ACTIVITY_LIMIT))
        .reverse()
        .map((w) => ({
          id: w.id,
          explorationId: w.explorationId,
          kind: w.kind,
          started: w.started,
          ended: w.ended,
          tools: w.toolsUsed,
          reads: w.reads,
          findings: detail.findings.filter(
            (f) =>
              f.explorationId === w.explorationId &&
              f.createdAt >= w.started &&
              f.createdAt <= (w.ended ?? nowIso),
          ).length,
          costUsd: w.spentUsd,
          endReason: w.endReason,
        }));
      return { windows };
    });
  }

  async exploringNow(input: {
    personalityId?: string | undefined;
  }): Promise<Out<typeof ExploringNowOutputSchema>> {
    return this.withPort(async (port) => {
      if (!port) return { current: null };
      const ids = input.personalityId
        ? [input.personalityId]
        : this.opts.personalities.list().map((p) => p.id);
      let best: {
        row: InitiativeRow;
        window: ReturnType<typeof port.store.windows>[number];
      } | null = null;
      for (const id of ids) {
        for (const row of port.store.list({ personalityId: id })) {
          for (const w of port.store.windows(row.id)) {
            if (w.ended === null && (!best || w.started > best.window.started)) {
              best = { row, window: w };
            }
          }
        }
      }
      if (!best) return { current: null };
      const exploration: ExplorationRow | null = best.window.explorationId
        ? port.store.getExploration(best.window.explorationId)
        : null;
      return {
        current: {
          windowId: best.window.id,
          initiativeId: best.row.id,
          initiativeTitle: (await this.readFile(best.row)).parsed?.title ?? best.row.id,
          explorationId: best.window.explorationId,
          question: exploration?.question ?? null,
          started: best.window.started,
          costSoFarUsd: best.window.spentUsd,
          readOnly: true as const,
        },
      };
    });
  }

  async metrics(input: {
    personalityId: string;
    sinceDays?: number | undefined;
  }): Promise<Out<typeof InitiativeMetricsOutputSchema>> {
    const since = new Date(
      (this.opts.now?.() ?? new Date()).getTime() -
        (input.sinceDays ?? DEFAULT_METRICS_DAYS) * DAY_MS,
    ).toISOString();
    return this.withPort((port) => ({
      since,
      ...(port?.metrics(input.personalityId, since) ?? {
        gate1: { asked: 0, approved: 0, rate: 0 },
        gate2: { briefs: 0, adopted: 0, rate: 0 },
        selfStart: { started: 0, kept: 0, stopped: 0 },
      }),
    }));
  }

  // -- decide ----------------------------------------------------------------

  async decide(input: InitiativeDecideInput): Promise<DecideServiceResult> {
    return this.withPort(async (port) => {
      if (!port) {
        return { ok: false, kind: 'not_found', message: 'no initiatives saved yet' } as const;
      }
      const r = await decideInitiative(
        port,
        {
          target: input.target,
          gate: input.gate,
          verdict: input.verdict,
          reason: input.reason ?? null,
          option: input.gate === 'gate2_adopt' ? (input.option ?? null) : null,
        },
        { decidedBy: WEB_DECIDER, now: this.opts.now?.() ?? new Date() },
      );
      if (!r.ok) return r;
      const initiativeId = r.initiative?.id ?? r.exploration?.initiativeId;
      const owner = initiativeId ? port.store.getInitiative(initiativeId) : null;
      return {
        ok: true,
        ...(r.exploration
          ? { exploration: { id: r.exploration.id, state: r.exploration.state } }
          : {}),
        ...(r.initiative && !r.makeMine
          ? { initiative: { id: r.initiative.id, state: r.initiative.state } }
          : {}),
        // Make it mine writes no config here: the owner confirms the rewrite in chat.
        ...(r.makeMine && owner
          ? {
              chatLink: `/p/${encodeURIComponent(owner.personalityId)}/chat?draft=${encodeURIComponent(`make ${owner.id} mine`)}`,
            }
          : {}),
      };
    });
  }

  // -- settings.yaml -----------------------------------------------------------

  async settings(personalityId: string): Promise<Out<typeof InitiativesSettingsOutputSchema>> {
    assertSafePersonalityId(personalityId);
    const { storage, dataDir } = this.opts;
    const load = await loadInitiativeSettings(storage, dataDir, personalityId);
    const c = (await readInitiativeConstitution(storage, dataDir)).initiatives;
    return {
      settings: load.settings,
      status: load.status,
      ...(load.reason ? { reason: load.reason } : {}),
      ceilings: {
        ...(c?.maxUsdPerDayPerPersonality !== undefined
          ? { maxUsdPerDayPerPersonality: c.maxUsdPerDayPerPersonality }
          : {}),
        ...(c?.maxUsdPerDay !== undefined ? { maxUsdPerDay: c.maxUsdPerDay } : {}),
      },
      guidance: mapGuidance(load.settings.standingGuidance, {
        toolset: this.toolset(personalityId),
        level: 'personality',
      }),
    };
  }

  settingsSave(input: { personalityId: string; settings: InitiativeSettingsWire }) {
    return this.serial(async () => {
      assertSafePersonalityId(input.personalityId);
      // No directory is created for a personality that does not exist.
      if (this.opts.personalities.get(input.personalityId) === undefined) {
        throw new EthosError({
          code: 'FILE_NOT_FOUND',
          cause: `Personality "${input.personalityId}" does not exist.`,
          action: 'Pick an existing personality, then save again.',
        });
      }
      const { storage, dataDir } = this.opts;
      const valid = validateInitiativeSettings(input.settings);
      if (!valid.ok) throw invalid(valid.error);
      const ceilings = (await readInitiativeConstitution(storage, dataDir)).initiatives;
      const { settings, clamps } = clampInitiativeSettings(valid.settings, ceilings);
      const before = await loadInitiativeSettings(storage, dataDir, input.personalityId);
      const path = initiativeSettingsPath(dataDir, input.personalityId);
      await storage.mkdir(join(path, '..'));
      await storage.writeAtomic(path, renderInitiativeSettings(settings));
      if (before.status === 'invalid' || before.settings.enabled !== settings.enabled) {
        await this.reload(input.personalityId);
      }
      return { ok: true as const, saved: settings, clamps };
    });
  }

  // -- constitution `initiatives` block -----------------------------------------

  async constitution(): Promise<{ initiatives: ConstitutionInitiatives }> {
    const c = await readInitiativeConstitution(this.opts.storage, this.opts.dataDir);
    return { initiatives: c.initiatives ?? {} };
  }

  constitutionSave(input: { initiatives: ConstitutionInitiativesSaveBlock }) {
    return this.serial(async () => {
      const { storage, dataDir } = this.opts;
      // The wire body says "no ceiling" with null; the stored block says it by omission.
      const { maxUsdPerDay, maxUsdPerDayPerPersonality, ...rest } = input.initiatives;
      const block: ConstitutionInitiatives = {
        ...rest,
        ...(maxUsdPerDay !== null ? { maxUsdPerDay } : {}),
        ...(maxUsdPerDayPerPersonality !== null ? { maxUsdPerDayPerPersonality } : {}),
      };
      const valid = validateConstitutionInitiatives(block, dataDir);
      if (!valid.ok) throw invalid(valid.error);
      const path = join(dataDir, 'constitution.yaml');
      const next = renderConstitutionWithInitiatives(await storage.read(path), valid.block);
      if (!next.ok) throw invalid(next.error);
      await storage.writeAtomic(path, next.text);
      await this.reload();
      return {
        ok: true as const,
        appliesOn: 'next window for limits; restart for the rest of the constitution',
      };
    });
  }

  /** The cache behind `buildPersonalityToolExclude`; the 5-minute tick would catch up anyway. */
  private async reload(personalityId?: string): Promise<void> {
    try {
      await this.opts.enablement?.()?.reload(personalityId);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}

/** `assertSafeId` throws a plain `IdValidationError`, which oRPC answers as 500. A bad id is the caller's input: 400. */
function assertSafePersonalityId(id: string): void {
  try {
    assertSafeId(id, 'personality');
  } catch (err) {
    if (!(err instanceof IdValidationError)) throw err;
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: err.message,
      action: 'Use a personality id of lowercase letters, digits, "-" and "_".',
    });
  }
}

const invalid = (cause: string) =>
  new EthosError({
    code: 'INVALID_INPUT',
    cause,
    action: 'Fix the field named above, then save again.',
  });
