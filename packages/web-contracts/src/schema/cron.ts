import { z } from 'zod';

// ---------------------------------------------------------------------------
// Cron — proactive pillar of v0.5
//
// Mirrors the `CronJob` shape from `@ethosagent/cron`. Wire-side uses
// nullable instead of optional for fields that may legitimately be unset
// on disk, so the client doesn't have to guess between "missing" and
// "explicitly null".
// ---------------------------------------------------------------------------

export const JobStatusSchema = z.enum(['active', 'paused', 'done']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const MissedRunPolicySchema = z.enum(['run-once', 'skip']);
export type MissedRunPolicy = z.infer<typeof MissedRunPolicySchema>;

export const CronJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 5-field cron expression e.g. `0 8 * * 1-5`. */
  schedule: z.string(),
  prompt: z.string(),
  personalityId: z.string(),
  /** Delivery target — derived from origin platform. Null means "store output to disk only". */
  deliver: z.string().nullable(),
  status: JobStatusSchema,
  missedRunPolicy: MissedRunPolicySchema,
  source: z.enum(['system', 'user']).default('user'),
  systemTask: z.string().nullable().optional(),
  /** ISO-8601 of last run, or null if never run. */
  lastRunAt: z.string().nullable(),
  /** ISO-8601 of next scheduled run, or null when paused / unscheduled. */
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
  /** `HH:MM-HH:MM` window scheduled runs are limited to (`CronJob.activeHours`
   *  in @ethosagent/cron), or null when always active. */
  activeHours: z.string().nullable().optional(),
});
export type CronJob = z.infer<typeof CronJobSchema>;

export const CronRunSchema = z.object({
  /** ISO-8601 timestamp parsed from the output filename. */
  ranAt: z.string(),
  /** Server-side absolute path to the output file. The client treats it
   *  as opaque and uses it to fetch full output via cron.history. */
  outputPath: z.string(),
  /** Full output body — present when the run is the head of `cron.history`
   *  and inline-fetched. Listed runs leave it absent for compactness. */
  output: z.string().nullable(),
});
export type CronRun = z.infer<typeof CronRunSchema>;

// Where a cron job's output goes, chosen at create time
// (plan/phases/recipes-gallery.md §1). `none` is today's default (output is
// written to the run-history file and nobody is pinged), `inApp` is the
// in-app heartbeat the deprecated `notifyInApp` boolean expresses, and
// `channel` is the new arm: deliver into a real chat on a real bot.
//
// `botKey` is an AUTHORIZATION input, not a delivery address — the server uses
// it to check that the bot speaks for the job's personality, then discards it.
// `JobOrigin` stays `{ platform, chatId }` (D9).
export const CronDeliverToSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('inApp') }),
  z.object({
    kind: z.literal('channel'),
    platform: z.string().min(1),
    botKey: z.string().min(1),
    chatId: z.string().min(1),
  }),
]);
export type CronDeliverTo = z.infer<typeof CronDeliverToSchema>;

/** How a chat became an offerable delivery target. */
export const CronDeliveryTargetSourceSchema = z.enum([
  /** `channel_filter.<platform>.ownerUserId` — the operator's declared owner. */
  'owner',
  /** An entry in `channel_filter.<platform>.recipientAllowlist`. */
  'allowlist',
  /** A pairing-approved sender from the gateway's pairing DB. */
  'paired',
  /** A chat this bot has actually been talked to in (a gateway lane key). */
  'observed',
]);
export type CronDeliveryTargetSource = z.infer<typeof CronDeliveryTargetSourceSchema>;

export const CronDeliveryTargetSchema = z.object({
  platform: z.string(),
  botKey: z.string(),
  /** `@briefer_bot` where the platform knows one; the botKey otherwise. */
  botLabel: z.string(),
  chatId: z.string(),
  /** Human-readable, best-effort — never the only thing the picker shows. */
  label: z.string(),
  source: CronDeliveryTargetSourceSchema,
});
export type CronDeliveryTarget = z.infer<typeof CronDeliveryTargetSchema>;
