import { z } from 'zod';

// ---------------------------------------------------------------------------
// Initiative engine wire contracts (plan/phases/initiative-engine.md, Task 6.1).
//
// web-contracts must not import extensions/initiative-runner, so the domain
// schemas are redefined here in Zod and `.strict()` at every level: an unknown
// key such as `allowWrites` is a 400 INPUT_INVALID, never a granted capability.
// Sources of truth these mirror:
//   settings.yaml  -> extensions/initiative-runner/src/config-schema.ts InitiativeSettingsSchema (camelCase)
//   initiative file -> same file, InitiativeFileSchema (snake_case)
//   constitution   -> packages/types/src/constitution.ts `initiatives` + CONSTITUTION_INITIATIVES_KEYS
// Drift is pinned by __tests__/initiatives-schema.test.ts (key lists).
// ---------------------------------------------------------------------------

const usd = z.number().finite().nonnegative();

export const InitiativeAutonomyModeSchema = z.enum(['ask', 'free_under', 'free']);
export const InitiativeOriginSchema = z.enum(['human', 'agent']);
export const InitiativeStateSchema = z.enum([
  'active',
  'self_started',
  'paused',
  'review',
  'ended',
  'stopped',
]);
export const ExplorationStateSchema = z.enum([
  'idea',
  'proposed',
  'exploring',
  'rejected',
  'stalled',
  'briefed',
  'adopted',
  'parked',
]);
export const GuidanceStatusSchema = z.enum(['mapped', 'unreachable', 'refused']);

// -- Personality settings (personalities/<id>/initiatives/settings.yaml) -----

/** `<platform>:<chatId>`; mirrors config-schema.ts `OwnerChannel` and the runtime's `parseOwnerChannel`. */
const OwnerChannelSchema = z.string().refine(
  (s) => {
    const at = s.indexOf(':');
    return at > 0 && at < s.length - 1;
  },
  { message: 'must be <platform>:<chatId>, e.g. telegram:12345' },
);
/** `HH:MM` in the owner's notifications timezone; mirrors config-schema.ts `DigestTime`. */
const DigestTimeSchema = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, { message: 'must be HH:MM (24-hour)' });

/** The full strict settings object. Save bodies carry all of it, not a subset. */
export const InitiativeSettingsWireSchema = z
  .object({
    enabled: z.boolean(),
    selfStart: z.boolean(),
    dailyBudgetUsd: usd,
    defaultAutonomy: z
      .object({ mode: InitiativeAutonomyModeSchema, askAboveUsd: usd.optional() })
      .strict()
      .optional(),
    delivery: z
      .object({ ownerChannel: OwnerChannelSchema, digestTime: DigestTimeSchema })
      .strict()
      .optional(),
    standingGuidance: z.array(z.string()),
  })
  .strict();
export type InitiativeSettingsWire = z.infer<typeof InitiativeSettingsWireSchema>;

/** One guidance line with its `mapGuidance` result. */
export const GuidanceMappingSchema = z.object({
  text: z.string(),
  status: GuidanceStatusSchema,
  mapsTo: z.array(z.string()),
});
export type GuidanceMapping = z.infer<typeof GuidanceMappingSchema>;

export const InitiativesSettingsInputSchema = z.object({ personalityId: z.string().min(1) });
export const InitiativesSettingsOutputSchema = z.object({
  settings: InitiativeSettingsWireSchema,
  /** `missing` renders defaults; `invalid` means the engine is paused for this personality. */
  status: z.enum(['missing', 'loaded', 'invalid']),
  reason: z.string().optional(),
  /** Operator ceilings from the constitution, shown read-only under the budget control. */
  ceilings: z.object({
    maxUsdPerDayPerPersonality: usd.optional(),
    maxUsdPerDay: usd.optional(),
  }),
  guidance: z.array(GuidanceMappingSchema),
});
export const InitiativesSettingsSaveInputSchema = z
  .object({ personalityId: z.string().min(1), settings: InitiativeSettingsWireSchema })
  .strict();
export const InitiativesSettingsSaveOutputSchema = z.object({
  ok: z.literal(true),
  saved: InitiativeSettingsWireSchema,
  /** Human-readable ceiling clamps applied on save, e.g. "dailyBudgetUsd 5 → 4 (operator ceiling)". */
  clamps: z.array(z.string()),
});

// -- Constitution `initiatives` block ----------------------------------------

/**
 * `readableRoots` refuses `~/.ssh`, its children, the absolute `$HOME/.ssh` form (any `.ssh`
 * segment once `.`/`..` are resolved, case-folded) and the ancestors of `~/.ssh` (`~`, `/`,
 * `/Users`, `/home`), matching the server. This is a schema convenience; the real enforcers are
 * `checkSources` (extensions/initiative-runner/src/sources.ts) and the readableRoots check in
 * `validateConstitutionInitiatives`, called by `constitutionSave` in
 * apps/web-api/src/services/initiatives.service.ts.
 */
