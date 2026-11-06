import { z } from 'zod';

// ---------------------------------------------------------------------------
// Plugins + MCP — v1
//
// Read-only inventory of what's discoverable on disk. Full install /
// remove flows live in `ethos plugin` CLI for now; the web tab
// surfaces what's loaded so users can see the contract surface their
// agents currently have. MCP server CRUD is similar — `~/.ethos/mcp.json`
// is the editable shape (CLI: `ethos plugin add-mcp`).
// ---------------------------------------------------------------------------

export const PluginSourceSchema = z.enum(['user', 'project', 'npm']);
export type PluginSource = z.infer<typeof PluginSourceSchema>;

/**
 * One safety-scan finding retained from the plugin load. Yellow findings do
 * not block the load — they are surfaced here so the operator can see what
 * the scanner found and why. Red findings block, and appear here alongside
 * the plugin's `error`.
 */
export const PluginScanFindingSchema = z.object({
  severity: z.enum(['red', 'yellow']),
  /** Scanner rule slug, e.g. `network-access`. */
  rule: z.string(),
  message: z.string(),
  /** 1-based line number inside `file`, when the rule matched a line. */
  line: z.number().int().optional(),
  /** The matched source line, trimmed by the scanner. */
  excerpt: z.string().optional(),
  /** Path of the scanned file, relative to the plugin directory. */
  file: z.string().optional(),
});
export type PluginScanFinding = z.infer<typeof PluginScanFindingSchema>;

export const PluginInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().nullable(),
  /** Where the plugin was discovered. `user` → ~/.ethos/plugins, `project` → .ethos/plugins, `npm` → resolved from node_modules. */
  source: PluginSourceSchema,
  /** Server-side absolute path to the plugin directory (for diagnostics). */
  path: z.string(),
  /** Declared plugin contract major version, or null when the manifest doesn't pin one. */
  pluginContractMajor: z.number().int().nullable(),
  hasHomePanel: z.boolean().optional(),
  /**
   * Live load status from the plugin loader. `null` when this process never
   * tried to activate the plugin — it is on disk, nothing more is known.
   */
  status: z.enum(['loaded', 'failed']).nullable(),
  /** Why the load failed. Null unless `status` is `failed`. */
  error: z.string().nullable(),
  /** Safety-scan findings retained from the load. Omitted when the scan was clean. */
  scanFindings: z.array(PluginScanFindingSchema).optional(),
  /**
   * Trust tier from the plugin's install grant (`plugins/grants.json`
   * `scan.tier`, what `ethos plugin grants` prints), read by
   * `PluginsService.list`. Null when no grant is recorded (a manual drop, a
   * project plugin) or the grant file is unreadable.
   */
  trustTier: z.enum(['builtin', 'trusted-repo', 'community', 'untrusted']).nullable().optional(),
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;

export const CredentialKeyInfoSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['secret', 'text']),
  description: z.string().nullable(),
  refreshHint: z.enum(['daily', 'weekly', 'manual']).nullable(),
  required: z.boolean().nullable(),
  isSet: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type CredentialKeyInfo = z.infer<typeof CredentialKeyInfoSchema>;

export const McpTransportSchema = z.enum(['stdio', 'sse', 'streamable-http']);

export const McpServerInfoSchema = z.object({
  name: z.string(),
  transport: McpTransportSchema,
  /** Stdio: the command. */
  command: z.string().nullable(),
  /** SSE: the endpoint. */
  url: z.string().nullable(),
  auth_status: z.enum(['none', 'authorized', 'expired', 'missing', 'pending']).nullable(),
  created_via: z.enum(['cli', 'ui']).nullable(),
  mcpResultLimitChars: z.number().int().positive().nullable(),
  deprecated: z.boolean().nullable(),
});
export type McpServerInfo = z.infer<typeof McpServerInfoSchema>;

// ---------------------------------------------------------------------------
// MCP install flow — v1
// ---------------------------------------------------------------------------

export const McpStartInputSchema = z.object({
  url: z.string().url(),
  name: z.string().min(1).max(64).optional(),
  personalityId: z.string().min(1).optional(),
});

export const McpStartOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    state: z.string(),
    authorizeUrl: z.string(),
    serverName: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'discovery_failed',
      'dcr_unsupported',
      'dcr_failed',
      'name_taken',
      'webBaseUrl_missing',
      'ssrf_blocked',
      'invalid_origin',
    ]),
    detail: z.string().optional(),
  }),
]);

// Device-code sign-in (RFC 8628) for an EXISTING entry only (plan
// mcp-device-code-login §7.2, D16). The userCode is returned once, by
// deviceStart; deviceStatus never carries it.
export const McpDeviceStartInputSchema = z.object({
  serverName: z.string().min(1).max(64),
  personalityId: z.string().min(1).optional(),
});

