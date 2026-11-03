import { z } from 'zod';

// ---------------------------------------------------------------------------
// MCP export — the personality detail page's export section (M-T9,
// plan/phases/trust-before-reach.md Part 3). The declaration lives in the
// personality's config.yaml; it is written through `personalities.update`.
//
// NO SECRET crosses this shape. `personalities.mcpExport` is reachable by a
// bearer key carrying `personalities:read`, so a client is its key PREFIX and
// label only, and the Desktop entry carries a placeholder where the secret
// goes — the web substitutes the secret from the `apiKeys.create` response,
// which is cookie-only and happens in the operator's own browser.
// ---------------------------------------------------------------------------

/** The resolved slice — `resolveMcpExportScope` (`packages/wiring/src/mcp-export.ts`), minus `exclude`. */
export const McpExportScopeViewSchema = z.object({
  allowed: z.array(z.string()),
  /** Named by `expose_tools` but outside the personality's reach — shown, never silently omitted. */
  dropped: z.array(z.string()),
  memory: z.enum(['none', 'scoped', 'full']),
  sessions: z.boolean(),
  auth: z.enum(['localhost', 'bearer']),
});
export type McpExportScopeViewWire = z.infer<typeof McpExportScopeViewSchema>;

/** An API key whose scopes include `mcp:<id>` exactly. Prefix only. */
export const McpExportClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.string(), // ISO-8601
  lastUsed: z.string().nullable(), // ISO-8601
});
export type McpExportClientWire = z.infer<typeof McpExportClientSchema>;

/** One `platform = mcp` session of this personality. */
export const McpExportCallSchema = z.object({
  sessionId: z.string(),
  updatedAt: z.string(), // ISO-8601
  /** `key-<prefix>` / `stdio-<name>` — the segment of `mcp:<id>:<client>:<conversation>`. */
  clientId: z.string(),
  /** The API key's label when `clientId` names a known key; null otherwise. */
  clientName: z.string().nullable(),
  title: z.string().nullable(),
  costUsd: z.number(),
});
export type McpExportCallWire = z.infer<typeof McpExportCallSchema>;

/** One `mcp.export.*` event with `decision: denied`. Metadata only — a reason code, never a body. */
export const McpExportDenialSchema = z.object({
  ts: z.string(), // ISO-8601
  kind: z.enum(['auth', 'discovery', 'call']),
  /** The wire event: `initialize`, `ask`, `http-request`, … */
  event: z.string(),
  /** `key-<prefix>`, `stdio-<name>`, or `-` when the caller never identified. */
  clientId: z.string(),
  clientName: z.string().nullable(),
  reason: z.string(),
});
export type McpExportDenialWire = z.infer<typeof McpExportDenialSchema>;

/**
 * The Claude Desktop config the CLI's `ethos mcp install claude-desktop
 * --personality <id>` would write into an empty config — produced server-side
 * by the same entry builder and the same client adapter, so the two surfaces
 * cannot disagree about its shape.
 */
export const McpExportDesktopEntrySchema = z.object({
  /** `ethos-<id>`. */
  name: z.string(),
  /** Serialised config. Under `auth: bearer` it contains `secretPlaceholder` as a JSON string. */
  json: z.string(),
  /** The token to replace with the minted secret; null when the entry carries no key. */
  secretPlaceholder: z.string().nullable(),
});
export type McpExportDesktopEntryWire = z.infer<typeof McpExportDesktopEntrySchema>;

/**
 * The stored `mcp_export` block as parsed (`PersonalityMcpExportConfig`,
 * `buildMcpExportConfig` in `extensions/personalities/src/index.ts`). The
 * export section's form pre-fills from this, not from `scope`: the resolved
 * slice cannot tell `expose_tools: all` from a list, drops the memory tools and
 * the out-of-reach names, and is null while export is off. Loose on purpose —
 * a hand-written config.yaml must not fail this output.
 */
export const McpExportDeclarationViewSchema = z.object({
  enabled: z.boolean(),
  expose_tools: z.union([z.literal('all'), z.literal('none'), z.array(z.string())]).optional(),
  expose_memory: z.enum(['none', 'scoped', 'full']).optional(),
  expose_sessions: z.boolean().optional(),
  auth: z.enum(['localhost', 'bearer']).optional(),
});
export type McpExportDeclarationViewWire = z.infer<typeof McpExportDeclarationViewSchema>;

export const McpExportViewSchema = z.object({
  personalityId: z.string(),
  /** `mcp_export.enabled === true`, literally. */
  exported: z.boolean(),
  /** The stored declaration; null when config.yaml has no `mcp_export` block. */
  declaration: McpExportDeclarationViewSchema.nullable(),
  /** Null when this server could not resolve the slice (no live tool registry). */
  scope: McpExportScopeViewSchema.nullable(),
  /** The `mcp_export.*` keys the declaration is edited through. */
  declarationKeys: z.array(z.string()),
  /** Where the declaration lives, `~`-abbreviated. */
  configPath: z.string(),
  /** `ethos mcp serve --personality <id>`. */
  command: z.string(),
  /** Null when this server has no entry builder wired, or the slice is unresolved. */
  desktopEntry: McpExportDesktopEntrySchema.nullable(),
  clients: z.array(McpExportClientSchema),
  /** Newest first, at most 20. */
  calls: z.array(McpExportCallSchema),
  /** Newest first, at most 20. */
  denials: z.array(McpExportDenialSchema),
});
export type McpExportViewWire = z.infer<typeof McpExportViewSchema>;
