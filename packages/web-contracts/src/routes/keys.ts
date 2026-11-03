import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  ApiKeyMetadataSchema,
  ApiKeyScopeSchema,
  KeyCategorySchema,
  NamedSecretProviderNameSchema,
} from '../schemas';

// ---------------------------------------------------------------------------
// API Keys — admin CRUD (cookie-auth-gated only)
//
// Minting, listing, and revoking API keys for external Mission Controls.
// The plaintext secret is returned only from `create` — subsequent reads
// never expose the raw key. This namespace rejects bearer-token auth to
// prevent privilege escalation (a stolen key must not mint more keys).
// ---------------------------------------------------------------------------

const OriginSchema = z
  .string()
  .transform((s) => {
    try {
      const u = new URL(s);
      return u.origin;
    } catch {
      return s;
    }
  })
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.origin === s;
    } catch {
      return false;
    }
  }, 'Must be a valid origin (scheme + host + optional port, no path/query/fragment)');

const ApiKeyCreateInput = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(ApiKeyScopeSchema).min(1),
  allowedOrigins: z.array(OriginSchema).min(1),
});
const ApiKeyCreateOutput = z.object({
  /** Plaintext secret — shown once, then never again. */
  secret: z.string(),
  key: ApiKeyMetadataSchema,
});

const ApiKeyListInput = z.object({
  /** Page size. */
  limit: z.number().int().positive().optional(),
  /** Opaque cursor from the previous response's `nextCursor`. */
  cursor: z.string().optional(),
});
const ApiKeyListOutput = z.object({
  items: z.array(ApiKeyMetadataSchema),
  nextCursor: z.string().nullable(),
});

const ApiKeyRevokeInput = z.object({ id: z.string() });
const ApiKeyRevokeOutput = z.object({ ok: z.literal(true) });

/** @experimental */
export const apiKeys = {
  create: oc.input(ApiKeyCreateInput).output(ApiKeyCreateOutput),
  list: oc.input(ApiKeyListInput).output(ApiKeyListOutput),
  revoke: oc.input(ApiKeyRevokeInput).output(ApiKeyRevokeOutput),
};

// ---------------------------------------------------------------------------
// Named secrets — global vault manager for tool provider keys (Phase 2)
//
// A named secret lives at `providers/<provider>/<name>` in the vault. The raw
// value is written here and NEVER round-tripped back — `list` returns masked
// previews only. A personality stores just the secret NAME (a reference).
//
// WHICH providers exist is not stated here: it is derived from the
// `providers/<segment>/*` prefixes registered tools declare, and served by the
// `providers` procedure below. The wire only asserts the SHAPE of a provider id
// (plan/phases/tool-credential-surface.md D1).
// ---------------------------------------------------------------------------

const NamedSecretNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_-]+$/);

const NamedSecretViewSchema = z.object({
  provider: NamedSecretProviderNameSchema,
  name: z.string(),
  /** Masked preview (e.g. `…abc1`, or `<set>` / `<unset>`) — never the raw
   *  value, and never both ends of one. See `redactSecretValue`. */
  preview: z.string(),
  /** The provider's first declared `secretKind`. Tool-declared, so open. */
  kind: z.string(),
});

/** One row of the derived provider roster — a namespace an operator may type a
 *  credential into, with the presentation the declaring tool supplied. */
const NamedSecretProviderViewSchema = z.object({
  provider: NamedSecretProviderNameSchema,
  /** Every `secretKind` a tool declaring this provider binds. */
  kinds: z.array(z.string()),
  label: z.string(),
  getKeyUrl: z.string().optional(),
});

/** A declaration that grants nothing manageable. Reported, never thrown — a
 *  malformed capability prefix must not take down composition (D2, §11). */
const NamedSecretProviderDiagnosticSchema = z.object({
  toolName: z.string(),
  declared: z.string(),
  reason: z.string(),
});

/** @experimental */
export const namedSecrets = {
  list: oc.output(z.object({ secrets: z.array(NamedSecretViewSchema) })),
  providers: oc.output(
    z.object({
      providers: z.array(NamedSecretProviderViewSchema),
      diagnostics: z.array(NamedSecretProviderDiagnosticSchema),
    }),
  ),
  create: oc
    .input(
      z.object({
        provider: NamedSecretProviderNameSchema,
        name: NamedSecretNameSchema,
        // 8 KiB cap — real API keys are well under 1 KiB; the bound stops a
        // client from filling the vault dir with a giant value.
        value: z.string().min(1).max(8192),
      }),
    )
    .output(z.object({ ok: z.literal(true), preview: z.string() })),
  delete: oc
    .input(z.object({ provider: NamedSecretProviderNameSchema, name: NamedSecretNameSchema }))
    .output(z.object({ ok: z.literal(true) })),
  testKey: oc
    .input(z.object({ provider: NamedSecretProviderNameSchema, name: NamedSecretNameSchema }))
    .output(
      z.object({
        ok: z.boolean(),
        error: z.string().optional(),
        /** `false` when the provider has no live probe (an `x` search call is
         *  billable) — `ok` then only says the secret exists. */
        tested: z.boolean().optional(),
      }),
    ),
};

