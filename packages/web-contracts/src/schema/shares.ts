import { z } from 'zod';

// ---------------------------------------------------------------------------
// Share links — read-only, expiring, redacted conversation snapshots
// (plan/phases/share-links.md §3, D2, D7, D12, D15).
//
// Server codes: none; refusals are DATA (`ok: false`), not errors, the way
// `platforms.setRoomPolicy` answers. The whole `shares` namespace is cookie-only
// (`SCOPE_MAP.shares` is all COOKIE_ONLY and `/rpc/shares/*` mounts
// `cookieOnlyGuard`): a bearer key must never mint or list a public link
// (apps/web-api/src/__tests__/middleware/apikeys-auth-bypass.test.ts).
//
// NO schema here carries a token or a stored snapshot body. The URL, which holds the
// token, is returned by `shares.create` once and never again; `shares.list` rows have
// no URL (apps/web-api/src/__tests__/services/share-service.test.ts 'list').
// ---------------------------------------------------------------------------

export const ShareExpirySchema = z.enum(['1h', '1d', '7d', '30d']);
export type ShareExpiry = z.infer<typeof ShareExpirySchema>;

export const ShareSnapshotToolSchema = z.object({ name: z.string(), isError: z.boolean() });
export const ShareSnapshotTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  tools: z.array(ShareSnapshotToolSchema).optional(),
});
/** The redacted copy a link would publish; `shares.preview` returns it byte for byte (D15). */
export const ShareSnapshotWireSchema = z.object({
  v: z.literal(1),
  title: z.string(),
  personalityId: z.string().nullable(),
  createdAt: z.string(),
  turns: z.array(ShareSnapshotTurnSchema),
});
export type ShareSnapshotWire = z.infer<typeof ShareSnapshotWireSchema>;

/**
 * Why a preview or create did not happen. `disabled`: `shareLinks.enabled` is off.
 * `shared_session`: a shared-room or incognito session. `excluded_personality` names the
 * id. `too_large` names the byte limit. `empty`: no user or assistant turn survives.
 */
export const ShareRefusalSchema = z.discriminatedUnion('reason', [
  z.object({ ok: z.literal(false), reason: z.literal('disabled') }),
  z.object({ ok: z.literal(false), reason: z.literal('not_found') }),
  z.object({ ok: z.literal(false), reason: z.literal('shared_session') }),
  z.object({
    ok: z.literal(false),
    reason: z.literal('excluded_personality'),
    personalityId: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.literal('too_large'),
    limitBytes: z.number().int().positive(),
  }),
  z.object({ ok: z.literal(false), reason: z.literal('empty') }),
]);
export type ShareRefusal = z.infer<typeof ShareRefusalSchema>;

export const ShareIncludeSchema = z.object({
  /** Tool names and a success/failure flag on assistant turns (D6). Default off in the UI. */
  includeToolNames: z.boolean(),
  /** Redact PII (email, phone, card, SSN, IBAN) on top of secrets. Default on in the UI. */
  pii: z.boolean(),
});

export const SharePreviewInputSchema = ShareIncludeSchema.extend({
  sessionId: z.string().min(1),
});
export const SharePreviewOutputSchema = z.union([
  z.object({ ok: z.literal(true), snapshot: ShareSnapshotWireSchema }),
  ShareRefusalSchema,
]);

export type SharePreviewOutput = z.infer<typeof SharePreviewOutputSchema>;

export const ShareCreateInputSchema = SharePreviewInputSchema.extend({
  expiresIn: ShareExpirySchema,
});
export const ShareCreateOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    /** Holds the token. Shown once; the server keeps only its hash. */
    url: z.string(),
    /** First 8 token chars, for `ethos sessions share revoke <prefix>`. */
    prefix: z.string(),
    expiresAt: z.string(),
    /** The URL is built on a loopback address: it opens only on this machine (D4). */
    loopback: z.boolean(),
  }),
  ShareRefusalSchema,
]);

export type ShareCreateOutput = z.infer<typeof ShareCreateOutputSchema>;

export const ShareLinkSummaryWireSchema = z.object({
  id: z.string(),
  prefix: z.string(),
  sessionId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  viewCount: z.number().int().nonnegative(),
  lastViewedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ShareLinkSummaryWire = z.infer<typeof ShareLinkSummaryWireSchema>;

export const ShareListInputSchema = z.object({
  /** Default true: revoked, expired and purged rows are left out. */
  activeOnly: z.boolean().optional(),
});
export const ShareListOutputSchema = z.object({
  /** `shareLinks.enabled` right now, so the UI can show the off state (D11, D14). */
  enabled: z.boolean(),
  links: z.array(ShareLinkSummaryWireSchema),
});

export const ShareRevokeInputSchema = z.object({
  /** The summary `id`, or a token prefix of at least 4 characters. */
  id: z.string().min(1),
});
export const ShareRevokeOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['not_found', 'ambiguous_prefix', 'prefix_too_short']),
  }),
]);
export type ShareRevokeOutput = z.infer<typeof ShareRevokeOutputSchema>;
