import { join } from 'node:path';
import { parseSchedule } from '@ethosagent/cron';
import type { Constitution, Storage } from '@ethosagent/types';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * L8: strict schemas for an initiative file (`initiatives/<id>.yaml`, snake_case)
 * and `initiatives/settings.yaml` (camelCase). `.strict()` at every level, so a
 * key such as `allowWrites`, `execute` or `tools` fails instead of looking like a
 * granted capability. Read-only is not a field here and cannot be configured.
 * Pinned by `__tests__/initiative-config.test.ts` ('unknown key fails').
 */

const TARGETLESS_SOURCES = ['sessions', 'kanban', 'memory', 'web', 'slack_read'] as const;

/** Ordered strictest first: `ask` always asks, `free_under` asks above a threshold, `free` never asks. */
export const AUTONOMY_MODES = ['ask', 'free_under', 'free'] as const;

/**
 * One source entry: a bare kind for kinds with no target, or `{ repo: '<path>' }`.
 * A repo path is checked against `readableRoots` by `checkSources` on save and load.
 */
export const SourceEntrySchema = z.union([
  z.enum(TARGETLESS_SOURCES),
  z.object({ repo: z.string().min(1) }).strict(),
]);
export type SourceEntry = z.infer<typeof SourceEntrySchema>;
const usd = z.number().finite().nonnegative();

const ExploreWindow = z.string().refine((s) => parseSchedule(s) !== null, {
  message: 'not a valid schedule (cron, "every 2h", relative delay or ISO timestamp)',
});

const GuidanceEntry = z
  .object({
    text: z.string().min(1),
    maps_to: z.array(z.string()).optional(),
    status: z.enum(['mapped', 'unreachable', 'refused']).optional(),
  })
  .strict();

export const InitiativeFileSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    origin: z.enum(['human', 'agent']),
    created_in: z.string().min(1),
    state: z.enum(['active', 'self_started', 'paused', 'review', 'ended', 'stopped']),
    title: z.string().min(1),
    outcome: z.string().min(1),
    sources: z.array(SourceEntrySchema),
    exclude: z.array(z.string()).default([]),
    guidance: z.array(GuidanceEntry).default([]),
    autonomy: z.object({ mode: z.enum(AUTONOMY_MODES), ask_above_usd: usd.optional() }).strict(),
    budget: z
      .object({
        usd_per_day: usd,
        usd_per_exploration: usd,
        max_open_explorations: z.number().int().nonnegative(),
      })
      .strict(),
    timeline: z
      .object({
        explore_windows: z.array(ExploreWindow),
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
  .strict()
  .superRefine((doc, ctx) => {
    if (doc.origin === 'agent') return;
    for (const key of ['parent_id', 'notes'] as const) {
      if (doc[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is for agent-origin initiatives only`,
        });
      }
    }
  });

export type InitiativeFile = z.infer<typeof InitiativeFileSchema>;

export const InitiativeSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    selfStart: z.boolean().default(false),
    dailyBudgetUsd: usd.default(0),
    defaultAutonomy: z
      .object({ mode: z.enum(AUTONOMY_MODES), askAboveUsd: usd.optional() })
      .strict()
      .optional(),
    delivery: z
      .object({ ownerChannel: z.string().min(1), digestTime: z.string().min(1) })
      .strict()
      .optional(),
    standingGuidance: z.array(z.string()).default([]),
  })
  .strict();

export type InitiativeSettings = z.infer<typeof InitiativeSettingsSchema>;

/** One key list per schema; the web tests import these so a new key needs a control or row. */
export const INITIATIVE_FILE_KEYS = Object.keys(InitiativeFileSchema.shape) as readonly string[];
export const INITIATIVE_SETTINGS_KEYS = Object.keys(
  InitiativeSettingsSchema.shape,
) as readonly string[];

export type InitiativeSettingsLoad =
  | { status: 'missing' | 'loaded'; settings: InitiativeSettings; reason?: undefined }
  | { status: 'invalid'; settings: InitiativeSettings; reason: string };

function describeIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/**
 * Load `<dataDir>/personalities/<id>/initiatives/settings.yaml` through Storage.
 * Missing file = defaults (on, selfStart off, $0). An unreadable or invalid file
 * returns `enabled: false` settings plus a reason, which pauses the engine for
 * that personality only (enforced by `effectiveEnabled`).
 */
export async function loadInitiativeSettings(
  storage: Storage,
  dataDir: string,
  personalityId: string,
): Promise<InitiativeSettingsLoad> {
  const path = join(dataDir, 'personalities', personalityId, 'initiatives', 'settings.yaml');
  const defaults = InitiativeSettingsSchema.parse({});
  const paused = (reason: string): InitiativeSettingsLoad => ({
    status: 'invalid',
    settings: { ...defaults, enabled: false },
    reason: `${path}: ${reason}`,
  });
  let raw: string | null;
  try {
    raw = await storage.read(path);
  } catch (err) {
    return paused(err instanceof Error ? err.message : String(err));
  }
  if (raw === null) return { status: 'missing', settings: defaults };
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    return paused(err instanceof Error ? err.message : String(err));
  }
  const r = InitiativeSettingsSchema.safeParse(doc ?? {});
  if (!r.success) return paused(describeIssues(r.error));
  return { status: 'loaded', settings: r.data };
}

/** The operator kill switch (`constitution.initiatives.enabled: false`) overrides the personality. */
export function effectiveEnabled(
  settings: InitiativeSettings,
  constitution: Constitution,
): boolean {
  return constitution.initiatives?.enabled !== false && settings.enabled;
}