const SSH_ANCESTORS = new Set(['~', '/', '/users', '/home']);
function hasSshSegment(root: string): boolean {
  const out: string[] = [];
  for (const seg of root.trim().replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg.toLowerCase());
  }
  if (out.includes('.ssh')) return true;
  const resolved = `${root.trim().startsWith('/') ? '/' : ''}${out.join('/')}`;
  return out.length === 0 || SSH_ANCESTORS.has(resolved);
}

const ReadableRootSchema = z
  .string()
  .min(1)
  .refine((root) => !hasSshSegment(root), { message: 'readableRoots refuses ~/.ssh' });

export const ConstitutionInitiativesSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxUsdPerDay: usd.optional(),
    maxUsdPerDayPerPersonality: usd.optional(),
    selfStartPoolUsdPerDay: usd.optional(),
    maxSelfStarted: z.number().int().nonnegative().optional(),
    readableRoots: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ConstitutionInitiatives = z.infer<typeof ConstitutionInitiativesSchema>;

export const ConstitutionInitiativesOutputSchema = z.object({
  initiatives: ConstitutionInitiativesSchema,
});
/**
 * Save body: every key but `readableRoots` is required, so a partial body cannot silently drop an
 * operator ceiling. The two USD ceilings are `null` to mean "no ceiling"; the service removes
 * nulls before validating (InitiativesService.constitutionSave).
 */
export const ConstitutionInitiativesSaveBlockSchema = z
  .object({
    enabled: z.boolean(),
    maxUsdPerDay: usd.nullable(),
    maxUsdPerDayPerPersonality: usd.nullable(),
    selfStartPoolUsdPerDay: usd,
    maxSelfStarted: z.number().int().nonnegative(),
    readableRoots: z.array(ReadableRootSchema).optional(),
  })
  .strict();
export type ConstitutionInitiativesSaveBlock = z.infer<
  typeof ConstitutionInitiativesSaveBlockSchema
>;
export const ConstitutionInitiativesSaveInputSchema = z
  .object({ initiatives: ConstitutionInitiativesSaveBlockSchema })
  .strict();
export const ConstitutionInitiativesSaveOutputSchema = z.object({
  ok: z.literal(true),
  appliesOn: z.string(),
});

// -- Initiative file (initiatives/<id>.yaml, snake_case) ---------------------

const SourceEntryWireSchema = z.union([
  z.enum(['sessions', 'kanban', 'memory', 'web', 'slack_read']),
  z.object({ repo: z.string().min(1) }).strict(),
]);

export const InitiativeFileWireSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    origin: InitiativeOriginSchema,
    created_in: z.string().min(1),
    state: InitiativeStateSchema,
    title: z.string().min(1),
    outcome: z.string().min(1),
    sources: z.array(SourceEntryWireSchema),
    exclude: z.array(z.string()),
    guidance: z.array(
      z
        .object({
          text: z.string().min(1),
          maps_to: z.array(z.string()).optional(),
          status: GuidanceStatusSchema.optional(),
        })
        .strict(),
    ),
    autonomy: z
      .object({ mode: InitiativeAutonomyModeSchema, ask_above_usd: usd.optional() })
      .strict(),
    budget: z
      .object({
        usd_per_day: usd,
        usd_per_exploration: usd,
        max_open_explorations: z.number().int().nonnegative(),
      })
      .strict(),
    timeline: z
      .object({
        explore_windows: z.array(z.string()),
        window_minutes: z.number().int().positive(),
        default_days: z.number().int().positive(),
        review_on: z.string().min(1),
        ends_on: z.string().min(1).optional(),
      })
      .strict(),
    delivery: z
      .object({ owner_channel: z.string().min(1), digest_time: z.string().min(1) })
      .strict(),
    parent_id: z.string().min(1).optional(),
    notes: z.array(z.string()).optional(),
  })
  .strict();
export type InitiativeFileWire = z.infer<typeof InitiativeFileWireSchema>;

// -- Flattened dotted key lists (web tests import these) ---------------------

/** Dotted leaf keys of a (nested) strict object; arrays and scalars are leaves. */
export function flattenObjectKeys(schema: z.ZodObject, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, child] of Object.entries(schema.shape)) {
    let inner: unknown = child;
    while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) {
      inner = inner instanceof z.ZodOptional ? inner.unwrap() : inner.removeDefault();
    }
    if (inner instanceof z.ZodObject) keys.push(...flattenObjectKeys(inner, `${prefix}${key}.`));
    else keys.push(`${prefix}${key}`);
  }
  return keys;
}

/** One key per Personality control (`initiatives-tab.test.ts`). */
export const INITIATIVE_SETTINGS_FIELD_KEYS: readonly string[] = flattenObjectKeys(
  InitiativeSettingsWireSchema,
);
/** One key per Settings → Automation → Initiatives control. */
export const CONSTITUTION_INITIATIVES_FIELD_KEYS: readonly string[] = flattenObjectKeys(
  ConstitutionInitiativesSchema,
);
/** One key per labeled row on the Initiatives page detail (`initiatives-page.test.ts`). */
export const INITIATIVE_FILE_FIELD_KEYS: readonly string[] =
  flattenObjectKeys(InitiativeFileWireSchema);