// ---------------------------------------------------------------------------
// Credentials — stored logins for `browser_fill_credential`
// (plan reach-and-containment §4.2)
//
// A login is four vault refs under `credentials/<name>/`. Values are
// write-only: `list` returns a masked username preview and presence flags,
// never a value, and `set` echoes nothing back. Field validation (bare https
// origins, personality ids, TOTP seeds) is the server's — the wire only bounds
// sizes and shapes.
// ---------------------------------------------------------------------------

const CredentialViewSchema = z.object({
  name: z.string(),
  origins: z.array(z.string()),
  personalities: z.array(z.string()),
  unattended: z.boolean(),
  /** Masked via `redactSecretValue` — never the raw username. */
  usernamePreview: z.string(),
  hasPassword: z.boolean(),
  hasTotp: z.boolean(),
  /** False when the stored policy is missing or unparseable; the tool refuses it. */
  policyValid: z.boolean(),
});

/** @experimental */
export const credentials = {
  list: oc.output(z.object({ credentials: z.array(CredentialViewSchema) })),
  set: oc
    .input(
      z.object({
        name: NamedSecretNameSchema,
        /** Required for a new login; omitted keeps the stored value. */
        username: z.string().min(1).max(8192).optional(),
        /** Required for a new login; omitted keeps the stored value. */
        password: z.string().min(1).max(8192).optional(),
        /** Omitted keeps the stored seed; `null` removes it. */
        totp: z.string().max(8192).nullable().optional(),
        origins: z.array(z.string().min(1).max(2048)).min(1).max(32),
        personalities: z.array(z.string().min(1).max(128)).max(64),
        unattended: z.boolean(),
      }),
    )
    .output(z.object({ ok: z.literal(true) })),
  delete: oc
    .input(z.object({ name: NamedSecretNameSchema }))
    .output(z.object({ ok: z.literal(true) })),
};

// ---------------------------------------------------------------------------
// Keys — masked inventory of the WHOLE secrets vault, by category
//
// A third read path onto the same vault `namedSecrets` and `models` already
// read, and deliberately so: it is the only one that shows everything. Its
// catalog partitions the vault — every ref is either claimed by a catalog
// entry or surfaces under `custom`, so nothing is silently hidden.
//
// Values are write-only, exactly as in `namedSecrets`: `list` returns masked
// previews and a raw value never comes back. A row the catalog marks as a
// reflection of a named secret is read-only here (`canSet`/`canClear` false) —
// it is edited from the Security pane that owns it.
// ---------------------------------------------------------------------------

/**
 * The complete set of fields a `blob` entry is allowed to expose — CLOSED, so
 * an unknown key REJECTS the response at the contract boundary instead of being
 * silently dropped or, worse, serialized. A `blob` ref holds a whole OAuth
 * token document (codex: `accessToken`, `refreshToken`, `idToken`, `accountId`,
 * `expiresAt`, `updatedAt`); three of those are bearer credentials, and an
 * open `z.record` would have permitted every one of them through the contract.
 *
 * Defence in depth: `parseCodexTokens` in
 * `apps/web-api/src/services/keys-catalog.ts` is the runtime allowlist that
 * picks these same two fields out of the document, and `KeysService.viewFor`
 * filters again to string values. This schema is the third and last gate — the
 * one a parser refactor or an object spread on the server cannot get past.
 * Changing either side means changing both.
 */
export const KeyBlobDetailsSchema = z.strictObject({
  accountId: z.string().optional(),
  expiresAt: z.string().optional(),
});
export type KeyBlobDetails = z.infer<typeof KeyBlobDetailsSchema>;

const KeyFieldViewSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** The vault ref this field reads and writes. */
  ref: z.string(),
  /** Masked preview (e.g. `…abc1`, or `<set>` / `<unset>`) — never the raw
   *  value, and never both ends of one. See `redactSecretValue`. */
  preview: z.string(),
  set: z.boolean(),
});

const KeyEntryViewSchema = z.object({
  id: z.string(),
  category: KeyCategorySchema,
  label: z.string(),
  shape: z.enum(['single', 'multi', 'blob']),
  /** Empty for a `blob` entry — a blob has no editable fields. */
  fields: z.array(KeyFieldViewSchema),
  /** `blob` entries only. See `KeyBlobDetailsSchema` — CLOSED, so an unknown
   *  key is rejected here rather than serialized. */
  details: KeyBlobDetailsSchema.optional(),
  set: z.boolean(),
  canSet: z.boolean(),
  canClear: z.boolean(),
  getKeyUrl: z.string().optional(),
  /** Present only where a real live probe exists today. */
  probe: z.enum(['exa', 'tavily', 'brave', 'google']).optional(),
});

