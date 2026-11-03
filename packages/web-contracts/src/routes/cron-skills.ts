import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  CronDeliverToSchema,
  CronDeliveryTargetSchema,
  CronJobSchema,
  CronRunSchema,
  EvolveConfigSchema,
  EvolverRunSchema,
  MissedRunPolicySchema,
  PendingSkillSchema,
  SkillSchema,
} from '../schemas';

// ---------------------------------------------------------------------------
// Debug — sidecar assistant that inspects session events, spans, and logs
// ---------------------------------------------------------------------------

const DebugChatInput = z.object({
  mainSessionId: z.string(),
  message: z.string().min(1),
  clientId: z.string().optional(),
});
const DebugChatOutput = z.object({
  sessionId: z.string(),
  turnId: z.string(),
  response: z.string(),
});

export const debug = {
  chat: oc.input(DebugChatInput).output(DebugChatOutput),
};

// ---------------------------------------------------------------------------
// Cron (v0.5 — the proactive pillar)
//
// Web tab manages jobs.json on disk and reads run-output files from
// `<dataDir>/cron/output/<jobId>/<timestamp>.md`. The actual ticker
// lives in `serve.ts`.
// ---------------------------------------------------------------------------

const CronListOutput = z.object({ jobs: z.array(CronJobSchema) });

const CronGetInput = z.object({ id: z.string().min(1) });
const CronGetOutput = z.object({ job: CronJobSchema });

const CronCreateInput = z.object({
  name: z.string().min(1),
  schedule: z.string().min(1),
  prompt: z.string().min(1),
  personalityId: z.string().min(1),
  missedRunPolicy: MissedRunPolicySchema.optional(),
  // When true, the job is given a `web` origin so its output delivers into a
  // web chat session and surfaces in the Activity feed (in-app heartbeat).
  //
  // @deprecated Alias for `deliverTo: { kind: 'inApp' }` (true) / `{ kind:
  // 'none' }` (false). Kept on the wire because the Cron page already sends
  // it; breaking it to save a field is not a trade worth making. Sending BOTH
  // this and a `deliverTo` that disagrees is a validation error, never a
  // silent precedence rule.
  notifyInApp: z.boolean().optional(),
  /** Where run output goes. See `CronDeliverToSchema`. */
  deliverTo: CronDeliverToSchema.optional(),
  /** `HH:MM-HH:MM`; refused as CRON_INVALID by `CronScheduler.createJob` when
   *  malformed or on a one-shot schedule. */
  activeHours: z.string().optional(),
});
const CronCreateOutput = z.object({ job: CronJobSchema });

const CronIdOnlyInput = z.object({ id: z.string().min(1) });
const CronOkOutput = z.object({ ok: z.literal(true) });

const CronRunNowInput = z.object({ id: z.string().min(1) });
const CronRunNowOutput = z.object({
  ok: z.literal(true),
  /** Full output body from this synchronous run. */
  output: z.string(),
  ranAt: z.string(),
});

const CronUpdateInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  schedule: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  personalityId: z.string().min(1).optional(),
  /** `HH:MM-HH:MM` sets the window; `null` clears it (`CronScheduler.updateJob`). */
  activeHours: z.string().nullable().optional(),
});
const CronUpdateOutput = z.object({ job: CronJobSchema });

const CronHistoryInput = z.object({
  id: z.string().min(1),
  /** Page size; max 100 to keep payloads bounded. Default 20. */
  limit: z.number().int().min(1).max(100).optional(),
});
const CronHistoryOutput = z.object({ runs: z.array(CronRunSchema) });

// Read-only. The set of chats this personality's own bots may be pointed at.
// The picker on the Cron page renders exactly this — a `deliverTo` chatId is
// NEVER free text, and the set is recomputed server-side at create time rather
// than trusted from whatever the client previewed.
const CronDeliveryTargetsInput = z.object({ personalityId: z.string().min(1) });
const CronDeliveryTargetsOutput = z.object({
  targets: z.array(CronDeliveryTargetSchema),
});

