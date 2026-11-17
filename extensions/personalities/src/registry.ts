import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  assertSafeId,
  EthosError,
  isSingleEmojiGrapheme,
  type LearningLogEntry,
  type LivingSoul,
  type PersonalityConfig,
  type PersonalityFingerprintSources,
  type PersonalityRegistry,
  parseToolsetYaml,
  renderToolsetYaml,
  type Storage,
} from '@ethosagent/types';
import { withBirthFilingTool, writeBirthMarker } from './birth';
import {
  buildContextEngineOptions,
  buildContextLayering,
  buildDecisionsConfig,
  buildDisplayConfig,
  buildDreamingConfig,
  buildMcpExportConfig,
  buildMemoryConfig,
  buildModelConfig,
  buildNightlyConfig,
  buildOutboundPolicy,
  buildSafetyConfig,
  buildSkillEvolution,
  buildSkillsConfig,
  buildVoiceConfig,
  MCP_EXPORT_TOOL_NAME,
  parseCsv,
  parseExecutionPosture,
  validateUnsafeCombinations,
} from './config-builders';
import { mergeDecisionsConfig, mergeDisplayConfig, mergeVoiceConfig } from './config-merge';
import {
  extractRawSafetyBlock,
  parseConfigYaml,
  type RenderConfigInput,
  renderConfigYaml,
  renderNestedBlock,
  renderSafetySubBlock,
  renderScalarValue,
  subBlockLength,
  yamlScalar,
} from './config-yaml';
import {
  applyExpressionUpdate,
  parseLivingSoul,
  revertExpression as revertExpressionBody,
} from './living-soul';
import { parseMcpYaml, renderMcpYaml } from './mcp-yaml';
import { parseToolsYaml, renderToolsYaml } from './tools-yaml';
import type {
  CreatePersonalityInput,
  DefinitionBytesFile,
  DescribedPersonality,
  PersonalityLoadReport,
  PersonalityToolsConfig,
  UpdatePersonalityPatch,
} from './types';
import { normalizeWorkdir } from './workdirs';

export const SYSTEM_PERSONALITY_IDS: ReadonlySet<string> = new Set([
  'personality-architect',
  'team-architect',
  'debug',
]);

// ---------------------------------------------------------------------------
// Avatar storage — `<personality-dir>/avatar.<ext>`, parallel to SOUL.md /
// config.yaml / toolset.yaml. The extension is always derived from a
// VALIDATED mime type (never a client-supplied filename) so the mapping here
// is the single source of truth both the upload route and the serving route
// key off of.
// ---------------------------------------------------------------------------

/** Allowlisted avatar mime types → the extension `writeAvatar` stores them
 *  under. Anything not in this map is rejected. */
export const AVATAR_MIME_TO_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const AVATAR_EXT_TO_MIME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(AVATAR_MIME_TO_EXT).map(([mime, ext]) => [ext, mime]),
);

/** Matches the one avatar file a personality directory may hold at a time.
 *  Extensions mirror `AVATAR_MIME_TO_EXT`'s values exactly — this module only
 *  ever writes those four. */
const AVATAR_FILENAME_RE = /^avatar\.(png|jpg|webp|gif)$/;

// ---------------------------------------------------------------------------
// FilePersonalityRegistry
// ---------------------------------------------------------------------------

/** sha256 (hex) of a definition file's text — the hash
 *  `writeDefinitionBytes`'s `expectedHash` is compared against. One owner, so a
 *  caller that recorded a hash and the compare-and-swap cannot disagree. */