export const McpDeviceStartOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    flowId: z.string(),
    userCode: z.string(),
    verificationUri: z.string().url(),
    verificationUriComplete: z.string().url().optional(),
    /** ISO-8601. */
    expiresAt: z.string(),
    serverName: z.string(),
    serverHost: z.string(),
    authHost: z.string(),
    personalityId: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'not_found',
      'not_oauth',
      'device_unavailable',
      'device_refused',
      'already_pending',
      'too_many_pending',
      'discovery_failed',
    ]),
    detail: z.string().optional(),
  }),
]);

export const McpDeviceStatusInputSchema = z.object({
  flowId: z.string().min(16).max(128),
});

export const McpDeviceStatusOutputSchema = z.object({
  status: z.enum(['pending', 'connected', 'denied', 'expired', 'cancelled', 'error']),
  serverName: z.string().optional(),
  reason: z.string().optional(),
});

export const McpDeviceCancelInputSchema = McpDeviceStatusInputSchema;

export const McpCompleteInputSchema = z.object({
  code: z.string().optional(),
  state: z.string(),
  error: z.string().optional(),
  /** RFC 9207 issuer identifier from the authorization response, when the provider sent one. */
  iss: z.string().optional(),
});

export const McpCompleteOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), serverName: z.string() }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'missing_pending_cookie',
      'expired_state',
      'state_mismatch',
      'code_exchange_failed',
      'upstream_error',
      'name_taken',
      'addserver_failed',
      'issuer_mismatch',
    ]),
    detail: z.string().optional(),
  }),
]);

export const McpStatusOutputSchema = z.object({
  status: z.enum(['pending', 'connected', 'error', 'expired']),
  serverName: z.string().optional(),
  error: z.string().optional(),
});

export const McpCancelInputSchema = z.object({
  state: z.string(),
});

export const McpAttachInputSchema = z.object({
  serverName: z.string(),
  personalityIds: z.array(z.string()),
});

export const McpAttachOutputSchema = z.object({
  updated: z.array(z.string()),
  failed: z.array(z.object({ id: z.string(), error: z.string() })),
});

export const McpDeleteInputSchema = z.object({
  name: z.string(),
});

export const McpAddServerInputSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('streamable-http'),
    name: z.string().min(1).max(64),
    url: z.string().url(),
    authType: z.enum(['bearer', 'none']).optional(),
    token: z.string().min(1).optional(),
    mcpResultLimitChars: z.number().int().positive().optional(),
  }),
  z.object({
    transport: z.literal('sse'),
    name: z.string().min(1).max(64),
    url: z.string().url(),
    authType: z.enum(['bearer', 'none']).optional(),
    token: z.string().min(1).optional(),
    mcpResultLimitChars: z.number().int().positive().optional(),
  }),
  z.object({
    transport: z.literal('stdio'),
    name: z.string().min(1).max(64),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    mcpResultLimitChars: z.number().int().positive().optional(),
  }),
]);

export const McpAddServerOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), serverName: z.string() }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['ssrf_blocked', 'name_taken', 'invalid_url']),
    detail: z.string().optional(),
  }),
]);

export const McpConnectPresetInputSchema = z.object({
  presetName: z.string().min(1).max(64),
  personalityId: z.string().min(1),
});

export const McpConnectPresetOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    serverName: z.string(),
    toolCount: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['oauth_required', 'not_found', 'read_only', 'connect_failed']),
    detail: z.string(),
  }),
]);

export type McpAddServerInput = z.infer<typeof McpAddServerInputSchema>;

export const McpReconnectInputSchema = z.object({
  name: z.string(),
  personalityId: z.string().min(1).optional(),
});

export const McpListOutputSchema = z.object({
  servers: z.array(McpServerInfoSchema),
});

// ---------------------------------------------------------------------------
// MCP per-personality tool policy — mcp.yaml shape, surfaced so the editor
// can initialize the per-server tool checklist from disk. Mirrors
// `McpPolicy` / `McpServerPolicy` in @ethosagent/types. Tool names are BARE
// (no `mcp__<server>__` prefix) — that's what mcp.yaml stores.
// ---------------------------------------------------------------------------

export const McpServerPolicySchema = z.object({
  /** Bare tool names the server may expose. Absent = all tools allowed. */
  tools: z.array(z.string()).optional(),
  reject_args: z.record(z.string(), z.record(z.string(), z.array(z.string()))).optional(),
  enabled: z.boolean().optional(),
});

export const McpPolicySchema = z.object({
  servers: z.record(z.string(), McpServerPolicySchema).optional(),
});
export type McpPolicy = z.infer<typeof McpPolicySchema>;

