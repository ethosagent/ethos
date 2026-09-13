import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { declaredWorkdirs } from '@ethosagent/core';
import {
  type CharacterSheetBoundary,
  type CharacterSheetMcpExport,
  type CharacterSheetModelFit,
  type CharacterSheetRouting,
  type CharacterSheetScriptSurface,
  type CreatePersonalityInput,
  type DescribedPersonality,
  type FilePersonalityRegistry,
  type PersonalityToolsConfig,
  renderCharacterSheet,
  SYSTEM_PERSONALITY_IDS,
  type UpdatePersonalityPatch,
} from '@ethosagent/personalities';
import { draftExpressionUpdate, draftSoulSplit } from '@ethosagent/skill-evolver';
import type { PersonalitySkillRecord, SkillsInjector, SkillsLibrary } from '@ethosagent/skills';
import { type McpJsonStore, mcpTokenSecretRef } from '@ethosagent/tools-mcp';
import {
  EthosError,
  type ExecutionPosture,
  type LearningLogEntry,
  type ObsEvent,
  type PersonalityConfig,
  type PersonalityMcpExportConfig,
  type Storage,
} from '@ethosagent/types';
import type {
  McpExportCallWire,
  McpExportClientWire,
  McpExportDenialWire,
  McpExportDesktopEntryWire,
  McpExportScopeViewWire,
  McpExportViewWire,
  McpPolicy,
  Personality,
  PersonalitySkill,
} from '@ethosagent/web-contracts';
import { listPendingExpressionCandidates, submitExpressionCandidate } from '@ethosagent/wiring';
import type { ApiKeyRecord } from '../middleware/bearer-auth';
import type { ConfigRepository } from '../repositories/config.repository';
import {
  type LearningRefusalCode,
  type LearningService,
  learningRefusalError,
} from './learning.service';

/** Latest Personality-Judge alignment, mapped from `.judge-history/state.json`. */
interface JudgeWire {
  alignmentScore: number;
  signal: 'drift' | 'underspecified_soul' | null;
  lowStreak: number;
  at?: string;
  perDimension?: Array<{ dimension: string; score: number }>;
}

/** Latest nightly-pass status, mapped from `.nightly-state.json`. */
interface NightlyWire {
  windowEnd: string;
  completed: string[];
}

// Personalities service. Calls into FilePersonalityRegistry for the
// directory-level CRUD (create/update/delete/duplicate) and into
// SkillsLibrary for the per-personality skills/ subdir. Both extensions
// own their own Storage layer; the service is a thin wire-shape mapper.

export interface PersonalitiesServiceOptions {
  personalities: FilePersonalityRegistry;
  library: SkillsLibrary;
  /**
   * The learning review inbox (L-T8). Every approval this service performs —
   * `skillCandidateApprove`, `applyExpression` — goes through it, so the
   * override rule and the audit rows have one owner. Absent → the skill
   * candidate queue lists empty and every decision fails `NOT_CONFIGURED`.
   */
  learning?: LearningService;
  secrets?: import('@ethosagent/types').SecretsResolver;
  mcpJsonStore?: McpJsonStore;
  /** Lazy LLM factory — drafts Expression updates and Soul splits (Phase 3a). */
  llm?: () => Promise<import('@ethosagent/types').LLMProvider>;
  /** Session store — supplies recent-interaction evidence for Expression drafts. */
  sessions?: import('@ethosagent/types').SessionStore;
  /** Storage — used to read the personality's Personality-Judge
   *  alignment sidecar. Omitted → `livingSoul` returns no `judge` block. */
  storage?: Storage;
  /**
   * Root data directory (`~/.ethos`). Used to read the Personality-Judge
   * alignment sidecar and to derive the `fs_reach` mount set for the character
   * sheet's `## Execution` section (Phase 2a, lane E1). When absent, the sheet
   * renders without the Execution block.
   */
  dataDir?: string;
  /**
   * Whether a Docker backend can be built in this process (F1). False for the
   * desktop in-process backend (`disableDocker: true`), so the character sheet
   * honestly shows a `local` (un-sandboxed) posture instead of claiming Docker.
   * Defaults to `true` (server deployments where Docker is available).
   */
  dockerBuildable?: boolean;
  /**
   * `<dataDir>/config.yaml`, read for `execution.ssh.*` when resolving the
   * character sheet's `## Execution` section. `execution.ssh.host`'s presence
   * is the switch for the whole remote posture, so without this the sheet
   * cannot tell a personality that runs on a remote target from one that runs
   * on this machine — and would render the wrong one of the two.
   *
   * Read through the repository rooted at `dataDir` rather than `readConfig()`
   * from `@ethosagent/config`, which resolves against the process-global
   * `ethosDir()`; see `BackupServiceOptions.config` for the same reasoning.
   * Absent → no remote target, the same as an absent `execution.ssh` block.
   */
  config?: ConfigRepository;
  /**
   * Optional refresh closure — reloads the personality registry from disk
   * before a read so a hot-dropped or edited personality is visible without a
   * server restart. Awaited at the top of `list`/`get`/`characterSheet`.
   * Absent → no refresh (registry state as of last mutation/boot).
   */
  refresh?: () => Promise<void>;
  /**
   * The live `SkillsInjector` from wiring — backs `renderers()`. It resolves
   * against the LOOP's personality registry (a different instance from
   * `personalities` above), which is why `refreshLoopPersonalities` exists.
   * Absent → `renderers()` returns `[]` (tests, onboarding, deployments with
   * no loop).
   */
  skillsInjector?: SkillsInjector;
  /**
   * `CreateAgentLoopResult.refreshPersonalities` — reloads the LOOP registry
   * the injector reads. Awaited in `renderers()` so a personality edited on
   * disk (e.g. a `skills/` dir just created) is seen without a restart.
   */
  refreshLoopPersonalities?: () => Promise<void>;
  /**
   * Lane 6 (D5) — compute the arithmetic model-fit verdict for a personality.
   * A closure over wiring's `resolvePersonalityModelFit` (the service never
   * sees the tool registry or provider config). Absent, resolving `null`, or
   * throwing → the sheet renders without the `## Model fit` section.
   */
  modelFit?: (personalityId: string) => Promise<CharacterSheetModelFit | null>;
  /**
   * tools-as-code-api Lane G — the script-callable surface for the sheet's
   * `Script-callable (run_code)` line. A closure over core's
   * `scriptCallableFor` against the live tool registry (same derivation the
   * ScriptToolBridge enforces). Absent, resolving `null`, or throwing → the
   * sheet renders without the line.
   */
  scriptSurface?: (personalityId: string) => Promise<CharacterSheetScriptSurface | null>;
  /**
   * §4.7 — declared network reach for the sheet's `## Boundary` section. A
   * closure over core's `toolsDeclaringNetwork` against the live tool registry.
   * Absent, resolving `null`, or throwing → the section renders without an
   * inapplicability verdict for reach it cannot see.
   */
  boundary?: (personalityId: string) => Promise<CharacterSheetBoundary | null>;
  /**
   * M-T8 — the resolved `mcp_export` slice for the sheet's `## MCP export`
   * block. A closure over wiring's `resolveMcpExportScope` against the live
   * tool registry: the SAME resolver `ethos mcp serve` runs an exported turn
   * under, so the tab cannot name a tool the export would refuse. Absent,
   * resolving `null`, or throwing → the block still says whether the
   * personality is exported, and says the slice was not resolved here rather
   * than inventing one.
   */
  mcpExport?: (personalityId: string) => Promise<CharacterSheetMcpExport | null>;
  /**
   * M-T9 — the API-key store, read for the MCP export section's Clients table.
   * Only `list` is called. The records carry a hash, never a secret, and the
   * section copies out prefix and label only (`mcpExport`). Absent → no clients.
   */
  apiKeys?: { list(): Promise<ApiKeyRecord[]> };
  /**
   * M-T9 — the Claude Desktop config for `ethos-<id>`, built by the CLI's own
   * `buildExportEntry` and `claudeDesktop` adapter (`claudeDesktopExportEntry`,
   * `apps/ethos/src/commands/mcp-export.ts`) so the web and `ethos mcp install`
   * cannot disagree about its shape. Absent or throwing → no entry.
   */
  mcpExportDesktopEntry?: (
    personalityId: string,
    opts: { bearer: boolean },
  ) => Promise<McpExportDesktopEntryWire>;
  /**
   * M-T9 — `ObservabilityStore.getEvents` over the shared observability.db,
   * read for the section's Recent denials. Absent or throwing → no denials.
   */
  readObservabilityEvents?: (filter: { category: string; limit: number }) => ObsEvent[];
}