export function hashDefinitionBytes(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/**
 * Thrown by `FilePersonalityRegistry.writeDefinitionBytes` when the live file's
 * hash is not the `expectedHash` the caller wrote against — someone else
 * changed (or removed) the file since. Nothing was written. `liveHash` is
 * `null` when the file is missing.
 */
export class DefinitionChangedError extends EthosError {
  readonly personalityId: string;
  readonly file: DefinitionBytesFile;
  readonly expectedHash: string;
  readonly liveHash: string | null;

  constructor(opts: {
    personalityId: string;
    file: DefinitionBytesFile;
    expectedHash: string;
    liveHash: string | null;
  }) {
    super({
      code: 'CONFIG_CONFLICT',
      cause: `${opts.file} of personality "${opts.personalityId}" changed since it was read.`,
      action: 'Re-read the file and review the change against its current contents.',
    });
    this.name = 'DefinitionChangedError';
    this.personalityId = opts.personalityId;
    this.file = opts.file;
    this.expectedHash = opts.expectedHash;
    this.liveHash = opts.liveHash;
  }
}

export class FilePersonalityRegistry implements PersonalityRegistry {
  private readonly personalities = new Map<string, PersonalityConfig>();
  /** Per-personality MCP policy loaded from mcp.yaml (sibling artifact, NOT
   *  on PersonalityConfig). Keyed by personality id. */
  private readonly mcpPolicies = new Map<string, import('@ethosagent/types').McpPolicy>();
  /** Warnings from parsing mcp.yaml, keyed by personality id. */
  private readonly mcpWarningsMap = new Map<string, string[]>();
  /** Warnings from parsing config.yaml, keyed by personality id. */
  private readonly configWarningsMap = new Map<string, string[]>();
  /** Per-personality tool config loaded from tools.yaml (source of truth,
   *  sibling artifact — NOT on PersonalityConfig). Keyed by personality id. */
  private readonly toolsConfigs = new Map<string, PersonalityToolsConfig>();
  // dir → mtime fingerprint of the paths `loadOne` lists (the one owner of that list)
  private readonly fingerprintCache = new Map<string, string>();
  /** What the most recent `loadFromDirectory` call found (N3). Replaced whole
   *  per call. A directory the fingerprint fast path skipped contributes
   *  nothing, so a still-broken personality is reported once per content
   *  change, not once per refresh tick. */
  lastLoadReport: PersonalityLoadReport = { failures: [], reloaded: [] };
  private defaultId = 'researcher';
  private readonly storage: Storage;
  /** Directory holding user-created personalities (mutable). When unset,
   *  CRUD methods (create/update/delete/duplicate) are unavailable. */
  private readonly userDir: string | undefined;

  constructor(storage: Storage, userPersonalitiesDir?: string) {
    this.storage = storage;
    this.userDir = userPersonalitiesDir ? join(userPersonalitiesDir, 'personalities') : undefined;
  }

  // -------------------------------------------------------------------------
  // Interface methods
  // -------------------------------------------------------------------------

  define(config: PersonalityConfig): void {
    this.personalities.set(config.id, config);
  }

  get(id: string): PersonalityConfig | undefined {
    return this.personalities.get(id);
  }

  /** Return the McpPolicy loaded from mcp.yaml for the given personality id.
   *  Returns undefined when the personality has no mcp.yaml file. */
  getMcpPolicy(id: string): import('@ethosagent/types').McpPolicy | undefined {
    return this.mcpPolicies.get(id);
  }

  /** Return the tool config loaded from tools.yaml for the given personality
   *  id (the source-of-truth binding). Undefined when the personality has no
   *  tools.yaml file. */
  getToolsConfig(id: string): PersonalityToolsConfig | undefined {
    return this.toolsConfigs.get(id);
  }

  /** See `PersonalityRegistry.getContentFingerprint` (D8). */
  async getContentFingerprint(id: string): Promise<PersonalityFingerprintSources | null> {
    const described = this.describe(id);
    if (!described) return null;
    return readPersonalityFingerprintSources(this.storage, this.dirOf(described));
  }

  list(): PersonalityConfig[] {
    return [...this.personalities.values()];
  }

  getDefault(): PersonalityConfig {
    return (
      this.personalities.get(this.defaultId) ??
      this.personalities.values().next().value ?? {
        id: 'default',
        name: 'Default',
      }
    );
  }

  setDefault(id: string): void {
    if (!this.personalities.has(id)) throw new Error(`Unknown personality: ${id}`);
    this.defaultId = id;
  }

  remove(id: string): void {
    this.personalities.delete(id);
    this.mcpPolicies.delete(id);
    this.mcpWarningsMap.delete(id);
    this.configWarningsMap.delete(id);
    this.toolsConfigs.delete(id);
    // Also drop fingerprint entries for that id's directory so a
    // subsequent re-create with the same id rebuilds cleanly. We
    // don't know the dir from the id alone, so iterate.
    for (const [dir] of this.fingerprintCache) {
      if (dir.endsWith(`/${id}`)) {
        this.fingerprintCache.delete(dir);
        break;
      }
    }
  }

  async loadFromDirectory(dir: string): Promise<void> {
    const entries = await this.storage.list(dir);
    const observed = new Set(entries);

    // Reconcile deletions: drop any personality previously loaded from THIS
    // directory whose sub-directory no longer exists on disk, so a removed
    // personality stops resolving with its stale toolset / fs_reach allowlist /
    // mcp policy. Scoped by parent dir (fingerprint-cache keys ARE the
    // personality dirs) so built-ins loaded from the package data dir are never
    // evicted. Snapshot the keys — remove() mutates the fingerprint cache. This
    // runs even when `entries` is empty, so deleting the LAST personality in a
    // dir collapses the cache correctly rather than leaving stale entries.
    for (const cachedDir of [...this.fingerprintCache.keys()]) {
      if (dirname(cachedDir) === dir && !observed.has(basename(cachedDir))) {
        this.remove(basename(cachedDir));
      }
    }

    // allSettled, not all (N3): one malformed personality directory must not
    // block the others — every successful loadOne is APPLIED before this call
    // settles, whatever its siblings did.
    const warnings: Array<{ id: string; warning: string }> = [];
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        const personalityDir = join(dir, entry);
        return await this.loadOne(personalityDir, entry, (warning) =>
          warnings.push({ id: entry, warning }),
        );
      }),
    );

    const report: PersonalityLoadReport = {
      failures: [],
      reloaded: [],
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    results.forEach((result, i) => {
      const entry = entries[i];
      if (entry === undefined) return;
      if (result.status === 'rejected') {
        const error =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        report.failures.push({ id: entry, dir: join(dir, entry), error });
      } else if (result.value !== null) {
        report.reloaded.push({ id: entry, changed: result.value });
      }
    });
    this.lastLoadReport = report;

    if (report.failures.length > 0) {
      // Still a rejection — deliberately. Every existing caller either treats
      // a personality-load failure as fatal (CLI wiring, `gateway start`
      // first boot, `ethos serve`/`boot`, web-api) or already tolerates a
      // rejection (the gateway refresh's allSettled + the per-turn refresh's
      // swallow), so resolving here would turn fail-closed boots into silent
      // ones nobody reads a report for. The successes above are applied
      // regardless, and `lastLoadReport` survives the throw for callers that
      // catch. (plan ux-feedback-and-config-clarity §4 N3, §9.)
      const detail = report.failures.map((f) => `${f.id}: ${f.error}`).join('; ');
      throw new Error(
        `personalities: ${report.failures.length} of ${entries.length} failed to load — ${detail} (last-good copies still serve)`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // CRUD — only available when `userPersonalitiesDir` was passed to the
  // constructor. Built-ins live in the package's bundled `data/` dir and
  // cannot be modified directly; clone via `duplicate` then edit the copy.
  // -------------------------------------------------------------------------

  /** Absolute path of the user-personality directory, even if it doesn't
   *  exist yet. Throws when no user dir was configured. */
  userPathFor(id: string): string {
    if (!this.userDir) {
      throw new Error(
        'FilePersonalityRegistry: userPathFor() requires a userPersonalitiesDir at construction time.',
      );
    }
    assertSafeId(id, 'personalityId');
    return join(this.userDir, id);
  }

  describe(id: string): DescribedPersonality | null {
    const config = this.personalities.get(id);
    return config ? this.toDescribed(config) : null;
  }

  describeAll(): DescribedPersonality[] {
    return [...this.personalities.values()].map((c) => this.toDescribed(c));
  }

  /**
   * Read the SOUL.md body for a personality. Returns `''` if the
   * personality has no `soulFile` (config-only personalities) or if the
   * file isn't readable.
   */
  async readSoulMd(id: string): Promise<string> {
    const config = this.personalities.get(id);
    if (!config?.soulFile) return '';
    return (await this.storage.read(config.soulFile)) ?? '';
  }

  async readLivingSoul(id: string): Promise<LivingSoul> {
    const body = await this.readSoulMd(id);
    return parseLivingSoul(body);
  }

  async evolveExpression(
    id: string,
    newExpression: string,
    opts: { summary: string; evidenceRef: string },
  ): Promise<{ entry: LearningLogEntry; soul: LivingSoul }> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    const body = (await this.storage.read(join(dir, 'SOUL.md'))) ?? '';
    const current = parseLivingSoul(body);
    const revisionId = `expr-rev-${current.learningLog.length + 1}`;
    const historyDir = join(dir, '.expression-history');
    await this.storage.mkdir(historyDir);
    await this.storage.writeAtomic(join(historyDir, `${revisionId}.md`), current.expression);
    const entry: LearningLogEntry = {
      revisionId,
      at: new Date().toISOString(),
      summary: opts.summary,
      evidenceRef: opts.evidenceRef,
      prevExpressionRef: revisionId,
    };
    const next = applyExpressionUpdate(body, newExpression, entry);
    await this.storage.writeAtomic(join(dir, 'SOUL.md'), next);
    this.fingerprintCache.delete(dir);
    await this.refreshUserDir();
    return { entry, soul: parseLivingSoul(next) };
  }

  /**
   * The Expression text a `revertExpression(id, revisionId)` would restore,
   * or null when there is no such snapshot. For showing the owner exactly what
   * a revert writes before it is confirmed (verification round F3).
   */
  async readExpressionSnapshot(id: string, revisionId: string): Promise<string | null> {
    const dir = this.dirOf(this.requireMutable(id));
    return this.storage.read(join(dir, '.expression-history', `${revisionId}.md`));
  }

  async revertExpression(id: string, revisionId: string): Promise<LivingSoul> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    const priorExpression = await this.readExpressionSnapshot(id, revisionId);
    if (priorExpression === null) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `No expression snapshot "${revisionId}" found for personality "${id}".`,
        action:
          'Run `ethos personality revert <id>` without args to see available revisions, or check the Learning Log.',
      });
    }
    const body = (await this.storage.read(join(dir, 'SOUL.md'))) ?? '';
    const current = parseLivingSoul(body);
    const newRevisionId = `expr-rev-${current.learningLog.length + 1}`;
    const historyDir = join(dir, '.expression-history');
    await this.storage.mkdir(historyDir);
    await this.storage.writeAtomic(join(historyDir, `${newRevisionId}.md`), current.expression);
    const entry: LearningLogEntry = {
      revisionId: newRevisionId,
      at: new Date().toISOString(),
      summary: `reverted to ${revisionId}`,
      evidenceRef: revisionId,
      prevExpressionRef: newRevisionId,
    };
    const next = revertExpressionBody(body, priorExpression, entry);
    await this.storage.writeAtomic(join(dir, 'SOUL.md'), next);
    this.fingerprintCache.delete(dir);
    await this.refreshUserDir();
    return parseLivingSoul(next);
  }

  async listExpressionSnapshots(id: string): Promise<string[]> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    const names = await this.storage.list(join(dir, '.expression-history'));
    const ids = names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -'.md'.length));
    ids.sort((a, b) => expressionRevNumber(b) - expressionRevNumber(a));
    return ids;
  }

  /**
   * `opts.birth` (plan personality-presence-and-initiative §1): set by the
   * operator's create paths — the web create form (`PersonalitiesService.createBorn`,
   * behind the `personalities.create` RPC, apps/web-api/src/rpc/personalities.ts)
   * and `ethos personality create --blank` (`createBlankPersonality`,
   * apps/ethos/src/commands/personality-create.ts). The new personality
   * is born: a birth marker is written and `propose_self_amendment` is listed
   * (`withBirthFilingTool`), so its first private CLI/web conversation runs the
   * birth ritual. Other creators — a recipe install, which ships a designed
   * identity — leave it unset.
   */
  async create(
    input: CreatePersonalityInput,
    opts: { birth?: boolean } = {},
  ): Promise<DescribedPersonality> {
    assertSafeId(input.id, 'personalityId');
    if (this.personalities.get(input.id)) {
      throw new EthosError({
        code: 'PERSONALITY_EXISTS',
        cause: `Personality "${input.id}" already exists.`,
        action: 'Pick a different id, or open the existing one to edit it.',
      });
    }
    const dir = this.userPathFor(input.id);
    await this.storage.mkdir(dir);
    await this.storage.mkdir(join(dir, 'files'));
    // Through `mergeVoiceConfig` even on create, so blank editor fields become
    // "no voice block" rather than `voice.tts_provider: ` lines the loader ignores.
    const voice = input.voice ? mergeVoiceConfig(undefined, input.voice) : undefined;
    await this.storage.write(
      join(dir, 'config.yaml'),
      renderConfigYaml({ ...input, ...(voice ? { voice } : { voice: undefined }) }),
    );
    await this.storage.write(
      join(dir, 'toolset.yaml'),
      renderToolsetYaml(opts.birth ? withBirthFilingTool(input.toolset) : input.toolset),
    );
    await this.storage.write(join(dir, 'SOUL.md'), input.soulMd);
    // A born personality's first private CLI/web conversation runs the birth
    // ritual (`createBirthRitualInjector`, packages/wiring/src/birth-ritual.ts)
    // until an identity amendment is applied or the owner skips it. Only this
    // path writes the marker, and it creates user personalities only.
    // `dir` is `<dataDir>/personalities/<id>` (`userPathFor`).
    if (opts.birth) await writeBirthMarker(this.storage, dirname(dirname(dir)), input.id);
    await this.refreshUserDir();
    const created = this.describe(input.id);
    if (!created) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Created personality "${input.id}" but registry refresh did not pick it up.`,
        action: 'Restart the server to recover.',
      });
    }
    return created;
  }

  async update(id: string, patch: UpdatePersonalityPatch): Promise<DescribedPersonality> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    if (
      patch.name !== undefined ||
      patch.description !== undefined ||
      patch.model !== undefined ||
      patch.skills !== undefined ||
      patch.mcp_servers !== undefined ||
      patch.plugins !== undefined ||
      patch.capabilities !== undefined ||
      patch.provider !== undefined ||
      patch.fs_reach !== undefined ||
      patch.dreaming !== undefined ||
      patch.dreamingEnable !== undefined ||
      patch.evolution_approval_mode !== undefined ||
      patch.skill_evolution !== undefined ||
      patch.safety !== undefined ||
      patch.memory !== undefined ||
      patch.nightly !== undefined ||
      patch.voice !== undefined ||
      patch.display !== undefined ||
      patch.mcp_export !== undefined ||
      patch.decisions !== undefined
    ) {
      const config = existing.config;
      if (patch.provider !== undefined && patch.provider !== '') {
        const validProviders = [
          'anthropic',
          'openai',
          'codex',
          'openrouter',
          'openai-compat',
          'ollama',
          'azure',
        ];
        if (!validProviders.includes(patch.provider)) {
          throw new EthosError({
            code: 'INVALID_INPUT',
            cause: `provider "${patch.provider}" is not a recognized provider. Valid: ${validProviders.join(', ')}.`,
            action: 'Use one of the recognized provider values, or omit to use the engine default.',
          });
        }
      }
      for (const name of patch.skills?.global_ingest?.allow ?? []) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) {
          throw new EthosError({
            code: 'INVALID_INPUT',
            cause: `skills.global_ingest.allow entry "${name.replace(/[\n\r]/g, '\\n')}" is not a plain skill name.`,
            action: 'Use a qualified skill name such as catalog/<id>.',
          });
        }
      }
      if (patch.capabilities !== undefined) {
        for (const tag of patch.capabilities) {
          if (!/^[a-zA-Z0-9_-]+$/.test(tag)) {
            throw new EthosError({
              code: 'INVALID_INPUT',
              cause: `capabilities tag "${tag}" must only contain letters, digits, hyphens, and underscores.`,
              action: 'Fix the tag and retry.',
            });
          }
        }
      }
      if (patch.fs_reach !== undefined) {
        // workdir is validated by the same predicate — it lands in both derived
        // reach lists, so an unchecked one would be a hole straight through this
        // guard. EVERY entry is checked: `workdir` may be a list.
        const allPaths = [
          ...(patch.fs_reach.read ?? []),
          ...(patch.fs_reach.write ?? []),
          ...normalizeWorkdir(patch.fs_reach.workdir),
        ];
        for (const p of allPaths) {
          if (/[\n\r,]/.test(p) || p.includes('\0')) {
            throw new EthosError({
              code: 'INVALID_INPUT',
              cause: `fs_reach entry "${p.replace(/[\n\r]/g, '\\n')}" contains invalid characters (newlines, commas, or null bytes are not allowed).`,
              action: 'Fix the path and retry.',
            });
          }
          const validStart =
            p.startsWith('/') ||
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
            p.startsWith('${ETHOS_HOME}') ||
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
            p.startsWith('${self}') ||
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
            p.startsWith('${CWD}');
          if (!validStart || p.includes('..') || p === '/') {
            throw new EthosError({
              code: 'INVALID_INPUT',
              cause: `fs_reach entry "${p}" must start with "/" or a substitution token (\${ETHOS_HOME}, \${self}, \${CWD}), must not contain "..", and must not be "/".`,
              action: 'Fix the path and retry.',
            });
          }
        }
      }
      const emoji = patch.display?.emoji;
      if (emoji !== undefined && emoji !== '' && !isSingleEmojiGrapheme(emoji)) {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: `display.emoji ${JSON.stringify(emoji.slice(0, 40))} is not a single emoji.`,
          action:
            "Use exactly one emoji (a flag, keycap or ZWJ sequence counts as one), or '' to clear it.",
        });
      }
      const exposeTools = patch.mcp_export?.expose_tools;
      if (Array.isArray(exposeTools)) {
        // Each name lands verbatim on ONE config.yaml line, space-joined, and is
        // read back split on whitespace (`buildMcpExportConfig`). Whitespace
        // would split a name in two; a newline would write a key of the
        // caller's choosing. An empty list would render as an absent key.
        if (exposeTools.length === 0) {
          throw new EthosError({
            code: 'INVALID_INPUT',
            cause: 'mcp_export.expose_tools must name at least one tool when it is a list.',
            action: "Name at least one tool, or use 'none' for a conversation-only export.",
          });
        }
        for (const name of exposeTools) {
          if (!MCP_EXPORT_TOOL_NAME.test(name)) {
            throw new EthosError({
              code: 'INVALID_INPUT',
              cause: `mcp_export.expose_tools entry "${name.replace(/[\n\r]/g, '\\n')}" is not a tool name (letters, digits, _ . : - only).`,
              action: 'Fix the tool name and retry.',
            });
          }
        }
      }
      // Resolve dreaming: a `dreaming` patch is shallow-merged onto the existing
      // block (so a patch carrying only `enable` or only a cadence number keeps
      // its siblings, and vice-versa), defaulting cadence when none exists;
      // otherwise an enable-only toggle merges into the existing cadence;
      // otherwise the existing config is carried through untouched.
      let mergedDreaming = config.dreaming;
      if (patch.dreaming !== undefined) {
        const prev = config.dreaming;
        const prompt = patch.dreaming.prompt ?? prev?.prompt;
        mergedDreaming = {
          enable: patch.dreaming.enable ?? prev?.enable ?? false,
          idleMinutes: patch.dreaming.idleMinutes ?? prev?.idleMinutes ?? 60,
          maxPerDay: patch.dreaming.maxPerDay ?? prev?.maxPerDay ?? 1,
          ...(prompt !== undefined ? { prompt } : {}),
        };
      } else if (patch.dreamingEnable !== undefined) {
        const prev = config.dreaming;
        mergedDreaming = {
          enable: patch.dreamingEnable,
          idleMinutes: prev?.idleMinutes ?? 60,
          maxPerDay: prev?.maxPerDay ?? 1,
          ...(prev?.prompt !== undefined ? { prompt: prev.prompt } : {}),
        };
      }
      // Skill-evolution: shallow-merge the patch onto the existing config so a
      // patch to one knob (e.g. `model`) never drops sibling fields.
      const mergedSkillEvolution =
        patch.skill_evolution === undefined
          ? config.skill_evolution
          : { ...config.skill_evolution, ...patch.skill_evolution };
      // Carry the FULL existing config and overlay only the patched fields,
      // so an update to one field never drops the rest. `id`, `soulFile`, and
      // `skillsDirs` are loader-populated and excluded from config.yaml.
      const { id: _id, soulFile: _soulFile, skillsDirs: _skillsDirs, ...rest } = config;
      const merged: RenderConfigInput = {
        ...rest,
        name: patch.name ?? config.name,
        description: patch.description ?? config.description,
        model: patch.model ?? config.model,
        toolset: patch.toolset ?? config.toolset ?? [],
        mcp_servers: patch.mcp_servers ?? config.mcp_servers,
        plugins: patch.plugins ?? config.plugins,
        capabilities: patch.capabilities === undefined ? config.capabilities : patch.capabilities,
        provider: patch.provider === undefined ? config.provider : patch.provider,
        // Shallow-merged, like `safety` / `memory` / `nightly` / `skill_evolution`
        // below: a patch carrying only `read` and `write` (what the web config
        // editor sends) must not silently drop a hand-declared `workdir`. The
        // whole-object replacements in this block are all scalars or arrays,
        // which have no sub-keys to lose. Pass `workdir: ''` to clear it.
        fs_reach:
          patch.fs_reach === undefined
            ? config.fs_reach
            : { ...config.fs_reach, ...patch.fs_reach },
        // Only `global_ingest.allow` is patchable; mode, deny and the tag
        // lists are carried over from `config.skills` untouched.
        skills:
          patch.skills?.global_ingest?.allow === undefined
            ? config.skills
            : {
                ...config.skills,
                global_ingest: {
                  ...config.skills?.global_ingest,
                  allow: patch.skills.global_ingest.allow,
                },
              },
        dreaming: mergedDreaming,
        evolution_approval_mode: patch.evolution_approval_mode ?? config.evolution_approval_mode,
        skill_evolution: mergedSkillEvolution,
        safety: patch.safety === undefined ? config.safety : { ...config.safety, ...patch.safety },
        memory: patch.memory === undefined ? config.memory : { ...config.memory, ...patch.memory },
        nightly:
          patch.nightly === undefined ? config.nightly : { ...config.nightly, ...patch.nightly },
        voice:
          patch.voice === undefined ? config.voice : mergeVoiceConfig(config.voice, patch.voice),
        display: mergeDisplayConfig(config.display, patch.display),
        mcp_export:
          patch.mcp_export === undefined
            ? config.mcp_export
            : {
                ...config.mcp_export,
                ...patch.mcp_export,
                enabled: patch.mcp_export.enabled ?? config.mcp_export?.enabled ?? false,
              },
        decisions: mergeDecisionsConfig(config.decisions, patch.decisions),
      };
      // renderConfigYaml's safety emission is suppressed here (render with
      // `safety: undefined`) so we append exactly one safety block — never a
      // duplicate (ARCHITECTURE.md §V S7). When `patch.safety` is undefined the
      // verbatim raw block is re-appended, lossless for sub-keys the read path
      // does not parse (network, injectionDefense, …). When `patch.safety` is
      // defined the patched fields are applied key-by-key onto the raw block so
      // the patch wins while those unparseable sub-keys are preserved.
      const rendered = renderConfigYaml({ ...merged, safety: undefined });
      const existingRaw = await this.storage.read(join(dir, 'config.yaml'));
      const rawSafetyBlock = existingRaw ? extractRawSafetyBlock(existingRaw) : '';
      let safetyBlock: string;
      if (patch.safety === undefined) {
        safetyBlock = rawSafetyBlock;
      } else if (rawSafetyBlock) {
        const blockLines = rawSafetyBlock.split('\n');
        for (const [key, value] of Object.entries(patch.safety)) {
          if (value === null) continue;
          const idx = blockLines.findIndex((l) => l.startsWith(`  ${key}:`));
          if (typeof value === 'object') {
            // A nested sub-key (`network`, `injectionDefense`, …) replaces its
            // whole sub-block. This branch used to `continue`, so a patch
            // carrying one was silently dropped whenever a `safety:` block
            // already existed on disk — `safety.network` edited from the web
            // saved without error and changed nothing.
            const replacement = renderSafetySubBlock(key, value as Record<string, unknown>);
            if (idx === -1) blockLines.splice(1, 0, ...replacement);
            else blockLines.splice(idx, subBlockLength(blockLines, idx), ...replacement);
            continue;
          }
          const line = `  ${key}: ${renderScalarValue(value)}`;
          if (idx === -1) blockLines.splice(1, 0, line);
          else blockLines[idx] = line;
        }
        safetyBlock = blockLines.join('\n');
      } else {
        const mergedSafety = merged.safety as Record<string, unknown> | undefined;
        safetyBlock =
          mergedSafety && Object.keys(mergedSafety).length > 0
            ? `safety:\n${renderNestedBlock(mergedSafety, 1).join('\n')}`
            : '';
      }
      const finalConfig = safetyBlock ? `${rendered}${safetyBlock}\n` : rendered;
      await this.storage.writeAtomic(join(dir, 'config.yaml'), finalConfig);
    }
    // Each definition file is replaced with `writeAtomic` (temp file + rename),
    // so a crash or a concurrent reader never sees a torn config.yaml,
    // toolset.yaml or SOUL.md (plan personality-memory-boundary G2-6; pinned by
    // the 'atomic definition writes' cases in update-roundtrip.test.ts).
    // Atomicity is PER FILE. A patch touching two or three of them lands as up
    // to three renames, and a reader between two of them (another process's
    // mtime refresh) sees the new config.yaml beside the old toolset.yaml.
    // That window is a limitation, not closed here; the self-amendment path
    // writes one file per amendment (`writeDefinitionBytes`), so it has none.
    // A rename also replaces a symlinked definition file with a regular file.
    if (patch.toolset !== undefined) {
      await this.storage.writeAtomic(join(dir, 'toolset.yaml'), renderToolsetYaml(patch.toolset));
    }
    if (patch.soulMd !== undefined) {
      await this.storage.writeAtomic(join(dir, 'SOUL.md'), patch.soulMd);
    }
    // Invalidate the mtime-based fingerprint so a rapid second write within
    // the same millisecond is not silently skipped by loadOne's cache guard.
    this.fingerprintCache.delete(dir);
    await this.refreshUserDir();
    const refreshed = this.describe(id);
    if (!refreshed) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Updated personality "${id}" but registry refresh did not pick it up.`,
        action: 'Restart the server to recover.',
      });
    }
    return refreshed;
  }

  /**
   * Replace one definition file with exactly `bytes` — the writer the
   * self-amendment apply and rollback use (plan personality-memory-boundary
   * G2, prereq C). Unlike `update()` nothing is rendered or merged: the bytes a
   * reviewer approved are the bytes written.
   *
   * - Built-ins are refused (`requireMutable`, `PERSONALITY_READ_ONLY`).
   * - With `expectedHash`, a compare-and-swap: the live file is re-read and
   *   hashed (`hashDefinitionBytes`) immediately before the write, and a
   *   mismatch — including a missing file — throws `DefinitionChangedError`
   *   with nothing written. The residual window is the time between that read
   *   and the rename; no Storage method can close it.
   * - The write is `Storage.writeAtomic`, so no reader sees a torn file.
   * - The fingerprint cache entry is dropped before the refresh, so a rewrite
   *   inside the same mtime tick is still re-parsed.
   *
   * Pinned by `write-definition-bytes.test.ts` and the same-tick case in
   * `hot-reload.test.ts`.
   */
  async writeDefinitionBytes(
    id: string,
    file: DefinitionBytesFile,
    bytes: string,
    opts: { expectedHash?: string } = {},
  ): Promise<DescribedPersonality> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    const path = join(dir, file);
    if (opts.expectedHash !== undefined) {
      const live = await this.storage.read(path);
      const liveHash = live === null ? null : hashDefinitionBytes(live);
      if (liveHash !== opts.expectedHash) {
        throw new DefinitionChangedError({
          personalityId: id,
          file,
          expectedHash: opts.expectedHash,
          liveHash,
        });
      }
    }
    await this.storage.writeAtomic(path, bytes);
    this.fingerprintCache.delete(dir);
    await this.refreshUserDir();
    const refreshed = this.describe(id);
    if (!refreshed) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Wrote ${file} for personality "${id}" but registry refresh did not pick it up.`,
        action: 'Restart the server to recover.',
      });
    }
    return refreshed;
  }

  /**
   * Write per-server MCP tool subsets into the personality's `mcp.yaml`.
   *
   * `subsets` maps a server name to its desired `tools` intent:
   *  - `string[]` — write an explicit `tools` list (a strict subset, or an
   *    empty list meaning "no tools allowed").
   *  - `null` — delete any existing `tools` key for that server, restoring
   *    the default-allow ("all tools") semantics.
   *
   * The existing `mcp.yaml` policy is read first; only each named server's
   * `tools` key is touched — `reject_args` and any servers absent from
   * `subsets` are preserved verbatim. A server named in `subsets` that did
   * not previously exist in the policy is created (with `tools` only) so an
   * explicit empty subset can be recorded.
   *
   * Built-in personalities are read-only — this throws for them, mirroring
   * `update()`.
   */
  async writeMcpToolSubsets(id: string, subsets: Record<string, string[] | null>): Promise<void> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);

    // Start from the on-disk policy so reject_args and untouched servers
    // survive the round-trip.
    const current = this.mcpPolicies.get(id);
    const servers: Record<string, import('@ethosagent/types').McpServerPolicy> = {};
    if (current?.servers) {
      for (const [name, policy] of Object.entries(current.servers)) {
        servers[name] = { ...policy };
      }
    }

    for (const [serverName, tools] of Object.entries(subsets)) {
      const prev = servers[serverName] ?? {};
      if (tools === null) {
        // Drop the tools key — but keep the server entry only if it still
        // carries reject_args; otherwise remove it entirely so the policy
        // stays minimal.
        if (prev.reject_args !== undefined || prev.enabled !== undefined) {
          const { tools: _omit, ...rest } = prev;
          servers[serverName] = rest;
        } else {
          delete servers[serverName];
        }
      } else {
        // Replace only the tools key; carry reject_args forward unchanged.
        servers[serverName] = { ...prev, tools: [...tools] };
      }
    }

    const policy: import('@ethosagent/types').McpPolicy =
      Object.keys(servers).length > 0 ? { servers } : {};
    const rendered = renderMcpYaml(policy);
    const mcpPath = join(dir, 'mcp.yaml');
    if (rendered === '') {
      await this.storage.remove(mcpPath).catch(() => {});
    } else {
      await this.storage.writeAtomic(mcpPath, rendered);
    }

    // Invalidate the mtime fingerprint so loadOne re-reads even within the
    // same millisecond, then refresh so getMcpPolicy reflects the write.
    this.fingerprintCache.delete(dir);
    await this.refreshUserDir();
  }

  /**
   * Write the per-personality `tools.yaml` (source of truth for a CUSTOM
   * personality's tool bindings). Only a secret NAME is ever written — never a
   * value (§V S9) — so the directory stays shareable/committable. Built-ins
   * are read-only (`requireMutable` throws); their bindings live in the global
   * `toolSettings` fallback instead. Passing an empty config removes the file.
   */
  async writeToolsConfig(id: string, config: PersonalityToolsConfig): Promise<void> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    const rendered = renderToolsYaml(config);
    const path = join(dir, 'tools.yaml');
    if (rendered === '') {
      await this.storage.remove(path).catch(() => {});
    } else {
      await this.storage.writeAtomic(path, rendered);
    }
    // Invalidate the mtime fingerprint so loadOne re-reads even within the
    // same millisecond, then refresh so getToolsConfig reflects the write.
    this.fingerprintCache.delete(dir);
    await this.refreshUserDir();
  }

  async deletePersonality(id: string): Promise<void> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    await this.storage.remove(dir, { recursive: true });
    this.remove(id);
  }

  /**
   * Write (overwrite) a personality's avatar image and point
   * `display.avatar_url` at `avatarUrl` — the caller (the web-api route)
   * computes that URL, since URL/mount-path shape is an HTTP concern this
   * registry has no business knowing.
   *
   * `mimeType` MUST already be one of `AVATAR_MIME_TO_EXT`'s keys — the
   * caller validates the upload's Content-Type before calling this, but the
   * check is repeated here (throwing `INVALID_INPUT`) so this method is safe
   * to call directly, not just safe behind a route that remembers to check
   * first. The extension is derived from the validated mime type, never from
   * a client-supplied filename, closing the extension-injection hole.
   *
   * At most one `avatar.<ext>` file exists per personality: a re-upload with
   * a DIFFERENT extension than the stored one deletes the stale file first,
   * so switching from a `.png` to a `.webp` avatar doesn't leave both behind.
   * Built-ins are read-only — this throws for them, mirroring `update()`.
   */
  async writeAvatar(
    id: string,
    bytes: Uint8Array,
    mimeType: string,
    avatarUrl: string,
  ): Promise<void> {
    const ext = AVATAR_MIME_TO_EXT[mimeType];
    if (!ext) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Unsupported avatar image type "${mimeType}".`,
        action: `Upload one of: ${Object.keys(AVATAR_MIME_TO_EXT).join(', ')}.`,
      });
    }
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    await this.removeStaleAvatarFiles(dir, ext);
    await this.storage.write(join(dir, `avatar.${ext}`), bytes);
    await this.update(id, { display: { avatar_url: avatarUrl } });
  }

  /**
   * Read a personality's stored avatar bytes, its mime type, and the file's
   * mtime (for the serving route's `ETag`/`Last-Modified`). Returns `null`
   * when there is no `avatar.<ext>` file — including for an unknown id or a
   * built-in — so the route can turn that straight into a clean 404 rather
   * than distinguishing "no such personality" from "no avatar set".
   */
  async readAvatar(
    id: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string; mtimeMs: number } | null> {
    const described = this.describe(id);
    if (!described) return null;
    const dir = this.dirOf(described);
    const entries = await this.storage.list(dir);
    const fileName = entries.find((n) => AVATAR_FILENAME_RE.test(n));
    if (!fileName) return null;
    const path = join(dir, fileName);
    const bytes = await this.storage.readBytes(path);
    if (!bytes) return null;
    const ext = fileName.slice('avatar.'.length);
    const mimeType = AVATAR_EXT_TO_MIME[ext] ?? 'application/octet-stream';
    const mtimeMs = (await this.storage.mtime(path)) ?? 0;
    return { bytes, mimeType, mtimeMs };
  }

  /**
   * Delete a personality's stored avatar file (if any) and clear
   * `display.avatar_url` back to unset. A no-op (not an error) when no
   * avatar was stored. Built-ins are read-only — this throws for them,
   * mirroring `update()` / `deletePersonality()`.
   */
  async deleteAvatar(id: string): Promise<void> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    await this.removeStaleAvatarFiles(dir, null);
    await this.update(id, { display: { avatar_url: '' } });
  }

  /** Remove every `avatar.<ext>` file in `dir` except `keepExt` (`null` keeps
   *  none — used by `deleteAvatar`). Keeps "at most one avatar file per
   *  personality" true across a re-upload with a different extension. */
  private async removeStaleAvatarFiles(dir: string, keepExt: string | null): Promise<void> {
    const entries = await this.storage.list(dir);
    for (const name of entries) {
      const match = AVATAR_FILENAME_RE.exec(name);
      if (!match) continue;
      if (keepExt !== null && match[1] === keepExt) continue;
      await this.storage.remove(join(dir, name));
    }
  }

  /**
   * Copy a built-in (or any other) personality directory into the user
   * dir under a new id. The duplicate's `name:` line is rewritten to
   * "<original> (copy)" so the editor opens with a distinct identity
   * ready to be edited.
   */
  async duplicate(id: string, newId: string): Promise<DescribedPersonality> {
    assertSafeId(newId, 'personalityId');
    if (this.personalities.get(newId)) {
      throw new EthosError({
        code: 'PERSONALITY_EXISTS',
        cause: `Personality "${newId}" already exists.`,
        action: 'Pick a different id for the duplicate.',
      });
    }
    const src = this.personalities.get(id);
    if (!src) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${id}" not found.`,
        action: 'Use list() to see available ids.',
      });
    }
    const sourceDir = src.soulFile
      ? src.soulFile.replace(/\/SOUL\.md$/, '')
      : src.skillsDirs?.[0]?.replace(/\/skills$/, '');
    if (!sourceDir) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Personality "${id}" has no resolvable source directory to copy.`,
        action: 'Edit the source manually, or pick a different built-in.',
      });
    }
    const destDir = this.userPathFor(newId);
    if (!this.userDir) throw new Error('userDir undefined after userPathFor() call');
    await this.storage.mkdir(this.userDir);
    await copyTree(this.storage, sourceDir, destDir);
    await this.storage.mkdir(join(destDir, 'files'));
    await this.bumpDuplicateName(destDir, newId, src.name);
    await this.refreshUserDir();
    const created = this.describe(newId);
    if (!created) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Duplicated "${id}" → "${newId}" but registry refresh did not pick it up.`,
        action: 'Restart the server to recover.',
      });
    }
    return created;
  }

  // -------------------------------------------------------------------------
  // CRUD internals
  // -------------------------------------------------------------------------

  private requireMutable(id: string): DescribedPersonality {
    const existing = this.describe(id);
    if (!existing) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${id}" not found.`,
        action: 'Use list() to see available ids.',
      });
    }
    if (existing.builtin) {
      throw new EthosError({
        code: 'PERSONALITY_READ_ONLY',
        cause: `Personality "${id}" is built-in and cannot be modified directly.`,
        action: 'Duplicate it via duplicate(), then edit the copy.',
      });
    }
    return existing;
  }

  private toDescribed(config: PersonalityConfig): DescribedPersonality {
    const soulFile = config.soulFile;
    const userPrefix = this.userDir ? `${this.userDir}/` : null;
    const builtin = userPrefix && soulFile ? !soulFile.startsWith(userPrefix) : true;
    const mcpPolicy = this.mcpPolicies.get(config.id);
    const mcpWarnings = this.mcpWarningsMap.get(config.id);
    const configWarnings = this.configWarningsMap.get(config.id);
    return {
      config,
      builtin,
      ...(mcpPolicy ? { mcpPolicy } : {}),
      ...(mcpWarnings ? { mcpWarnings } : {}),
      ...(configWarnings ? { configWarnings } : {}),
    };
  }

  private dirOf(p: DescribedPersonality): string {
    const soulFile = p.config.soulFile;
    if (soulFile) return soulFile.replace(/\/SOUL\.md$/, '');
    return this.userPathFor(p.config.id);
  }

  private async refreshUserDir(): Promise<void> {
    if (!this.userDir) return;
    await this.loadFromDirectory(this.userDir);
  }

  private async bumpDuplicateName(
    dir: string,
    newId: string,
    sourceName: string | undefined,
  ): Promise<void> {
    const path = join(dir, 'config.yaml');
    const raw = await this.storage.read(path);
    if (raw === null) return;
    const newName = sourceName ? `${sourceName} (copy)` : newId;
    const lines = raw.split('\n');
    let nameSet = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^name:\s*/.test(lines[i] ?? '')) {
        lines[i] = `name: ${yamlScalar(newName)}`;
        nameSet = true;
        break;
      }
    }
    if (!nameSet) lines.unshift(`name: ${yamlScalar(newName)}`);
    await this.storage.write(path, lines.join('\n'));
  }

  // -------------------------------------------------------------------------
  // Built-in loader
  // -------------------------------------------------------------------------

  /**
   * Loads built-in personalities. `dir`, when supplied, overrides the default
   * location — used by callers (e.g. the desktop app's bundled main process)
   * where `import.meta.dirname` no longer points at the source tree after
   * bundling. Omitted, this is byte-identical to the original hardcoded path.
   */
  async loadBuiltins(dir?: string): Promise<void> {
    // import.meta.dirname is the extensions/personalities/src directory
    const dataDir = dir ?? join(import.meta.dirname, '..', 'data');
    await this.loadFromDirectory(dataDir);
    // Ensure researcher is the default if present
    if (this.personalities.has('researcher')) this.defaultId = 'researcher';
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Returns the changed fingerprint inputs (file basenames) when this call
   * RELOADED a directory already fingerprinted, `null` on a first sight or a
   * no-change fast path — `loadFromDirectory` turns that into the
   * `lastLoadReport.reloaded` entries (N3). `onWarning` receives each
   * config.yaml value this parse dropped (`lastLoadReport.warnings`).
   */
  private async loadOne(
    dir: string,
    id: string,
    onWarning: (warning: string) => void,
  ): Promise<string[] | null> {
    // Fingerprint guard — invalidate when any of the personality's inputs change.
    // mtime alone is enough: filesystems we run on (APFS / ext4 / NTFS) all
    // expose sub-millisecond mtime, so two writes within the same tick
    // is vanishingly unlikely for personality files (humans editing config).
    // `skills/` is a DIRECTORY, and it is fingerprinted because `buildConfig`
    // derives `skillsDirs` from its existence — without it, installing the
    // first skill into a personality that had no `skills/` dir would never be
    // seen until the process restarted.
    const paths = [
      join(dir, 'config.yaml'),
      join(dir, 'SOUL.md'),
      join(dir, 'toolset.yaml'),
      join(dir, 'mcp.yaml'),
      join(dir, 'tools.yaml'),
      join(dir, 'skills'),
    ];
    const fingerprint = await this.fileFingerprint(paths);
    const previous = this.fingerprintCache.get(dir);
    if (previous === fingerprint) return null;
    // Set BEFORE buildConfig on purpose: a directory whose parse throws is
    // retried only when its content changes again, so a broken personality
    // costs one failed parse (and one report entry) per edit, not one per
    // refresh tick — and the last-good copy keeps serving meanwhile.
    this.fingerprintCache.set(dir, fingerprint);
    const changed =
      previous === undefined
        ? null
        : diffFingerprint(
            previous,
            fingerprint,
            paths.map((p) => basename(p)),
          );

    const { config, mcpPolicy, mcpWarnings, configWarnings, toolsConfig } = await this.buildConfig(
      dir,
      id,
    );
    if (config) {
      this.define(config);
      if (configWarnings) {
        this.configWarningsMap.set(id, configWarnings);
        for (const warning of configWarnings) onWarning(warning);
      } else {
        this.configWarningsMap.delete(id);
      }
      if (mcpPolicy) {
        this.mcpPolicies.set(id, mcpPolicy);
      } else {
        this.mcpPolicies.delete(id);
      }
      if (mcpWarnings) {
        this.mcpWarningsMap.set(id, mcpWarnings);
      } else {
        this.mcpWarningsMap.delete(id);
      }
      if (toolsConfig) {
        this.toolsConfigs.set(id, toolsConfig);
      } else {
        this.toolsConfigs.delete(id);
      }
    }
    return changed;
  }

  private async buildConfig(
    dir: string,
    id: string,
  ): Promise<{
    config: PersonalityConfig | null;
    mcpPolicy?: import('@ethosagent/types').McpPolicy;
    mcpWarnings?: string[];
    configWarnings?: string[];
    toolsConfig?: PersonalityToolsConfig;
  }> {
    // Must have at least config.yaml or SOUL.md to be considered a personality
    const [configSrc, toolsetSrc, soulExists, skillsExists, mcpSrc, toolsSrc] = await Promise.all([
      this.storage.read(join(dir, 'config.yaml')),
      this.storage.read(join(dir, 'toolset.yaml')),
      this.storage.exists(join(dir, 'SOUL.md')),
      this.storage.exists(join(dir, 'skills')),
      this.storage.read(join(dir, 'mcp.yaml')),
      this.storage.read(join(dir, 'tools.yaml')),
    ]);

    if (!configSrc && !soulExists) return { config: null };

    const parsed = configSrc
      ? withSourceFile('config.yaml', () => parseConfigYaml(configSrc))
      : { flat: {}, nested: {} };
    const cfg = parsed.flat;

    const capabilities = cfg.capabilities
      ? cfg.capabilities
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const streamingTimeoutMs =
      cfg.streamingTimeoutMs && /^\d+$/.test(cfg.streamingTimeoutMs)
        ? Number.parseInt(cfg.streamingTimeoutMs, 10)
        : undefined;

    // fs_reach.read / fs_reach.write are comma-separated path lists.
    // fs_reach.workdir is the same comma-separated form: ONE path stays a bare
    // string (the shape every existing config.yaml and every single-root
    // consumer expects), several become a list — each one its own Documents
    // root. Substitutions (${ETHOS_HOME}, ${self}, ${CWD}) are resolved by the
    // AgentLoop at turn construction time — the registry only surfaces the raw
    // strings.
    const fsReachRead = parseCsv(cfg['fs_reach.read']);
    const fsReachWrite = parseCsv(cfg['fs_reach.write']);
    const workdirs = parseCsv(cfg['fs_reach.workdir']);
    const fsReachWorkdir: string | string[] | undefined =
      workdirs === undefined ? undefined : workdirs.length === 1 ? workdirs[0] : workdirs;
    const fsReach: PersonalityConfig['fs_reach'] | undefined =
      fsReachRead || fsReachWrite || fsReachWorkdir
        ? {
            ...(fsReachRead ? { read: fsReachRead } : {}),
            ...(fsReachWrite ? { write: fsReachWrite } : {}),
            ...(fsReachWorkdir ? { workdir: fsReachWorkdir } : {}),
          }
        : undefined;

    // mcp_servers and plugins are space-separated lists in config.yaml.
    const mcpServers = cfg.mcp_servers ? cfg.mcp_servers.split(/\s+/).filter(Boolean) : undefined;
    const plugins = cfg.plugins ? cfg.plugins.split(/\s+/).filter(Boolean) : undefined;

    const budgetCapUsd =
      cfg.budgetCapUsd && /^\d+(\.\d+)?$/.test(cfg.budgetCapUsd)
        ? Number.parseFloat(cfg.budgetCapUsd)
        : undefined;

    const safetyBlock = parsed.nested.safety;
    const safety = safetyBlock
      ? withSourceFile('config.yaml', () => buildSafetyConfig(safetyBlock))
      : undefined;

    // E5 — context_layering.* dotted keys. Mirrors the fs_reach.* pattern so
    // we don't need a new nested-block parser entry for one-off configs.
    const contextLayering = buildContextLayering(cfg);

    // E4 — context_engine + context_engine_options.* dotted keys.
    const contextEngine = cfg.context_engine || undefined;
    const evolutionApprovalMode =
      cfg.evolution_approval_mode === 'auto' || cfg.evolution_approval_mode === 'user'
        ? cfg.evolution_approval_mode
        : undefined;
    const contextEngineOptions = buildContextEngineOptions(cfg);

    // E3 — skill_evolution.* dotted keys.
    const skillEvolution = buildSkillEvolution(cfg);
    const dreamingConfig = buildDreamingConfig(cfg);
    const nightlyConfig = buildNightlyConfig(cfg);
    const memoryConfig = buildMemoryConfig(cfg);
    const mcpExport = buildMcpExportConfig(cfg);
    const skills = buildSkillsConfig(cfg);
    const outboundPolicy = buildOutboundPolicy(cfg);
    const voice = buildVoiceConfig(cfg);
    const configWarnings: string[] = [];
    const display = buildDisplayConfig(cfg, configWarnings);
    const decisions = buildDecisionsConfig(cfg);
    const execution = parseExecutionPosture(cfg.execution);

    const model = buildModelConfig(cfg);

    const toolset = toolsetSrc
      ? withSourceFile('toolset.yaml', () => parseToolsetYaml(toolsetSrc))
      : undefined;

    const config: PersonalityConfig = {
      id,
      name: cfg.name ?? titleCase(id),
      description: cfg.description,
      model,
      provider: cfg.provider,
      platform: cfg.platform,
      ...(capabilities?.length ? { capabilities } : {}),
      soulFile: join(dir, 'SOUL.md'),
      ...(skillsExists ? { skillsDirs: [join(dir, 'skills')] } : {}),
      ...(toolset ? { toolset } : {}),
      ...(streamingTimeoutMs !== undefined ? { streamingTimeoutMs } : {}),
      ...(fsReach ? { fs_reach: fsReach } : {}),
      ...(mcpServers !== undefined ? { mcp_servers: mcpServers } : {}),
      ...(plugins !== undefined ? { plugins } : {}),
      ...(budgetCapUsd !== undefined ? { budgetCapUsd } : {}),
      ...(safety !== undefined ? { safety } : {}),
      ...(contextLayering !== undefined ? { context_layering: contextLayering } : {}),
      ...(contextEngine !== undefined ? { context_engine: contextEngine } : {}),
      ...(contextEngineOptions !== undefined
        ? { context_engine_options: contextEngineOptions }
        : {}),
      ...(skillEvolution !== undefined ? { skill_evolution: skillEvolution } : {}),
      ...(dreamingConfig !== undefined ? { dreaming: dreamingConfig } : {}),
      ...(nightlyConfig !== undefined ? { nightly: nightlyConfig } : {}),
      ...(memoryConfig !== undefined ? { memory: memoryConfig } : {}),
      ...(mcpExport !== undefined ? { mcp_export: mcpExport } : {}),
      ...(skills !== undefined ? { skills } : {}),
      ...(outboundPolicy !== undefined ? { outbound_policy: outboundPolicy } : {}),
      ...(evolutionApprovalMode !== undefined
        ? { evolution_approval_mode: evolutionApprovalMode }
        : {}),
      ...(voice !== undefined ? { voice } : {}),
      ...(display !== undefined ? { display } : {}),
      ...(execution !== undefined ? { execution } : {}),
      ...(decisions !== undefined ? { decisions } : {}),
    };

    withSourceFile('config.yaml', () => validateUnsafeCombinations(id, config));
    let mcpPolicy: import('@ethosagent/types').McpPolicy | undefined;
    let mcpWarnings: string[] | undefined;
    if (mcpSrc) {
      const parsed = parseMcpYaml(mcpSrc);
      mcpPolicy = parsed.policy;
      if (parsed.warnings.length > 0) mcpWarnings = parsed.warnings;
    }
    let toolsConfig: PersonalityToolsConfig | undefined;
    if (toolsSrc) {
      const parsed = parseToolsYaml(toolsSrc);
      // Key-count, NOT a roster: this guard was once a hand-written
      // `parsed.web_search || parsed.x_search || ...` chain, and `search_console`
      // was added to `TOOLS_YAML_KEYS` (and to parse/render) without being added
      // here — so a tools.yaml carrying only that binding parsed correctly and
      // was then silently discarded. It was then roster-driven, which had the
      // same failure one layer out: a preserved key outside the typed roster is
      // a real binding and would have been dropped here after parse kept it.
      // `parseToolsYaml` only sets a key when it holds a real field, so "any key
      // present" IS "any binding at all". An empty parse stays `undefined`
      // rather than `{}`: `getToolsConfig` documents undefined as "no bindings",
      // and it is what the unsafe-secret tests below assert.
      if (Object.keys(parsed).length > 0) {
        toolsConfig = parsed;
      }
    }
    return {
      config,
      mcpPolicy,
      mcpWarnings,
      ...(configWarnings.length > 0 ? { configWarnings } : {}),
      toolsConfig,
    };
  }

  private async fileFingerprint(paths: string[]): Promise<string> {
    const parts = await Promise.all(
      paths.map(async (p) => {
        const t = await this.storage.mtime(p);
        return t === null ? 'missing' : String(t);
      }),
    );
    return parts.join('|');
  }
}

