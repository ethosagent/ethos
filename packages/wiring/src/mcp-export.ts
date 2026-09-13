/**
 * Honouring `PersonalityConfig.mcp_export` — the pure scope resolver and the
 * client authenticator the export server (`apps/mcp-server/src/export-server.ts`,
 * M-T5) is built on. Part 3 of plan/phases/trust-before-reach.md.
 *
 * Nothing here runs a turn or opens a transport. `resolveMcpExportScope` turns
 * the declaration into the bounds an exported turn runs under; the
 * authenticator answers "may this caller ask this personality anything at all".
 * Both are recomputed PER CALL by the server, which is what makes an edited
 * declaration and a revoked key take effect on the next call rather than at the
 * next restart.
 */

import { hashApiKey } from '@ethosagent/session-sqlite';
import type { PersonalityConfig, PersonalityMcpExportConfig } from '@ethosagent/types';
import { complementExclude } from './tool-scope';

/** `memory_read`/`memory_write` — `@ethosagent/tools-memory`, toolset `memory`. */
const MEMORY_READ_TOOL = 'memory_read';
const MEMORY_WRITE_TOOL = 'memory_write';

/**
 * The two registry facts the resolver needs, as a structural view so the
 * resolver stays pure and testable without a real registry.
 *
 * `DefaultToolRegistry` (`packages/core/src/tool-registry.ts`) satisfies it as
 * is. Note `CreateAgentLoopResult.toolRegistry` is DECLARED as the narrower
 * `ToolRegistry` interface from `@ethosagent/types`, which carries
 * `getAvailable()` but not `toolNamesForPersonality()` — a caller holding one
 * of those needs the concrete type (the instance always is one).
 */
export interface McpExportToolView {
  /**
   * Everything registered AND available right now. Read per call, never
   * cached: a late MCP server registers after boot, and an exclusion computed
   * once would not name its tools.
   */
  getAvailable(): readonly { readonly name: string }[];
  /**
   * The personality's full reach — `toolset` ∪ its attached MCP servers'
   * tools ∪ its allowed plugins' tools.
   */
  toolNamesForPersonality(personality: PersonalityConfig): Set<string>;
}

/** What one exported personality's declaration resolves to, fail-closed. */
export interface McpExportScope {
  /**
   * `mcp_export.enabled === true`, literally (M-D4). Everything else in this
   * result is empty / most-restrictive when it is false — a personality that
   * does not declare an export has no export, not a default one.
   */
  enabled: boolean;
  /**
   * The tools an exported turn MAY use: the declaration intersected with the
   * personality's reach, minus the memory tools `expose_memory` withholds.
   * Sorted; pass as `RunOptions.toolsetNarrow`.
   */
  allowed: string[];
  /**
   * Tools the declaration NAMED that are outside the personality's reach —
   * not in its toolset, or not registered at all. Surfaced so the character
   * sheet and the web section can say "`terminal` — not in toolset" instead of
   * ignoring the line. Always empty for `'all'`/`'none'`, which name nothing.
   *
   * A memory tool withheld by `expose_memory` is NOT dropped: it is in reach
   * and the memory row already says why it is not exposed.
   */
  dropped: string[];
  /**
   * The complement of `allowed` over what is registered — pass as
   * `RunOptions.toolsetExclude`.
   *
   * This is the load-bearing half. `toolsetNarrow` gates BUILT-IN tools only:
   * `mcp__*`, plugin-registered and `alwaysInclude` tools are let past the name
   * allowlist by design (`toDefinitions`/`executeParallel`,
   * `packages/core/src/tool-registry.ts`), and `excludeTools` is the one filter
   * that reaches all three (`passesFilter`). Narrow alone would export a
   * conversation-only specialist that can still call every MCP tool on the
   * machine. B-T6's `complementExclude` (`./tool-scope`) computes it — the same
   * helper the A2A runner uses for the identical gap, never a second copy.
   */
  exclude: string[];
  /** `expose_memory`, defaulted to `'none'` (M-D4/M-D5). */
  memory: 'none' | 'scoped' | 'full';
  /** `expose_sessions`, defaulted to `false`. */
  sessions: boolean;
  /** `auth`, defaulted to `'localhost'`. */
  auth: 'localhost' | 'bearer';
}