/**
 * The five `mcp_export.*` keys the read-only notice names. Checked against the
 * frozen `PersonalityMcpExportConfig` in both directions: `satisfies` refuses a
 * key the type does not have, and `_mcpExportKeysComplete` fails typecheck when
 * the type gains one this list does not name.
 */
const MCP_EXPORT_DECLARATION_KEYS = [
  'enabled',
  'expose_tools',
  'expose_memory',
  'expose_sessions',
  'auth',
] as const satisfies readonly (keyof PersonalityMcpExportConfig)[];
type UnlistedMcpExportKey = Exclude<
  keyof PersonalityMcpExportConfig,
  (typeof MCP_EXPORT_DECLARATION_KEYS)[number]
>;
const _mcpExportKeysComplete: [UnlistedMcpExportKey] extends [never] ? true : never = true;

/** Rows per MCP export table. */
const MCP_EXPORT_RECENT = 20;
/**
 * Events read per `mcp.export.*` category before filtering to this personality.
 *
 * LIMITATION (CLAUDE.md rule 12): `getEvents` filters by category, not by
 * `details.personalityId`, so the filter runs here over the newest
 * `MCP_EXPORT_EVENT_SCAN` rows of each category on the machine. A denial older
 * than that window — pushed out by other exports' traffic — is not shown.
 */
const MCP_EXPORT_EVENT_SCAN = 500;
const MCP_EXPORT_EVENT_KINDS = ['auth', 'discovery', 'call'] as const;

/**
 * `applyExpression`'s answer. A refusal keeps the learning inbox's code so the
 * RPC can map it to the same typed error `learning.approve` returns.
 */
export type ApplyExpressionResult =
  | { ok: true; value: { revisionId: string } }
  | { ok: false; code: LearningRefusalCode; reason: string; action: string };

export class PersonalitiesService {
  constructor(private readonly opts: PersonalitiesServiceOptions) {}

  async list(): Promise<{ items: Personality[]; nextCursor: string | null; defaultId: string }> {
    await this.opts.refresh?.();
    return {
      items: this.opts.personalities.describeAll().map(toWire),
      nextCursor: null,
      defaultId: this.opts.personalities.getDefault().id,
    };
  }

  /**
   * Does this id resolve, after a disk refresh?
   *
   * For validating a reference to a personality where the caller does not want
   * the personality itself — the wake-route editor, which must refuse a route
   * naming nothing rather than let it fail silently in a room later.
   */
  async exists(id: string): Promise<boolean> {
    await this.opts.refresh?.();
    return this.opts.personalities.describe(id) !== null;
  }

  async get(
    id: string,
  ): Promise<{ personality: Personality; soulMd: string; mcpPolicy: McpPolicy | null }> {
    await this.opts.refresh?.();
    const described = this.opts.personalities.describe(id);
    if (!described) throw notFound(id);
    const soulMd = await this.opts.personalities.readSoulMd(id);
    return { personality: toWire(described), soulMd, mcpPolicy: described.mcpPolicy ?? null };
  }

  /**
   * The stored `PersonalityConfig` itself, for a caller that renders a
   * character sheet from a VARIANT of it — the recipes attach preview, which
   * draws the target with the recipe's additions applied. Never returned over
   * the wire (`get` is the wire shape).
   */
  async config(id: string): Promise<PersonalityConfig> {
    await this.opts.refresh?.();
    const described = this.opts.personalities.describe(id);
    if (!described) throw notFound(id);
    return described.config;
  }