// MCP server tool discovery — lists the tools a server exposes so the
// editor can render the per-server checklist. `available: false` signals
// the server is unreachable (not connected / no credentials); the UI then
// shows a note instead of an empty checklist.
export const McpServerToolsInputSchema = z.object({
  /** Personality the discovery runs under — OAuth credentials are scoped per personality. */
  personalityId: z.string().min(1),
  serverName: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().optional(),
});

export const McpServerToolsOutputSchema = z.object({
  /** False when the server could not be reached — `tools` will be empty. */
  available: z.boolean(),
  /** Bare tool names (prefix stripped). */
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});

// MCP per-personality server listing — returns the servers attached to a
// personality with their OAuth auth status.

export const McpPersonalityServersInputSchema = z.object({
  personalityId: z.string().min(1),
});

export const McpPersonalityServersOutputSchema = z.object({
  servers: z.array(
    z.object({
      name: z.string(),
      transport: z.string().optional(),
      url: z.string().optional(),
      auth_status: z.enum(['authorized', 'expired', 'missing']),
      auth_type: z.enum(['oauth2', 'bearer', 'none']).optional(),
    }),
  ),
});

export const McpRefreshTokenInputSchema = z.object({
  serverName: z.string().min(1),
});
export const McpRefreshTokenOutputSchema = z.object({
  ok: z.boolean(),
  expiresAt: z.string().nullable(),
  error: z.string().optional(),
});

export const McpRenameInputSchema = z.object({
  oldName: z.string().min(1),
  newName: z.string().min(1).max(64),
});
export const McpRenameOutputSchema = z.object({
  ok: z.literal(true),
});

export const McpUpdateTokenInputSchema = z.object({
  serverName: z.string().min(1),
  token: z.string().min(1),
});
export const McpUpdateTokenOutputSchema = z.object({
  ok: z.literal(true),
});

export const McpScopeStatusInputSchema = z.object({
  serverName: z.string().min(1),
});
export const McpScopeStatusOutputSchema = z.object({
  outcome: z.enum(['match', 'mismatch', 'inactive', 'no-introspection', 'error', 'unknown']),
  declaredScopes: z.array(z.string()),
  actualScopes: z.array(z.string()),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// MCP default catalog — the curated preset slate, served over oRPC.
//
// The catalog data itself lives in `@ethosagent/tools-mcp`, a Node-only
// package (stdio transports spawn child processes). `apps/web` must never
// import it, so the catalog crosses the same oRPC boundary every other piece
// of MCP data already crosses. These shapes mirror `McpRemotePreset` /
// `McpPreset` in that package exactly.
// ---------------------------------------------------------------------------

export const McpRemotePresetSchema = z.object({
  name: z.string(),
  label: z.string(),
  url: z.string(),
  transport: z.literal('streamable-http'),
  authType: z.enum(['oauth', 'none', 'bearer']),
  description: z.string(),
  /** Grouping label for the catalog UI, e.g. "Developer tools". */
  category: z.string(),
  docsUrl: z.string().optional(),
});
export type McpRemotePresetInfo = z.infer<typeof McpRemotePresetSchema>;

export const McpLocalPresetSchema = z.object({
  name: z.string(),
  description: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  /** Env vars the preset expects the user to supply. */
  envVars: z.array(z.string()),
  /** Values the user supplies that are appended to `args`, in order. */
  argVars: z.array(z.string()),
  category: z.string(),
  /** The exact release `args` launches; `integrity` is recorded, not enforced at launch. */
  pin: z.object({
    registry: z.enum(['npm', 'pypi']),
    package: z.string(),
    version: z.string(),
    integrity: z.string(),
  }),
});
export type McpLocalPresetInfo = z.infer<typeof McpLocalPresetSchema>;

/** @deprecated Use catalog.list({ kind: 'mcp' }). Removal: one minor release after this one (plan unified-catalog §9). */
export const McpCatalogOutputSchema = z.object({
  remote: z.array(McpRemotePresetSchema),
  local: z.array(McpLocalPresetSchema),
});
/** @deprecated Use catalog.list({ kind: 'mcp' }). Removal: one minor release after this one (plan unified-catalog §9). */
export type McpCatalogOutput = z.infer<typeof McpCatalogOutputSchema>;

export const McpValidateConfigInputSchema = z.object({
  transport: z.enum(['streamable-http', 'sse', 'stdio']),
  url: z.string().optional(),
  command: z.string().optional(),
  name: z.string().optional(),
});
export const McpValidateConfigOutputSchema = z.object({
  valid: z.boolean(),
  errors: z.array(
    z.object({
      field: z.string(),
      message: z.string(),
    }),
  ),
});