/**
 * Resolve one personality's `mcp_export` declaration against what is registered
 * right now. Pure: no I/O, no clock, no registry mutation.
 *
 * `allowed = expose_tools ∩ toolNamesForPersonality(personality)`. `'all'` is
 * the personality's full reach; `'none'` — and an absent key — is `[]`, a
 * conversation-only specialist (M-D4). `expose_tools` can only ever REMOVE
 * reach: naming a tool the personality does not have grants nothing, it lands
 * in `dropped`.
 *
 * `expose_memory` (M-D5) then strips the memory tools: `memory_write` unless
 * `'full'`, `memory_read` when `'none'`. It does not reach the memory SCOPE —
 * turn-setup fixes that at `personality:<id>` — so `'scoped'` means read-only
 * access to this personality's own memory and nothing else.
 *
 * LIMITATION (CLAUDE.md rule 12): the strip covers the two personality memory
 * tools only. `team_memory_read`/`team_memory_write`/`team_memory_search` are
 * not touched — they need `ctx.teamId`, which an export process does not set,
 * and they reach a personality's toolset only if the operator listed them. If a
 * team deployment ever exports a personality that lists them, `expose_tools`
 * (or the toolset) is the gate, not `expose_memory`.
 */
export function resolveMcpExportScope(
  personality: PersonalityConfig,
  registry: McpExportToolView,
): McpExportScope {
  const declaration: PersonalityMcpExportConfig | undefined = personality.mcp_export;
  const registered = registry.getAvailable().map((tool) => tool.name);

  // Fail closed on anything short of a literal `true`. A personality with no
  // declaration at all takes exactly this branch.
  if (declaration?.enabled !== true) {
    return {
      enabled: false,
      allowed: [],
      dropped: [],
      exclude: complementExclude(registered, []),
      memory: 'none',
      sessions: false,
      auth: 'localhost',
    };
  }

  const memory = declaration.expose_memory ?? 'none';
  const reach = registry.toolNamesForPersonality(personality);
  const expose = declaration.expose_tools ?? 'none';

  let granted: Set<string>;
  const dropped = new Set<string>();
  if (expose === 'all') {
    granted = new Set(reach);
  } else if (expose === 'none') {
    granted = new Set<string>();
  } else {
    granted = new Set<string>();
    for (const name of expose) {
      if (reach.has(name)) granted.add(name);
      else dropped.add(name);
    }
  }

  if (memory !== 'full') granted.delete(MEMORY_WRITE_TOOL);
  if (memory === 'none') granted.delete(MEMORY_READ_TOOL);

  const allowed = [...granted].sort();
  return {
    enabled: true,
    allowed,
    dropped: [...dropped].sort(),
    // Recomputed from `registered` on every call, so a tool that registered
    // after boot is excluded by the next call rather than the next restart.
    exclude: complementExclude(registered, allowed),
    memory,
    sessions: declaration.expose_sessions ?? false,
    auth: declaration.auth ?? 'localhost',
  };
}

// ---------------------------------------------------------------------------
// Client authentication (M-D9)
// ---------------------------------------------------------------------------

/** Why a caller was refused. Metadata for the `mcp.export.auth` event. */
export type McpClientDenyReason =
  /** No key presented (no `Authorization` header, no `ETHOS_MCP_KEY`). */
  | 'missing_key'
  /** Not an Ethos key — wrong shape, never looked up. */
  | 'malformed_key'
  /**
   * No live key hashes to this secret. Covers unknown AND revoked: the store's
   * `findByHash` filters `revoked_at IS NULL`, so the two are indistinguishable
   * here by construction — and telling a caller which it was would be a probe.
   */
  | 'invalid_key'
  /** A live key, but it does not carry `mcp:<personalityId>`. */
  | 'wrong_scope';