  /** Generated Markdown character sheet — the same artifact `ethos personality
   *  show` prints, rendered for the Web Personalities tab. Also returns the
   *  structured `ExecutionPosture` (Phase 2a, lane E1) so the web Execution UI
   *  renders the posture the resolver produced rather than recomputing it. */
  async characterSheet(
    id: string,
  ): Promise<{ markdown: string; posture: ExecutionPosture | null }> {
    await this.opts.refresh?.();
    const described = this.opts.personalities.describe(id);
    if (!described) throw notFound(id);
    const soulMd = await this.opts.personalities.readSoulMd(id);
    // Lane 6 — same computed verdict, same single generator as the CLI
    // (D5: one generator, both surfaces). Fail-soft: a throwing seam renders
    // the sheet without the verdict — the sheet is the RPC's contract.
    let modelFit: CharacterSheetModelFit | undefined;
    if (this.opts.modelFit) {
      try {
        modelFit = (await this.opts.modelFit(id)) ?? undefined;
      } catch {
        modelFit = undefined;
      }
    }
    // Lane G — same fail-soft posture as modelFit: no seam, no line.
    let scriptSurface: CharacterSheetScriptSurface | undefined;
    if (this.opts.scriptSurface) {
      try {
        scriptSurface = (await this.opts.scriptSurface(id)) ?? undefined;
      } catch {
        scriptSurface = undefined;
      }
    }
    // §4.7 — declared network reach for the `## Boundary` section. Same
    // fail-soft posture as the seams above: no seam, no inapplicability claim.
    let boundary: CharacterSheetBoundary | undefined;
    if (this.opts.boundary) {
      try {
        boundary = (await this.opts.boundary(id)) ?? undefined;
      } catch {
        boundary = undefined;
      }
    }
    // M-T8 — the resolved export slice. Same fail-soft posture as the seams
    // above: no seam, no resolved slice, and the block says so.
    let mcpExport: CharacterSheetMcpExport | undefined;
    if (this.opts.mcpExport) {
      try {
        mcpExport = (await this.opts.mcpExport(id)) ?? undefined;
      } catch {
        mcpExport = undefined;
      }
    }
    // skill-declared-renderers Lane E — reuse `renderers()` rather than a second
    // path to the injector, so the sheet's claim and the RPC the web renderer
    // gates on are literally the same call. Already fail-closed to `[]`.
    const { renderers } = await this.renderers(id);
    // Which model a turn on this personality ACTUALLY sends. Until a
    // `modelRegistry` exists the declared `model:` is not honoured at all and
    // the turn runs on the deployment default (`resolveTurnModel`,
    // packages/core/src/agent-loop/turn-model.ts), so the tab printed a model
    // that never executed. Same resolver the CLI `personality show` calls —
    // one generator, one verdict. No config repository (onboarding mode,
    // tests) → the sheet renders as before.
    const raw = (await this.opts.config?.read()) ?? null;
    let routing: CharacterSheetRouting | undefined;
    if (raw?.provider && raw.model) {
      const { resolveActiveLlmName, resolveCharacterSheetRouting } = await import(
        '@ethosagent/wiring'
      );
      routing = resolveCharacterSheetRouting(
        described.config,
        resolveActiveLlmName({ provider: raw.provider, providers: raw.providers }),
        raw.model,
        raw.modelRouting,
      );
    }
    const dataDir = this.opts.dataDir;
    if (!dataDir) {
      return {
        markdown: renderCharacterSheet(
          described.config,
          soulMd,
          undefined,
          modelFit,
          scriptSurface,
          renderers,
          boundary,
          routing,
          mcpExport,
        ),
        posture: null,
      };
    }
    // `execution.ssh.*` — the deployment's single remote execution target. Read
    // from the same file the compose path reads, so the sheet's claim about
    // WHERE this personality executes matches what will actually happen.
    const passthrough = raw?.passthrough ?? {};
    const sshHost = passthrough['execution.ssh.host'];
    const sshUser = passthrough['execution.ssh.user'];
    const sshPortRaw = passthrough['execution.ssh.port'];
    const sshPort =
      sshPortRaw !== undefined && /^\d+$/.test(sshPortRaw) ? Number(sshPortRaw) : undefined;

    // Same posture resolver + renderer the CLI `personality show` uses — one
    // artifact, no second renderer (Phase 2a, lane E1).
    const { buildExecutionPosture, formatSshTarget } = await import('@ethosagent/wiring');
    const posture = await buildExecutionPosture({
      personality: described.config,
      substitutionVars: { ethosHome: dataDir, cwd: process.cwd() },
      ...(this.opts.dockerBuildable === false ? { dockerBuildable: false } : {}),
      sshConfigured: sshHost !== undefined && sshHost.length > 0,
      ...(sshHost
        ? {
            sshTarget: formatSshTarget({
              host: sshHost,
              ...(sshUser ? { user: sshUser } : {}),
              ...(sshPort !== undefined ? { port: sshPort } : {}),
            }),
          }
        : {}),
    });
    return {
      markdown: renderCharacterSheet(
        described.config,
        soulMd,
        { posture },
        modelFit,
        scriptSurface,
        renderers,
        boundary,
        routing,
        mcpExport,
      ),
      posture,
    };
  }