// ---------------------------------------------------------------------------
// Content fingerprint (model-visible ⟺ logged, Phase B, D8)
// ---------------------------------------------------------------------------

/**
 * Read the six-path personality fingerprint inputs (D8) for content hashing
 * — distinct from `fileFingerprint` above, which is mtime-based and only
 * decides whether the registry should re-read a personality. Content hashing
 * is genuinely new work, not a rename of what's already there (see
 * plan/phases/model-visible-logged.md, "Repo areas touched").
 *
 * Exported as a free function, and also wrapped by
 * `FilePersonalityRegistry.getContentFingerprint` (the `PersonalityRegistry`
 * interface method). `packages/core` cannot import this package directly
 * (ARCHITECTURE.md layer direction — core does not depend on extensions), so
 * `context-assembly.ts` reaches this through the interface method on the
 * `PersonalityRegistry` it already holds, never through this export.
 *
 * `skills/` is reported as presence only (`skillsDirPresent`), never its
 * contents — hashing a directory's full contents is out of v1 scope (D8).
 */
export async function readPersonalityFingerprintSources(
  storage: Storage,
  dir: string,
): Promise<PersonalityFingerprintSources> {
  const [configSrc, soulSrc, toolsetSrc, mcpSrc, toolsSrc, skillsDirPresent] = await Promise.all([
    storage.read(join(dir, 'config.yaml')),
    storage.read(join(dir, 'SOUL.md')),
    storage.read(join(dir, 'toolset.yaml')),
    storage.read(join(dir, 'mcp.yaml')),
    storage.read(join(dir, 'tools.yaml')),
    storage.exists(join(dir, 'skills')),
  ]);
  return { soulSrc, configSrc, toolsetSrc, mcpSrc, toolsSrc, skillsDirPresent };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createPersonalityRegistry(
  storageOrOpts:
    | Storage
    | { storage: Storage; userPersonalitiesDir?: string; builtinPersonalitiesDir?: string },
): Promise<FilePersonalityRegistry> {
  // Two accepted shapes: a bare Storage, or { storage, userPersonalitiesDir }
  // to enable CRUD. Storage is required either way — the composition root
  // injects it; the registry never falls back to raw disk.
  //
  // `builtinPersonalitiesDir` overrides where built-ins load from — needed by
  // bundled callers (e.g. desktop's main process after electron-vite) where
  // `import.meta.dirname` no longer resolves to the source tree. Omitted,
  // this is byte-identical to the pre-existing default `loadBuiltins()` path.
  let storage: Storage;
  let userDir: string | undefined;
  let builtinPersonalitiesDir: string | undefined;
  if (isStorageLike(storageOrOpts)) {
    storage = storageOrOpts;
  } else {
    storage = storageOrOpts.storage;
    userDir = storageOrOpts.userPersonalitiesDir;
    builtinPersonalitiesDir = storageOrOpts.builtinPersonalitiesDir;
  }
  const registry = new FilePersonalityRegistry(storage, userDir);
  await registry.loadBuiltins(builtinPersonalitiesDir);
  return registry;
}

function isStorageLike(v: unknown): v is Storage {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { read?: unknown }).read === 'function' &&
    typeof (v as { write?: unknown }).write === 'function'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function expressionRevNumber(s: string): number {
  const m = /(\d+)$/.exec(s);
  return m ? Number.parseInt(m[1], 10) : 0;
}

/**
 * Which fingerprint components differ between two `fileFingerprint` values —
 * the fingerprint is per-path mtimes joined with `|` in `names` order, so an
 * index-wise diff names exactly the inputs that moved (N3's
 * `reloaded (SOUL.md changed)` lines).
 */
function diffFingerprint(previous: string, next: string, names: string[]): string[] {
  const a = previous.split('|');
  const b = next.split('|');
  const changed: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (name && a[i] !== b[i]) changed.push(name);
  }
  return changed;
}

/**
 * Re-throw `fn`'s error with the source file named, so a load failure in
 * `lastLoadReport` reads `config.yaml: …` instead of a bare message with no
 * home (N3). The parsers here carry no line numbers, so file-level attribution
 * is the limit of what this can honestly claim.
 */
function withSourceFile<T>(file: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg.startsWith(`${file}:`) ? msg : `${file}: ${msg}`);
  }
}

async function copyTree(storage: Storage, source: string, dest: string): Promise<void> {
  await storage.mkdir(dest);
  const entries = await storage.listEntries(source);
  for (const entry of entries) {
    const sp = join(source, entry.name);
    const dp = join(dest, entry.name);
    if (entry.isDir) {
      await copyTree(storage, sp, dp);
    } else {
      const content = await storage.read(sp);
      if (content !== null) await storage.write(dp, content);
    }
  }
}