export type McpClientAuthResult =
  | {
      ok: true;
      /**
       * The audit and session-key identity for this caller: `key-<prefix>`
       * (M-D8). The prefix is `sk-ethos-XXXXXXXX` — no `:`, so a client can
       * never widen its own session-key prefix.
       */
      clientId: string;
      /** `ApiKeyRecord.id` — the revoke handle, for the Clients table. */
      keyId: string;
      /** `sk-ethos-XXXXXXXX`, safe to print. */
      keyPrefix: string;
      /** The operator's label for the key. */
      keyName: string;
    }
  | { ok: false; reason: McpClientDenyReason };

/**
 * The slice of `SqliteApiKeyStore` (`extensions/session-sqlite/src/api-key-store.ts`)
 * this needs. Structural so a test can pass a fake; the real store satisfies it.
 */
export interface McpApiKeyStoreView {
  findByHash(
    hash: string,
  ): Promise<{ id: string; prefix: string; name: string; scopes: string[] } | null>;
  touchLastUsed(id: string): Promise<void>;
}

export interface CreateMcpClientAuthenticatorOptions {
  /** The ONE personality this export serves. The client never names it. */
  personalityId: string;
  /** The key store — `new SqliteApiKeyStore(join(dataDir, 'sessions.db'))`. */
  keys: McpApiKeyStoreView;
  /**
   * sha256 of the presented secret. Defaults to `hashApiKey` from
   * `@ethosagent/session-sqlite` — the same hash `create()` stored, so the two
   * can never drift. Injectable for tests only.
   */
  hash?: (secret: string) => string;
}

export interface McpClientAuthenticator {
  /** The scope a key must carry: `mcp:<personalityId>`. */
  readonly requiredScope: string;
  /**
   * Verify one presented secret. Called at initialize AND on every call
   * (M-D9), so revoking a key takes effect on the caller's next call.
   */
  verify(secret: string | undefined): Promise<McpClientAuthResult>;
}

const SECRET_PREFIX = 'sk-ethos-';

/**
 * Bearer verification for one exported personality (M-D9).
 *
 * A `sk-ethos-` key admits a caller only when it carries `mcp:<id>` for THIS
 * personality: a key minted for another export (`mcp:other`) or for a different
 * surface (`chat`, `sessions:read`) is refused, so one client's credential is
 * never a key to the whole machine. Revocation needs no restart — every call
 * re-verifies, and `findByHash` returns nothing for a revoked row.
 *
 * `last_used` is touched on each accepted verification, best-effort: a failed
 * metadata write must never refuse a caller. Unthrottled on purpose (unlike
 * `bearerAuth`'s streaming `/v1/*` path) — one touch per exported turn, and a
 * turn costs seconds.
 */
export function createMcpClientAuthenticator(
  opts: CreateMcpClientAuthenticatorOptions,
): McpClientAuthenticator {
  const requiredScope = `mcp:${opts.personalityId}`;
  return {
    requiredScope,
    verify: async (secret) => {
      if (secret === undefined || secret.trim() === '') return { ok: false, reason: 'missing_key' };
      const presented = secret.trim();
      if (!presented.startsWith(SECRET_PREFIX)) return { ok: false, reason: 'malformed_key' };

      const hash = opts.hash ?? hashApiKey;
      const record = await opts.keys.findByHash(hash(presented));
      if (!record) return { ok: false, reason: 'invalid_key' };
      if (!record.scopes.includes(requiredScope)) return { ok: false, reason: 'wrong_scope' };

      try {
        await opts.keys.touchLastUsed(record.id);
      } catch {
        // Metadata only — never refuse a caller because the write failed.
      }
      return {
        ok: true,
        clientId: `key-${record.prefix}`,
        keyId: record.id,
        keyPrefix: record.prefix,
        keyName: record.name,
      };
    },
  };
}