  /**
   * The MCP export section (M-T9): the resolved export slice, the clients that
   * may call it, its recent calls and its recent refusals.
   *
   * Bearer-reachable (`personalities:read`, `SCOPE_MAP` in
   * `middleware/dual-auth.ts`), so it carries NO SECRET: clients are copied out
   * field by field — label and `sk-ethos-XXXXXXXX` prefix — never spread from
   * the store record, and the Desktop entry holds a placeholder where the key
   * goes. Pinned by `personalities-mcp-export.test.ts`.
   *
   * The slice comes from the same `mcpExport` seam the character sheet uses —
   * `resolveMcpExportScope` against the live registry — never a second
   * resolution. Every other source is fail-soft: a missing or throwing seam
   * empties its table rather than failing the section.
   */
  async mcpExport(id: string): Promise<McpExportViewWire> {
    await this.opts.refresh?.();
    const described = this.opts.personalities.describe(id);
    if (!described) throw notFound(id);

    let resolved: CharacterSheetMcpExport | null = null;
    if (this.opts.mcpExport) {
      try {
        resolved = await this.opts.mcpExport(id);
      } catch {
        resolved = null;
      }
    }
    // Without a resolved slice, `enabled` is still the literal-`true` check the
    // resolver itself makes (M-D4) — the character sheet reports it the same way.
    const exported = resolved ? resolved.enabled : described.config.mcp_export?.enabled === true;
    const scope: McpExportScopeViewWire | null =
      resolved?.enabled === true
        ? {
            allowed: [...resolved.allowed],
            dropped: [...resolved.dropped],
            memory: resolved.memory,
            sessions: resolved.sessions,
            auth: resolved.auth,
          }
        : null;

    let desktopEntry: McpExportDesktopEntryWire | null = null;
    if (scope && this.opts.mcpExportDesktopEntry) {
      try {
        desktopEntry = await this.opts.mcpExportDesktopEntry(id, {
          bearer: scope.auth === 'bearer',
        });
      } catch {
        desktopEntry = null;
      }
    }

    let keys: ApiKeyRecord[] = [];
    if (this.opts.apiKeys) {
      try {
        keys = await this.opts.apiKeys.list();
      } catch {
        keys = [];
      }
    }
    // `key-<prefix>` is the clientId `createMcpClientAuthenticator` stamps
    // (`packages/wiring/src/mcp-export.ts`). Revoked keys still name their old
    // calls and denials.
    const nameByClientId = new Map(keys.map((k) => [`key-${k.prefix}`, k.name]));
    const requiredScope = `mcp:${id}`;
    const clients: McpExportClientWire[] = keys
      .filter((k) => !k.revokedAt && k.scopes.includes(requiredScope))
      .map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        createdAt: k.createdAt.toISOString(),
        lastUsed: k.lastUsed ? k.lastUsed.toISOString() : null,
      }));

    // `mcp:<id>:<clientId>:<conversation>` — `exportSessionKey`
    // (`apps/mcp-server/src/export-server.ts`).
    const keyPrefix = `mcp:${id}:`;
    let calls: McpExportCallWire[] = [];
    if (this.opts.sessions) {
      try {
        const rows = await this.opts.sessions.listSessions({
          platform: 'mcp',
          keyPrefix,
          limit: MCP_EXPORT_RECENT,
        });
        calls = rows
          .filter((s) => s.key.startsWith(keyPrefix))
          .map((s) => {
            const clientId = s.key.slice(keyPrefix.length).split(':')[0] || '-';
            return {
              sessionId: s.id,
              updatedAt: s.updatedAt.toISOString(),
              clientId,
              clientName: nameByClientId.get(clientId) ?? null,
              title: s.title ?? null,
              costUsd: s.usage.estimatedCostUsd,
            };
          });
      } catch {
        calls = [];
      }
    }

    const denials: McpExportDenialWire[] = [];
    if (this.opts.readObservabilityEvents) {
      for (const kind of MCP_EXPORT_EVENT_KINDS) {
        let events: ObsEvent[];
        try {
          events = this.opts.readObservabilityEvents({
            category: `mcp.export.${kind}`,
            limit: MCP_EXPORT_EVENT_SCAN,
          });
        } catch {
          events = [];
        }
        // Shape written by `createMcpExportAuditSink`
        // (`apps/ethos/src/commands/mcp-export.ts`): code = wire event,
        // cause = reason code, details = { decision, personalityId, clientId }.
        for (const e of events) {
          const details = e.details ?? {};
          if (details.personalityId !== id || details.decision !== 'denied') continue;
          const clientId = typeof details.clientId === 'string' ? details.clientId : '-';
          denials.push({
            ts: new Date(e.ts).toISOString(),
            kind,
            event: e.code ?? '-',
            clientId,
            clientName: nameByClientId.get(clientId) ?? null,
            reason: e.cause ?? 'unspecified',
          });
        }
      }
      denials.sort((a, b) => b.ts.localeCompare(a.ts));
      denials.splice(MCP_EXPORT_RECENT);
    }

    const soulFile = described.config.soulFile;
    const configFile = soulFile
      ? join(dirname(soulFile), 'config.yaml')
      : join(this.opts.dataDir ?? join(homedir(), '.ethos'), 'personalities', id, 'config.yaml');
    const home = homedir();

    return {
      personalityId: id,
      exported,
      // The stored block, for the section's edit form — see `McpExportDeclarationViewSchema`.
      declaration: described.config.mcp_export ? { ...described.config.mcp_export } : null,
      scope,
      declarationKeys: [...MCP_EXPORT_DECLARATION_KEYS],
      configPath: configFile.startsWith(`${home}/`)
        ? `~${configFile.slice(home.length)}`
        : configFile,
      command: `ethos mcp serve --personality ${id}`,
      desktopEntry,
      clients,
      calls,
      denials,
    };
  }

  async create(input: CreatePersonalityInput): Promise<{ personality: Personality }> {
    const created = await this.opts.personalities.create(input);
    return { personality: toWire(created) };
  }

  async update(id: string, patch: UpdatePersonalityPatch): Promise<{ personality: Personality }> {
    const updated = await this.opts.personalities.update(id, patch);
    return { personality: toWire(updated) };
  }

  /**
   * Write per-server MCP tool subsets into the personality's `mcp.yaml`.
   * `subsets` maps a server name to either an explicit bare-tool-name list
   * (a strict subset) or `null` to clear any prior subset (all tools
   * allowed). Delegates to the registry, which preserves `reject_args`.
   */
  async writeMcpToolSubsets(id: string, subsets: Record<string, string[] | null>): Promise<void> {
    await this.opts.personalities.writeMcpToolSubsets(id, subsets);
  }

  /**
   * Build per-server tool subsets from the editor's `mcp_tools` map and write
   * them. A server with every tool selected is omitted from `mcpTools` by the
   * UI → `null` clears any prior subset back to default-allow.
   */
  async writeMcpToolSubsetsFor(
    id: string,
    servers: string[],
    mcpTools: Record<string, string[]>,
  ): Promise<void> {
    const subsets: Record<string, string[] | null> = {};
    for (const server of servers) {
      subsets[server] = mcpTools[server] ?? null;
    }
    await this.opts.personalities.writeMcpToolSubsets(id, subsets);
  }

  /** Whether a personality's files are read-only built-ins (its tool bindings
   *  must go to the global `toolSettings` fallback, not a `tools.yaml`). */
  isBuiltin(id: string): boolean {
    return this.opts.personalities.describe(id)?.builtin ?? false;
  }

  /** Read a custom personality's own `tools.yaml` bindings (source of truth).
   *  Undefined when the personality has no `tools.yaml`. */
  getToolsConfig(id: string): PersonalityToolsConfig | undefined {
    this.requirePersonality(id);
    return this.opts.personalities.getToolsConfig(id);
  }

  /** Write a custom personality's `tools.yaml` (only a secret NAME, never a
   *  value). Throws for built-ins — their bindings live in the global
   *  `toolSettings` fallback. */
  async writeToolsConfig(id: string, config: PersonalityToolsConfig): Promise<void> {
    this.requirePersonality(id);
    await this.opts.personalities.writeToolsConfig(id, config);
  }

  async delete(id: string): Promise<void> {
    await this.opts.personalities.deletePersonality(id);
  }

  // ---------------------------------------------------------------------------
  // Avatar — thin pass-through to the registry, which owns the directory
  // layout and the mime↔extension mapping. This service's only job is the
  // one thing the registry has no business knowing: the served URL shape.
  // ---------------------------------------------------------------------------

  /** Write (overwrite) a personality's avatar and point `display.avatar_url`
   *  at the serving route. `mimeType` must already be validated by the
   *  caller (the route) against the allowlist. */
  async writeAvatar(
    id: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ avatarUrl: string }> {
    this.requirePersonality(id);
    const avatarUrl = `/api/personalities/${id}/avatar`;
    await this.opts.personalities.writeAvatar(id, bytes, mimeType, avatarUrl);
    return { avatarUrl };
  }

  /** Read a personality's stored avatar bytes + mime type + mtime. Returns
   *  `null` when unset — never throws for "no avatar", since that's the
   *  serving route's clean-404 case, not an error. */
  async readAvatar(
    id: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string; mtimeMs: number } | null> {
    return this.opts.personalities.readAvatar(id);
  }

  /** Delete a personality's stored avatar and clear `display.avatar_url`. */
  async deleteAvatar(id: string): Promise<void> {
    this.requirePersonality(id);
    await this.opts.personalities.deleteAvatar(id);
  }

  async duplicate(id: string, newId: string): Promise<{ personality: Personality }> {
    const created = await this.opts.personalities.duplicate(id, newId);
    return { personality: toWire(created) };
  }

  /**
   * Renderer capabilities the personality's resolved skill set declares
   * (`ethos.renders`). Derived by the live `SkillsInjector` — the same
   * eligibility decision that builds the prompt, so what a personality is
   * TAUGHT and what it may RENDER cannot drift apart.
   *
   * Fail-closed by construction: no injector wired, an unknown personality, or
   * a throwing derivation all yield `[]`, which every surface renders as a
   * plain code block. A chart that appears a beat late is fine; a chart that
   * appears for a personality without the skill is not.
   */
  async renderers(id: string): Promise<{ renderers: string[] }> {
    const injector = this.opts.skillsInjector;
    if (!injector) return { renderers: [] };
    try {
      // Two registries, both refreshed: this service reads its own (to reject an
      // unknown id — `resolveSkills` would otherwise silently fall back to the
      // DEFAULT personality's skills), while the injector closes over the LOOP's.
      // Refreshing the loop's is what makes a freshly installed skills/ dir
      // visible without a restart.
      await this.opts.refresh?.();
      await this.opts.refreshLoopPersonalities?.();
      if (!this.opts.personalities.describe(id)) return { renderers: [] };
      return { renderers: await injector.resolveRenderers(id) };
    } catch {
      return { renderers: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // Per-personality skills (gate 19)
  // ---------------------------------------------------------------------------

  async skillsList(personalityId: string): Promise<{ skills: PersonalitySkill[] }> {
    this.requirePersonality(personalityId);
    const records = await this.opts.library.listPersonalitySkills(personalityId);
    return { skills: records.map(toWirePersonalitySkill) };
  }

  async skillsGet(personalityId: string, skillId: string): Promise<{ skill: PersonalitySkill }> {
    this.requirePersonality(personalityId);
    const skill = await this.opts.library.getPersonalitySkill(personalityId, skillId);
    if (!skill) {
      throw new EthosError({
        code: 'SKILL_NOT_FOUND',
        cause: `Skill "${skillId}" not found for personality "${personalityId}".`,
        action: 'Use personalities.skillsList to see installed skills.',
      });
    }
    return { skill: toWirePersonalitySkill(skill) };
  }

  async skillsCreate(
    personalityId: string,
    skillId: string,
    body: string,
  ): Promise<{ skill: PersonalitySkill }> {
    this.requirePersonality(personalityId);
    const skill = await this.opts.library.createPersonalitySkill(personalityId, skillId, body);
    return { skill: toWirePersonalitySkill(skill) };
  }

  async skillsUpdate(
    personalityId: string,
    skillId: string,
    body: string,
  ): Promise<{ skill: PersonalitySkill }> {
    this.requirePersonality(personalityId);
    const skill = await this.opts.library.updatePersonalitySkill(personalityId, skillId, body);
    return { skill: toWirePersonalitySkill(skill) };
  }

  async skillsDelete(personalityId: string, skillId: string): Promise<void> {
    this.requirePersonality(personalityId);
    await this.opts.library.deletePersonalitySkill(personalityId, skillId);
  }

  async skillsImportGlobal(
    personalityId: string,
    skillIds: string[],
  ): Promise<{ imported: PersonalitySkill[] }> {
    this.requirePersonality(personalityId);
    const records = await this.opts.library.importGlobalIntoPersonality(personalityId, skillIds);
    return { imported: records.map(toWirePersonalitySkill) };
  }

  // ---------------------------------------------------------------------------
  // Pending skill-candidate review queue — a legacy adapter over the learning
  // inbox (plan `trust-before-reach.md` Part 4, L-T8).
  //
  // These three procedures used to read and promote files under
  // `<dataDir>/skills/.pending/<id>/` directly. Every proposal is now a learning
  // candidate, so they list this personality's WAITING SKILL CANDIDATES and
  // decide through `LearningService`. `fileName` is still the file the skill
  // lands as (the destination's basename); a name that matches two waiting
  // candidates is refused rather than guessed.
  //
  // What changed for a caller: `skillCandidateApprove` carries no reason, so it
  // approves only a candidate whose replay passed; any other is refused with
  // `INVALID_INPUT` naming the paths that can carry a reason: `ethos learning
  // approve <id> --override`, and the web Learning page, which approves through
  // `learning.approve` and prompts for one.
  // Approving no longer "treats an existing live file as already promoted" —
  // `promote()` refuses a stale candidate instead of silently dropping it.
  // ---------------------------------------------------------------------------

  async skillCandidatesList(
    personalityId: string,
  ): Promise<{ candidates: Array<{ fileName: string; content: string }> }> {
    this.requirePersonality(personalityId);
    const learning = this.opts.learning;
    if (!learning) return { candidates: [] };
    const waiting = await learning.pendingSkills(personalityId);
    return {
      candidates: waiting.map((c) => ({ fileName: basename(c.destination), content: c.content })),
    };
  }

  async skillCandidateApprove(
    personalityId: string,
    fileName: string,
  ): Promise<{ ok: true; promotedTo: string }> {
    this.requirePersonality(personalityId);
    const learning = this.requireLearning();
    this.assertCandidateFileName(fileName);
    const found = await learning.resolveSkill(fileName, personalityId);
    if (!found.ok) throw learningRefusalError(found, 'Use personalities.skillCandidatesList.');
    const result = await learning.approve({ candidateId: found.value.id, decidedBy: 'web' });
    if (!result.ok) {
      throw learningRefusalError(
        result,
        result.code === 'override_required'
          ? `Approve ${found.value.id} with a reason on the Learning page, or run \`ethos learning approve ${found.value.id} --override "<reason>"\`.`
          : `Run \`ethos learning show ${found.value.id}\` for its timeline.`,
      );
    }
    return { ok: true, promotedTo: result.value.promotion.destination };
  }

  async skillCandidateReject(personalityId: string, fileName: string): Promise<void> {
    this.requirePersonality(personalityId);
    const learning = this.requireLearning();
    this.assertCandidateFileName(fileName);
    const found = await learning.resolveSkill(fileName, personalityId);
    // Idempotent, as before: nothing waiting under that name is already the desired state.
    if (!found.ok && found.code === 'not_found') return;
    if (!found.ok)
      throw learningRefusalError(found, 'Reject it by id: `ethos learning reject <id>`.');
    const result = await learning.reject({ candidateId: found.value.id, decidedBy: 'web' });
    if (!result.ok) throw learningRefusalError(result, 'Reload the candidate list.');
  }

  /** Reject anything that is not a bare `<name>.md` (no path separators, no
   *  `..`) — the wire contract's shape, checked again at the service. */
  private assertCandidateFileName(fileName: string): void {
    if (!/^[a-zA-Z0-9_-]+\.md$/.test(fileName)) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Invalid skill-candidate file name "${fileName}".`,
        action: 'Pass a bare "<name>.md" file name with no path separators.',
      });
    }
  }

  private requireLearning(): LearningService {
    const learning = this.opts.learning;
    if (!learning) {
      throw new EthosError({
        code: 'NOT_CONFIGURED',
        cause: 'The learning inbox is not wired into this server',
        action: 'Start the server with `ethos serve`, which wires the learning inbox.',
      });
    }
    return learning;
  }

  async mcpSetToken(personalityId: string, server: string, token: string): Promise<void> {
    this.requirePersonality(personalityId);
    const described = this.opts.personalities.describe(personalityId);
    if (!described || !(described.config.mcp_servers ?? []).includes(server)) {
      throw new EthosError({
        code: 'MCP_SERVER_NOT_FOUND',
        cause: `Server "${server}" is not attached to personality "${personalityId}".`,
        action: 'Attach the server first via personalities.update, then set the token.',
      });
    }
    if (!this.opts.secrets) {
      throw new EthosError({
        code: 'SECRETS_UNAVAILABLE',
        cause: 'No secrets resolver configured',
        action: 'Configure secrets in web-api startup.',
      });
    }
    const { PersonalityScopedSecrets } = await import('@ethosagent/storage-fs');
    const scoped = new PersonalityScopedSecrets(this.opts.secrets, personalityId);
    await scoped.set(mcpTokenSecretRef(server), token);
    // If the server entry in mcp.json has no bearer auth block, add one now so
    // the McpClient actually sends the Authorization header.
    if (this.opts.mcpJsonStore) {
      const config = await this.opts.mcpJsonStore.get(server);
      if (config && config.auth?.type !== 'bearer') {
        await this.opts.mcpJsonStore.upsert(server, {
          ...config,
          auth: { type: 'bearer' as const },
        });
      }
    }
  }

  async mcpDeleteToken(personalityId: string, server: string): Promise<void> {
    this.requirePersonality(personalityId);
    const described = this.opts.personalities.describe(personalityId);
    if (!described || !(described.config.mcp_servers ?? []).includes(server)) {
      throw new EthosError({
        code: 'MCP_SERVER_NOT_FOUND',
        cause: `Server "${server}" is not attached to personality "${personalityId}".`,
        action: 'Attach the server first via personalities.update, then set the token.',
      });
    }
    if (!this.opts.secrets) {
      throw new EthosError({
        code: 'SECRETS_UNAVAILABLE',
        cause: 'No secrets resolver configured',
        action: 'Configure secrets in web-api startup.',
      });
    }
    const { PersonalityScopedSecrets } = await import('@ethosagent/storage-fs');
    const scoped = new PersonalityScopedSecrets(this.opts.secrets, personalityId);
    await scoped.delete(mcpTokenSecretRef(server));
  }

  // ---------------------------------------------------------------------------
  // Governed learning — Living Soul Expression evolution (Phase 3a)
  // ---------------------------------------------------------------------------

  async livingSoul(id: string): Promise<{
    core: string;
    expression: string;
    learningLog: LearningLogEntry[];
    judge?: JudgeWire;
    nightly?: NightlyWire;
  }> {
    const soul = await this.opts.personalities.readLivingSoul(id);
    const judge = await this.readJudge(id);
    const nightly = await this.readNightly(id);
    return {
      ...soul,
      ...(judge ? { judge } : {}),
      ...(nightly ? { nightly } : {}),
    };
  }

  /**
   * Read the latest Personality-Judge alignment from
   * `<dataDir>/personalities/<id>/.judge-history/state.json`. Tolerant — a
   * missing dir/file, malformed JSON, or an unexpected shape returns null
   * (the `judge` block is then omitted). Never throws; never `as`-casts the
   * untrusted JSON (validates field-by-field, mirroring the digest readers).
   */
  private async readJudge(id: string): Promise<JudgeWire | null> {
    const { storage, dataDir } = this.opts;
    if (!storage || !dataDir) return null;
    const path = join(dataDir, 'personalities', id, '.judge-history', 'state.json');
    const raw = await storage.read(path);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const obj = parsed as Record<string, unknown>;
      const lastResult = obj.lastResult;
      if (!lastResult || typeof lastResult !== 'object') return null;
      const result = lastResult as Record<string, unknown>;
      const alignmentScore = result.alignmentScore;
      if (typeof alignmentScore !== 'number') return null;
      const signal = result.signal;
      const perDimension = Array.isArray(result.perDimension)
        ? result.perDimension.flatMap((d) => {
            if (!d || typeof d !== 'object') return [];
            const dim = d as Record<string, unknown>;
            const score = dim.score;
            // On disk the field is `id` (the dimension key). Surface it as
            // `dimension` for the wire shape.
            const dimension = dim.id ?? dim.dimension;
            if (typeof dimension !== 'string' || typeof score !== 'number') return [];
            return [{ dimension, score }];
          })
        : undefined;
      return {
        alignmentScore,
        signal: signal === 'drift' || signal === 'underspecified_soul' ? signal : null,
        lowStreak: typeof obj.lowStreak === 'number' ? obj.lowStreak : 0,
        ...(typeof obj.at === 'string' ? { at: obj.at } : {}),
        ...(perDimension && perDimension.length > 0 ? { perDimension } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * Read the latest nightly-pass status from
   * `<dataDir>/personalities/<id>/.nightly-state.json`. Tolerant — a missing
   * file, malformed JSON, or an unexpected shape returns null (the `nightly`
   * block is then omitted). Never throws; never `as`-casts the untrusted JSON
   * (validates field-by-field, mirroring `readNightlyState` in @ethosagent/digest).
   */
  private async readNightly(id: string): Promise<NightlyWire | null> {
    const { storage, dataDir } = this.opts;
    if (!storage || !dataDir) return null;
    const path = join(dataDir, 'personalities', id, '.nightly-state.json');
    const raw = await storage.read(path);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const obj = parsed as Record<string, unknown>;
      const windowEnd = obj.windowEnd;
      const completed = obj.completed;
      if (typeof windowEnd !== 'string' || !Array.isArray(completed)) return null;
      const steps: string[] = [];
      for (const c of completed) {
        if (typeof c !== 'string') return null;
        steps.push(c);
      }
      return { windowEnd, completed: steps };
    } catch {
      return null;
    }
  }

  // Path 5 (plan `trust-before-reach.md` Part 4, L-T6). A web draft used to live
  // only in the client, and Apply wrote SOUL.md directly. Now the draft is a
  // learning candidate the moment it is made, and Apply is a human approval of
  // that candidate through `promote()` — so a web change has the same stale
  // check, Learning Log revision and rollback record as every other path.
  async proposeExpression(id: string): Promise<{
    currentExpression: string;
    newExpression: string;
    rationale: string;
    evidence: string;
  }> {
    if (!this.opts.llm) throw llmNotConfigured();
    const evidence = await this.gatherEvidence(id);
    const soul = await this.opts.personalities.readLivingSoul(id);
    const llm = await this.opts.llm();
    const draft = await draftExpressionUpdate(
      { core: soul.core, currentExpression: soul.expression, evidence },
      llm,
    );
    const { storage, dataDir } = this.opts;
    if (storage && dataDir) {
      await submitExpressionCandidate(
        { storage, dataDir, personalities: this.opts.personalities },
        {
          personalityId: id,
          origin: 'web',
          newExpression: draft.newExpression,
          rationale: draft.rationale,
          evidenceRef: `web:${new Date().toISOString()}`,
        },
      );
    }
    return {
      currentExpression: soul.expression,
      newExpression: draft.newExpression,
      rationale: draft.rationale,
      evidence,
    };
  }

  // Apply is a HUMAN APPROVAL of a candidate that has not been replayed, so it
  // goes through `LearningService.approve` like every other approval (L-T8)
  // and needs `overrideReason` — the inbox refuses a non-`pass` approval
  // without one. `summary` is the drafter's rationale and is not a reason.
  //
  // A refusal is RETURNED with the inbox's own code (`stale`,
  // `override_required`, …), not thrown as one envelope code: the RPC maps it
  // with the table `learning.*` uses (`learningRpcError`, `rpc/learning.ts`).
  async applyExpression(
    id: string,
    newExpression: string,
    summary: string,
    evidenceRef: string,
    overrideReason?: string,
  ): Promise<ApplyExpressionResult> {
    const { storage, dataDir } = this.opts;
    if (!storage || !dataDir) throw storageNotConfigured();
    const learning = this.requireLearning();
    const ctx = { storage, dataDir, personalities: this.opts.personalities };
    // The candidate `proposeExpression` submitted for exactly these bytes; an
    // edited draft is a different change, so it becomes its own candidate.
    const waiting = (await listPendingExpressionCandidates(ctx, id)).find(
      (c) => c.origin === 'web' && c.content === newExpression,
    );
    const candidate =
      waiting ??
      (await submitExpressionCandidate(ctx, {
        personalityId: id,
        origin: 'web',
        newExpression,
        rationale: summary,
        evidenceRef,
      }));
    const result = await learning.approve({
      candidateId: candidate.id,
      decidedBy: 'web',
      override: overrideReason ? { reason: overrideReason } : undefined,
    });
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        reason: `Expression not applied: ${result.reason}`,
        action:
          result.code === 'override_required'
            ? `Give a reason (overrideReason) to apply ${candidate.id} anyway, or run \`ethos learning replay ${candidate.id}\` first.`
            : 'Reload the Living Soul and draft the change again.',
      };
    }
    if (result.value.promotion.kind !== 'expression') {
      throw new Error(`applyExpression: candidate ${candidate.id} is not an Expression`);
    }
    return { ok: true, value: { revisionId: result.value.promotion.revisionId } };
  }

  async revertExpression(id: string): Promise<{ ok: true; revertedTo: string }> {
    const soul = await this.opts.personalities.readLivingSoul(id);
    if (soul.learningLog.length === 0) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'Nothing to revert',
        action: 'Evolve the Expression at least once before reverting.',
      });
    }
    const last = soul.learningLog[soul.learningLog.length - 1];
    if (!last) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'Nothing to revert',
        action: 'Evolve the Expression at least once before reverting.',
      });
    }
    await this.opts.personalities.revertExpression(id, last.prevExpressionRef);
    return { ok: true, revertedTo: last.prevExpressionRef };
  }

  async proposeSoulSplit(
    soulMd: string,
  ): Promise<{ core: string; expression: string; rationale: string }> {
    if (!this.opts.llm) throw llmNotConfigured();
    const llm = await this.opts.llm();
    return draftSoulSplit(soulMd, llm);
  }

  /**
   * Build a newest-first digest of recent session interactions for a
   * personality, capped at 20 messages / 4000 chars. Mirrors the CLI's
   * `ethos personality evolve` evidence logic. Returns '' when no session
   * store is wired.
   */
  private async gatherEvidence(id: string): Promise<string> {
    const store = this.opts.sessions;
    if (!store) return '';
    let sessions = await store.listSessions({ personalityId: id });
    if (sessions.length === 0) sessions = await store.listSessions();
    if (sessions.length === 0) return '';
    sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    const MAX_MSGS = 20;
    const MAX_CHARS = 4000;
    const digestLines: string[] = [];
    let totalChars = 0;
    let capped = false;
    for (const s of sessions) {
      if (capped) break;
      const msgs = await store.getMessages(s.id, { limit: 20 });
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m) continue;
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const line = `${m.role}: ${oneLine(m.content)}`;
        if (digestLines.length >= MAX_MSGS || totalChars + line.length > MAX_CHARS) {
          digestLines.push('… [evidence truncated]');
          capped = true;
          break;
        }
        digestLines.push(line);
        totalChars += line.length;
      }
    }
    return digestLines.join('\n');
  }

  private requirePersonality(id: string): void {
    if (!this.opts.personalities.describe(id)) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${id}" not found.`,
        action: 'Use personalities.list to see available ids.',
      });
    }
  }
}