const KeyCategoryViewSchema = z.object({
  id: KeyCategorySchema,
  entries: z.array(KeyEntryViewSchema),
});

const KeysSetInput = z.object({
  id: z.string().min(1),
  /** fieldKey → raw value. 8 KiB cap per value, as in `namedSecrets`. */
  values: z.record(z.string(), z.string().min(1).max(8192)),
});

/** @experimental */
export const keys = {
  list: oc.output(z.object({ categories: z.array(KeyCategoryViewSchema) })),
  set: oc.input(KeysSetInput).output(z.object({ ok: z.literal(true) })),
  clear: oc.input(z.object({ id: z.string().min(1) })).output(z.object({ ok: z.literal(true) })),
};

// ---------------------------------------------------------------------------
// Tool settings — generic per-personality tool config, driven by each tool's
// `settingsSchema` (Phase 2). `web_search` is the sole consumer in v1.
// ---------------------------------------------------------------------------

const ToolSettingsEnumFieldSchema = z.object({
  kind: z.literal('enum'),
  key: z.string(),
  label: z.string(),
  options: z.array(
    z.object({
      value: z.string(),
      label: z.string().optional(),
      /** Where the operator gets a key for this option's provider. */
      getKeyUrl: z.string().optional(),
    }),
  ),
  default: z.string().optional(),
  required: z.boolean().optional(),
});
const ToolSettingsSecretBindingFieldSchema = z.object({
  kind: z.literal('secret-binding'),
  key: z.string(),
  label: z.string(),
  secretKind: z.string(),
  required: z.boolean().optional(),
  helpText: z.string().optional(),
  /** Presentation for the provider namespace this credential lives in, and the
   *  tool's own default secret name. Mirrors `ToolSettingsSecretBindingField`
   *  in `@ethosagent/types` — the hand-maintained mirror the derived roster
   *  reads its labels through, so the two must change together (D4). */
  providerLabel: z.string().optional(),
  getKeyUrl: z.string().optional(),
  defaultSecretName: z.string().optional(),
  /** The one `providers/<segment>/` namespace this field binds when the tool
   *  grants several; absent → every namespace the tool grants. */
  provider: z.string().optional(),
});
/** A static disclosure row — no key, so nothing round-trips through it. Mirrors
 *  `ToolSettingsInfoField` in `@ethosagent/types`; a tool that needs a
 *  credential it does not bind itself says so here. */
const ToolSettingsInfoFieldSchema = z.object({
  kind: z.literal('info'),
  label: z.string(),
  text: z.string(),
});
const ToolSettingsSchemaSchema = z.object({
  fields: z.array(
    z.discriminatedUnion('kind', [
      ToolSettingsEnumFieldSchema,
      ToolSettingsSecretBindingFieldSchema,
      ToolSettingsInfoFieldSchema,
    ]),
  ),
});

/** settings key (`settingsKey ?? toolName`) → fieldKey → string value. Only a
 *  secret NAME is ever carried for a secret-binding field — never a value. */
const ToolSettingsValuesSchema = z.record(z.string(), z.record(z.string(), z.string()));
const ToolStorageSchema = z.enum(['personality', 'global']);

/** @experimental */
export const toolSettings = {
  schemas: oc.output(
    z.object({
      tools: z.array(
        z.object({
          name: z.string(),
          /** Storage slot the tool's settings live in; absent → the tool name.
           *  Two tools sharing one credential report the same key, and the UI
           *  renders ONE form per key. Mirrors `Tool.settingsKey`. */
          settingsKey: z.string().optional(),
          settingsSchema: ToolSettingsSchemaSchema,
        }),
      ),
    }),
  ),
  getDefault: oc.output(z.object({ values: ToolSettingsValuesSchema })),
  setDefault: oc
    .input(z.object({ values: ToolSettingsValuesSchema }))
    .output(z.object({ ok: z.literal(true) })),
  getForPersonality: oc
    .input(z.object({ personalityId: z.string().min(1) }))
    .output(z.object({ values: ToolSettingsValuesSchema, storage: ToolStorageSchema })),
  setForPersonality: oc
    .input(z.object({ personalityId: z.string().min(1), values: ToolSettingsValuesSchema }))
    .output(z.object({ ok: z.literal(true), storage: ToolStorageSchema })),
  /**
   * Read-only resolution probe: for each secret-bearing tool group in the
   * personality's toolset, report the ref the tool's ladder would resolve,
   * which rung supplied it, and whether a non-empty value is present — never
   * the value itself (plan/phases/tool-credential-surface.md D9 / PR3).
   */
  probeCredentials: oc.input(z.object({ personalityId: z.string().min(1) })).output(
    z.object({
      credentials: z.array(
        z.object({
          key: z.string(),
          toolNames: z.array(z.string()),
          ref: z.string(),
          rung: z.enum(['personality', 'global-personality', 'global-default', 'tool-default']),
          present: z.boolean(),
          origin: z.enum(['set-here', 'inherited', 'unset']),
        }),
      ),
    }),
  ),
};
