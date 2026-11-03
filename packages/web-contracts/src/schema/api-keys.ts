import { z } from 'zod';

// ---------------------------------------------------------------------------
// API Keys — Control-Plane SDK auth
//
// Metadata returned by the admin namespace. The plaintext secret is only
// returned on create; subsequent reads never expose it.
// ---------------------------------------------------------------------------

// Two scopes read as "chat" and they are NOT interchangeable:
//
//   `chat`      gates the whole OpenAI-compatible `/v1/*` surface
//               (`/v1/models`, `/v1/chat/completions`). Asserted by
//               `bearerAuth` at the `/v1` mount in
//               apps/web-api/src/routes/openai/index.ts.
//   `chat:send` gates the `chat.send` / `chat.abort` RPC procedures on the
//               browser-facing `/rpc/*` surface, via SCOPE_MAP in
//               apps/web-api/src/middleware/dual-auth.ts.
//
// A key needs `chat` to drive Cursor/Aider/the OpenAI SDKs, and `chat:send` to
// drive a Mission Control built on `@ethosagent/sdk`. Neither implies the other.
// `cron` gates the whole `POST /cron/fire` route (apps/web-api/src/routes/cron.ts)
// the same way `chat` gates the whole `/v1/*` surface — a plain bearer-checked
// route, not an RPC method, so it has no SCOPE_MAP entry (dual-auth.ts's
// SCOPE_MAP is keyed by oRPC path and only applies to `/rpc/*`/`/sse/*`).
//
// The fixed vocabulary. Every surface-gating scope is a member here; only the
// `mcp:<id>` family below is open-ended. Kept as its own exported enum because
// `.options` — the enumerable list — is what the CLI prints as "valid scopes"
// and what the SCOPE_MAP drift test enumerates. A union has no such list.
export const ApiKeyStaticScopeSchema = z.enum([
  'sessions:read',
  'sessions:write',
  'chat',
  'chat:send',
  'personalities:read',
  'memory:read',
  'memory:write',
  'tools:approve',
  'events:subscribe',
  'metrics:read',
  'cron',
]);
export type ApiKeyStaticScope = z.infer<typeof ApiKeyStaticScopeSchema>;

// `mcp:<personality-id>` — one key, one exported personality. The id half is
// SAFE_ID_REGEX, COPIED from `packages/types/src/id-validation.ts`: this
// package is a zero-dependency contract package and cannot import
// `@ethosagent/types` (ARCHITECTURE.md Law 1, dependency direction), so the
// pattern is duplicated on purpose rather than shared. The two copies MUST
// change together — same arrangement as the symlink walk duplicated between
// `packages/core/src/scoped/scoped-fs.ts` and
// `packages/storage-fs/src/scoped-storage.ts`, and for the same reason.
//
// The charset is the point, not decoration: the id names a personality that a
// host resolves, so `mcp:../x` must never parse.
const MCP_EXPORT_SCOPE_REGEX = /^mcp:[a-z0-9][a-z0-9_-]*$/;
export const McpExportScopeSchema = z
  .string()
  .regex(MCP_EXPORT_SCOPE_REGEX, 'must look like `mcp:<personality-id>`');

// The scope vocabulary as a whole: the fixed enum, or one `mcp:<id>`.
//
// `z.infer` widens this union to `string` — a regex-refined `z.string()` has
// no narrower static type, as everywhere else in this file. `ApiKeyScopeSchema`
// is therefore the gate; the TYPE is not. Anything validating a scope must
// parse it, not merely annotate it. Use `ApiKeyStaticScope` where only a fixed
// member is admissible (e.g. a default).
export const ApiKeyScopeSchema = z.union([ApiKeyStaticScopeSchema, McpExportScopeSchema]);
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

export const ApiKeyMetadataSchema = z.object({
  id: z.string(),
  prefix: z.string(),
  name: z.string(),
  scopes: z.array(ApiKeyScopeSchema),
  allowedOrigins: z.array(z.string()),
  createdAt: z.string(), // ISO-8601
  lastUsed: z.string().nullable(), // ISO-8601
  revokedAt: z.string().nullable(), // ISO-8601
});
export type ApiKeyMetadata = z.infer<typeof ApiKeyMetadataSchema>;