// -- Initiatives page reads --------------------------------------------------

export const InitiativeListInputSchema = z.object({
  personalityId: z.string().optional(),
  origin: InitiativeOriginSchema.optional(),
  state: InitiativeStateSchema.optional(),
});
export const InitiativeSummarySchema = z.object({
  id: z.string(),
  personalityId: z.string(),
  origin: InitiativeOriginSchema,
  state: InitiativeStateSchema,
  /** Null when the file is invalid and could not be read. */
  title: z.string().nullable(),
  version: z.number().int(),
  spendTodayUsd: z.number(),
  openExplorations: z.number().int().nonnegative(),
  /** Why the file failed to load; set only for an invalid file. */
  invalidReason: z.string().optional(),
});
export const InitiativeListOutputSchema = z.object({ items: z.array(InitiativeSummarySchema) });

export const InitiativeGetInputSchema = z.object({ id: z.string().min(1) });
export const InitiativeExplorationViewSchema = z.object({
  id: z.string(),
  question: z.string(),
  state: ExplorationStateSchema,
  budgetUsd: z.number(),
  spentUsd: z.number(),
  deadline: z.string(),
  /** Gate 2 inputs, present once the exploration is briefed. */
  briefMd: z.string().optional(),
  recommendedOption: z.string().nullable().optional(),
});
export const InitiativeGetOutputSchema = z.object({
  personalityId: z.string(),
  initiative: InitiativeFileWireSchema,
  /** One mapping per `guidance[]` line, same order. */
  guidance: z.array(GuidanceMappingSchema),
  /** Raw YAML for the read-only "Show file". */
  yaml: z.string(),
  versions: z.array(z.object({ version: z.number().int(), savedAt: z.string().optional() })),
  explorations: z.array(InitiativeExplorationViewSchema),
});

export const InitiativeActivityInputSchema = z.object({
  initiativeId: z.string().min(1),
  limit: z.number().int().positive().max(200).optional(),
});
export const InitiativeWindowViewSchema = z.object({
  id: z.string(),
  explorationId: z.string().nullable(),
  kind: z.enum(['survey', 'scan', 'window', 'brief']),
  started: z.string(),
  ended: z.string().nullable(),
  tools: z.array(z.string()),
  reads: z.array(z.string()),
  findings: z.number().int().nonnegative(),
  costUsd: z.number(),
  endReason: z.string().nullable(),
});
export const InitiativeActivityOutputSchema = z.object({
  windows: z.array(InitiativeWindowViewSchema),
});

export const ExploringNowInputSchema = z.object({ personalityId: z.string().optional() });
export const ExploringNowOutputSchema = z.object({
  /** Null when nothing is running. `readOnly` is a literal: a window cannot write. */
  current: z
    .object({
      windowId: z.string(),
      initiativeId: z.string(),
      initiativeTitle: z.string(),
      explorationId: z.string().nullable(),
      question: z.string().nullable(),
      started: z.string(),
      costSoFarUsd: z.number(),
      readOnly: z.literal(true),
    })
    .nullable(),
});

export const InitiativeMetricsInputSchema = z.object({
  personalityId: z.string().min(1),
  /** Window length in days; the service picks a default when absent. */
  sinceDays: z.number().int().positive().max(365).optional(),
});
/** Mirrors `GateMetrics` in extensions/initiative-store/src/metrics.ts. */
export const InitiativeMetricsOutputSchema = z.object({
  since: z.string(),
  gate1: z.object({ asked: z.number(), approved: z.number(), rate: z.number() }),
  gate2: z.object({ briefs: z.number(), adopted: z.number(), rate: z.number() }),
  selfStart: z.object({ started: z.number(), kept: z.number(), stopped: z.number() }),
});

// -- decide: Gate 1, Gate 2, and Keep / Make it mine / Stop ------------------

const DecideBase = { target: z.string().min(1), reason: z.string().optional() };
export const InitiativeDecideInputSchema = z.discriminatedUnion('gate', [
  z
    .object({
      ...DecideBase,
      gate: z.literal('gate1_explore'),
      verdict: z.enum(['approve', 'reject', 'snooze']),
    })
    .strict(),
  z
    .object({
      ...DecideBase,
      gate: z.literal('gate2_adopt'),
      verdict: z.enum(['adopt', 'dig_deeper', 'park']),
      /** The brief option adopted, e.g. "B". */
      option: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...DecideBase,
      gate: z.literal('self_start'),
      verdict: z.enum(['keep', 'make_mine', 'stop']),
    })
    .strict(),
]);
export type InitiativeDecideInput = z.infer<typeof InitiativeDecideInputSchema>;
export const InitiativeDecideOutputSchema = z.object({
  ok: z.literal(true),
  exploration: z.object({ id: z.string(), state: ExplorationStateSchema }).optional(),
  initiative: z.object({ id: z.string(), state: InitiativeStateSchema }).optional(),
  /** Make it mine: deep link that starts the setup in chat. */
  chatLink: z.string().optional(),
});
