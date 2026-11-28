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

/** Recurring only: a one-shot ("in 5m", ISO timestamp) never repeats, so it cannot be a window. */
const ExploreWindow = z.string().refine(
  (s) => {
    const kind = parseSchedule(s)?.kind;
    return kind === 'cron' || kind === 'interval';
  },
  { message: 'not a recurring schedule (use a cron expression or "every 2h")' },
);

/**
 * `<platform>:<chatId>`, the shape `parseOwnerChannel` accepts
 * (packages/wiring/src/initiative-runtime.ts). A bare platform names no chat.
 */
const OwnerChannel = z.string().refine(
  (s) => {
    const at = s.indexOf(':');
    return at > 0 && at < s.length - 1;
  },
  { message: 'must be <platform>:<chatId>, e.g. telegram:12345' },
);

/** `HH:MM` in the owner's zone (`notifications.timezone`), the shape `digestMinutes` accepts (packages/wiring/src/initiative-runtime.ts). */
const DigestTime = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, { message: 'must be HH:MM (24-hour)' });

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

/** Parse and validate one initiative file's text; the reason is shown to the owner. */
export function parseInitiativeFile(
  raw: string,
): { ok: true; file: InitiativeFile } | { ok: false; error: string } {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const r = InitiativeFileSchema.safeParse(doc);
  return r.success
    ? { ok: true, file: r.data }
    : {
        ok: false,
        error: r.error.issues
          .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      };
}

export const InitiativeSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    selfStart: z.boolean().default(false),
    dailyBudgetUsd: usd.default(0),
    defaultAutonomy: z
      .object({ mode: z.enum(AUTONOMY_MODES), askAboveUsd: usd.optional() })
      .strict()
      .optional(),
    delivery: z.object({ ownerChannel: OwnerChannel, digestTime: DigestTime }).strict().optional(),
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