/** @experimental */
export const cron = {
  list: oc.output(CronListOutput),
  get: oc.input(CronGetInput).output(CronGetOutput),
  create: oc.input(CronCreateInput).output(CronCreateOutput),
  update: oc.input(CronUpdateInput).output(CronUpdateOutput),
  delete: oc.input(CronIdOnlyInput).output(CronOkOutput),
  pause: oc.input(CronIdOnlyInput).output(CronOkOutput),
  resume: oc.input(CronIdOnlyInput).output(CronOkOutput),
  runNow: oc.input(CronRunNowInput).output(CronRunNowOutput),
  history: oc.input(CronHistoryInput).output(CronHistoryOutput),
  deliveryTargets: oc.input(CronDeliveryTargetsInput).output(CronDeliveryTargetsOutput),
};

// ---------------------------------------------------------------------------
// Skills (v0.5 — the learning pillar)
//
// Library panel CRUD over `~/.ethos/skills/*.md`. Per-personality skill
// directories arrive in v1 as part of the Personalities tab — for now the
// surface is the global library only.
// ---------------------------------------------------------------------------

const SkillListOutput = z.object({
  skills: z.array(SkillSchema),
  /** Approval queue size — surfaced as a sidebar badge so the user can
   *  see pending candidates without opening the Evolver panel. */
  pendingCount: z.number().int().nonnegative(),
});

const SkillGetInput = z.object({ id: z.string().min(1) });
const SkillGetOutput = z.object({ skill: SkillSchema });

const SkillCreateInput = z.object({
  /** Plain filename (no path, no `.md`). Letters, digits, dash, underscore. */
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/),
  /** Markdown body. May start with a YAML frontmatter block. */
  body: z.string(),
});
const SkillCreateOutput = z.object({ skill: SkillSchema });

const SkillUpdateInput = z.object({
  id: z.string().min(1),
  body: z.string(),
});
const SkillUpdateOutput = z.object({ skill: SkillSchema });

const SkillDeleteInput = z.object({ id: z.string().min(1) });
const SkillOkOutput = z.object({ ok: z.literal(true) });

/** @experimental */
export const skills = {
  list: oc.input(z.object({ includeUnavailable: z.boolean().optional() })).output(SkillListOutput),
  get: oc.input(SkillGetInput).output(SkillGetOutput),
  create: oc.input(SkillCreateInput).output(SkillCreateOutput),
  update: oc.input(SkillUpdateInput).output(SkillUpdateOutput),
  delete: oc.input(SkillDeleteInput).output(SkillOkOutput),
};

// ---------------------------------------------------------------------------
// Evolver (v0.5 — companion to Skills)
//
// Three operations: configure thresholds, manage the pending approval
// queue produced by `SkillEvolver.evolve()`, and read the run history log.
// The actual evolve loop runs out-of-band (CLI / cron); this namespace
// only exposes its inputs and outputs to the web tab.
// ---------------------------------------------------------------------------

const EvolverConfigGetOutput = z.object({ config: EvolveConfigSchema });
const EvolverConfigUpdateInput = EvolveConfigSchema;
const EvolverConfigUpdateOutput = z.object({ config: EvolveConfigSchema });

const EvolverPendingListOutput = z.object({ pending: z.array(PendingSkillSchema) });
const EvolverPendingActionInput = z.object({ id: z.string().min(1) });
const EvolverHistoryInput = z.object({ limit: z.number().int().min(1).max(100).optional() });
const EvolverHistoryOutput = z.object({ runs: z.array(EvolverRunSchema) });

/** @experimental */
export const evolver = {
  configGet: oc.output(EvolverConfigGetOutput),
  configUpdate: oc.input(EvolverConfigUpdateInput).output(EvolverConfigUpdateOutput),
  pendingList: oc.output(EvolverPendingListOutput),
  pendingApprove: oc.input(EvolverPendingActionInput).output(SkillOkOutput),
  pendingReject: oc.input(EvolverPendingActionInput).output(SkillOkOutput),
  history: oc.input(EvolverHistoryInput).output(EvolverHistoryOutput),
};