function toWirePersonalitySkill(record: PersonalitySkillRecord): PersonalitySkill {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    body: record.body,
    modifiedAt: record.modifiedAt,
  };
}

function toWire(d: DescribedPersonality): Personality {
  const c = d.config;
  const workdirs = declaredWorkdirs(c);
  return {
    id: c.id,
    name: c.name,
    description: c.description ?? null,
    model: c.model ?? null,
    provider: c.provider ?? null,
    toolset: c.toolset ?? null,
    capabilities: c.capabilities ?? null,
    streamingTimeoutMs: c.streamingTimeoutMs ?? null,
    mcp_servers: c.mcp_servers ?? null,
    plugins: c.plugins ?? null,
    fs_reach: c.fs_reach
      ? {
          read: c.fs_reach.read ?? null,
          write: c.fs_reach.write ?? null,
          // EVERY declared root, in declaration order — not just the first.
          // The web config editor writes back what it was given on every save,
          // so surfacing one entry of several silently collapsed a multi-root
          // personality to a single root the next time anyone pressed Save.
          // `deriveFsReachPaths`'s first-entry-only normalization is a
          // different question (the agent's single `${CWD}`) and stays where
          // it is.
          //
          // `null` rather than `[]` for "declares none", matching every other
          // nullable list on this wire type.
          workdir: workdirs.length > 0 ? workdirs : null,
        }
      : null,
    ...(c.dreaming
      ? {
          dreaming: {
            enable: c.dreaming.enable,
            idleMinutes: c.dreaming.idleMinutes,
            maxPerDay: c.dreaming.maxPerDay,
          },
        }
      : {}),
    ...(c.evolution_approval_mode !== undefined
      ? { evolution_approval_mode: c.evolution_approval_mode }
      : {}),
    ...(c.skill_evolution !== undefined ? { skill_evolution: c.skill_evolution } : {}),
    // Both editable safety sub-keys are echoed back: a sub-key the editor can
    // WRITE but not READ is one a save wipes.
    ...(c.safety?.approvalMode !== undefined || c.safety?.network !== undefined
      ? {
          safety: {
            ...(c.safety.approvalMode !== undefined ? { approvalMode: c.safety.approvalMode } : {}),
            ...(c.safety.network !== undefined ? { network: c.safety.network } : {}),
          },
        }
      : {}),
    ...(c.memory?.provider !== undefined ? { memory: { provider: c.memory.provider } } : {}),
    ...(c.display?.avatar_url !== undefined
      ? { display: { avatar_url: c.display.avatar_url } }
      : {}),
    ...(c.nightly !== undefined ? { nightly: c.nightly } : {}),
    // Every sub-key the editor writes, echoed back so it can populate its form.
    // A sub-key the editor can WRITE but not READ is one a save wipes.
    ...(c.voice !== undefined && Object.keys(c.voice).length > 0
      ? {
          voice: {
            ...(c.voice.tts_provider !== undefined ? { tts_provider: c.voice.tts_provider } : {}),
            ...(c.voice.stt_provider !== undefined ? { stt_provider: c.voice.stt_provider } : {}),
            ...(c.voice.realtime_provider !== undefined
              ? { realtime_provider: c.voice.realtime_provider }
              : {}),
            ...(c.voice.tts_voice !== undefined ? { tts_voice: c.voice.tts_voice } : {}),
            ...(c.voice.call_style !== undefined ? { call_style: c.voice.call_style } : {}),
            ...(c.voice.tier !== undefined ? { tier: c.voice.tier } : {}),
            ...(c.voice.model !== undefined ? { model: c.voice.model } : {}),
            ...(c.voice.languages !== undefined ? { languages: c.voice.languages } : {}),
          },
        }
      : {}),
    system: d.builtin && SYSTEM_PERSONALITY_IDS.has(c.id),
    builtin: d.builtin,
    version: 1,
  };
}

function oneLine(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed;
}

function llmNotConfigured(): EthosError {
  return new EthosError({
    code: 'NOT_CONFIGURED',
    cause: 'LLM not configured for this server',
    action: 'Start the server with a provider configured in ~/.ethos/config.yaml.',
  });
}

function storageNotConfigured(): EthosError {
  return new EthosError({
    code: 'NOT_CONFIGURED',
    cause: 'Storage not configured for this server',
    action: 'Start the server with a data dir + storage wired in.',
  });
}

function notFound(id: string): EthosError {
  return new EthosError({
    code: 'PERSONALITY_NOT_FOUND',
    cause: `Personality "${id}" not found`,
    action: 'Call `personalities.list` to see available IDs.',
  });
}
