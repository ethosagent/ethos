import { z } from 'zod';

// -- Settings sub-schemas (Settings page groups without another UI home) ----

/** Retention duration grammar (extensions/observability-sqlite `parseDuration`):
 *  `forever` or `<n>` + d(ays) | w(eeks) | m(onths) | y(ears), e.g. `90d`. */
export const RetentionDurationSchema = z.string().regex(/^(forever|\d+[dwmy])$/);

/** Flat retention subkeys — the `<subkey>` in `retention.<subkey>` and
 *  `personalities.<id>.retention.<subkey>` config.yaml keys. */
export const RetentionSubkeySchema = z.enum([
  'messages',
  'traces',
  'spans',
  'blobs',
  'archive',
  'channelTranscript',
  'events.error',
  'events.audit',
  'events.channel',
  'events.install',
]);

/** Record keys written as `<prefix>.<key>.<field>` config.yaml lines must
 *  round-trip through the line-based format — same identifier rule as bot ids. */
export const ConfigRecordKeySchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** One inbound webhook as returned by `config.get` (`webhooks.<hookId>.*`).
 *  The bearer secret NEVER round-trips — only a redacted preview. */
export const WebhookGetSchema = z.object({
  /** config.yaml: `webhooks.<hookId>.personalityId` */
  personalityId: z.string(),
  /** Redacted preview of `webhooks.<hookId>.secret` (e.g. "abc…wxyz"). */
  secretPreview: z.string(),
  /** config.yaml: `webhooks.<hookId>.sessionKey` */
  sessionKey: z.string().nullable(),
  /** config.yaml: `webhooks.<hookId>.prefilter` (script under ~/.ethos/scripts/) */
  prefilter: z.string().nullable(),
  /** config.yaml: `webhooks.<hookId>.prefilterTimeoutSeconds` (1-600) */
  prefilterTimeoutSeconds: z.number().nullable(),
  /** config.yaml: `webhooks.<hookId>.mode` — default 'sync'. */
  mode: z.enum(['sync', 'ack']),
});

/** One inbound webhook as accepted by `config.update`. `secret` is write-only:
 *  omit it to keep the stored secret (a brand-new hook gets a generated one). */
export const WebhookUpdateSchema = z
  .object({
    personalityId: z.string().min(1),
    /** Write-only bearer secret; never echoed back. Omit to keep/generate. */
    secret: z.string().min(8).optional(),
    sessionKey: z.string().optional(),
    prefilter: z.string().optional(),
    prefilterTimeoutSeconds: z.number().int().min(1).max(600).optional(),
    mode: z.enum(['sync', 'ack']).optional(),
  })
  .refine((h) => h.prefilterTimeoutSeconds === undefined || h.prefilter !== undefined, {
    message: "prefilterTimeoutSeconds requires 'prefilter'",
  });

/** One `/name` quick command (`quick_commands.<name>.*`). `exec` runs an
 *  operator-authored shell command; `reply` returns a canned string. */
export const QuickCommandGetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('exec'),
    command: z.string(),
    gateway: z.boolean(),
    channels: z.array(z.string()),
  }),
  z.object({
    type: z.literal('reply'),
    reply: z.string(),
    gateway: z.boolean(),
    channels: z.array(z.string()),
  }),
]);
export const QuickCommandUpdateSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('exec'),
    command: z.string().min(1),
    gateway: z.boolean().optional(),
    channels: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('reply'),
    reply: z.string().min(1),
    gateway: z.boolean().optional(),
    channels: z.array(z.string()).optional(),
  }),
]);

/** Auxiliary model wiring (`auxiliary.<slot>.*` where slot is compression /
 *  vision / web). API key never round-trips — preview only. */
export const AuxModelGetSchema = z.object({
  model: z.string().nullable(),
  provider: z.string().nullable(),
  apiKeyPreview: z.string().nullable(),
  baseUrl: z.string().nullable(),
});
/** Update shape for an auxiliary model slot. `null` clears the stored key. */
export const AuxModelUpdateSchema = z.object({
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  /** Write-only; never echoed back. Null deletes the stored key. */
  apiKey: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
});
/**
 * One model adopted into `modelRegistry.*` from a provider-chain entry that
 * declared it — by `config.update` (adopt on save) or `modelRegistry.importChain`.
 * Both run `planChainModelImport` (`@ethosagent/config`), the one importer.
 */
export const ModelRegistryAdoptedModelSchema = z.object({
  alias: z.string(),
  /** The provider entry id the alias references. */
  providerKey: z.string(),
  modelId: z.string(),
});
export type ModelRegistryAdoptedModel = z.infer<typeof ModelRegistryAdoptedModelSchema>;
