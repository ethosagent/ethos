import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import {
  assertSafeId,
  type DreamingConfig,
  EthosError,
  type ModelTierConfig,
  type PersonalityConfig,
  type PersonalityObservabilityConfig,
  type PersonalityRegistry,
  type PersonalitySafetyConfig,
  type Storage,
} from '@ethosagent/types';

export { firstParagraph, renderCharacterSheet } from './character-sheet';

export const SYSTEM_PERSONALITY_IDS: ReadonlySet<string> = new Set([
  'personality-architect',
  'team-architect',
]);

// ---------------------------------------------------------------------------
// YAML parsers — no external dependency, handles the subset we need
// ---------------------------------------------------------------------------

const NESTED_BLOCKS = ['safety'] as const;
type NestedBlockName = (typeof NESTED_BLOCKS)[number];

function parseNestedBlock(
  lines: string[],
  startIdx: number,
): { obj: Record<string, unknown>; endIdx: number } {
  const obj: Record<string, unknown> = {};
  const indent = lines[startIdx]?.match(/^(\s+)/)?.[1]?.length ?? 2;
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.match(/^\s*#/)) {
      i++;
      continue;
    }
    const lineIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (lineIndent < indent) break;
    if (lineIndent === indent) {
      const m = line.match(/^\s+([\w]+):\s*(.*)$/);
      if (m) {
        const key = m[1];
        const val = m[2].trim();
        if (val === '' || val === '{}') {
          const next = lines[i + 1];
          const nextIndent = next?.match(/^(\s+)/)?.[1]?.length ?? 0;
          if (next && nextIndent > indent) {
            const { obj: child, endIdx } = parseNestedBlock(lines, i + 1);
            obj[key] = child;
            i = endIdx;
            continue;
          }
          obj[key] = {};
        } else if (val.startsWith('- ')) {
          const items: string[] = [val.slice(2)];
          let j = i + 1;
          while (j < lines.length) {
            const al = lines[j] ?? '';
            const alTrimmed = al.trim();
            if (!alTrimmed.startsWith('- ')) break;
            items.push(alTrimmed.slice(2).trim());
            j++;
          }
          obj[key] = items;
          i = j;
          continue;
        } else {
          obj[key] = val.replace(/^["']|["']$/g, '');
        }
      }
    }
    i++;
  }
  return { obj, endIdx: i };
}

interface ParsedConfigYaml {
  flat: Record<string, string>;
  nested: Partial<Record<NestedBlockName, Record<string, unknown>>>;
}

function parseConfigYaml(src: string): ParsedConfigYaml {
  const flat: Record<string, string> = {};
  const nested: Partial<Record<NestedBlockName, Record<string, unknown>>> = {};
  const srcLines = src.split('\n');

  // First pass: flat key-value pairs (and detect nested block starts)
  const nestedBlockStartLines = new Set<number>();
  for (let i = 0; i < srcLines.length; i++) {
    const line = srcLines[i] ?? '';

    // Check for top-level nested block declarations
    let foundNested = false;
    for (const block of NESTED_BLOCKS) {
      if (
        line.match(new RegExp(`^${block}:\\s*$`)) ||
        line.match(new RegExp(`^${block}:\\s*\\{\\}`))
      ) {
        const { obj } = parseNestedBlock(srcLines, i + 1);
        nested[block] = obj;
        // Mark lines consumed by the nested block (approximate: mark this start line)
        nestedBlockStartLines.add(i);
        foundNested = true;
        break;
      }
    }
    if (foundNested) continue;

    // Reject non-allowlisted nested blocks
    const nestedKey = line.match(/^(\w+):\s*$/)?.[1];
    if (nestedKey && !NESTED_BLOCKS.includes(nestedKey as NestedBlockName) && !line.match(/^#/)) {
      for (let j = i + 1; j < srcLines.length; j++) {
        const next = srcLines[j] ?? '';
        if (next.trim() === '') continue;
        if (next.match(/^\s+\w+:/)) {
          throw new Error(
            `Top-level key "${nestedKey}" cannot be a nested object in personality config. ` +
              `Only ${NESTED_BLOCKS.join(', ')} may be nested.`,
          );
        }
        break;
      }
    }

    // Allow dotted keys (e.g. `fs_reach.read`) so nested config can land
    // in the flat parser without escaping.
    const m = line.match(/^([\w.]+):\s*(.+)$/);
    if (m) flat[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }

  return { flat, nested };
}

function parseToolsetYaml(src: string): string[] {
  return src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// mcp.yaml parser — handles the subset we need for McpPolicy
// ---------------------------------------------------------------------------

/**
 * Parse `mcp.yaml` into an `McpPolicy`. Expected shape:
 *
 *   servers:
 *     linear:
 *       tools:
 *         - list_issues
 *         - get_issue
 *       reject_args:
 *         save_issue:
 *           status:
 *             - Done
 *     slack:
 *       tools:
 *         - search_public
 */
export function parseMcpYaml(src: string): {
  policy: import('@ethosagent/types').McpPolicy;
  warnings: string[];
} {
  const lines = src.split('\n');
  const policy: import('@ethosagent/types').McpPolicy = {};
  const warnings: string[] = [];

  // Detect tabs anywhere — tabs in YAML are always wrong.
  for (let t = 0; t < lines.length; t++) {
    if ((lines[t] ?? '').includes('\t')) {
      warnings.push(`line ${t + 1}: contains tab character (YAML requires spaces for indentation)`);
    }
  }

  // Find `servers:` top-level key
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (/^servers:\s*$/.test(line)) {
      i++;
      break;
    }
    i++;
  }
  if (i >= lines.length) return { policy, warnings };

  policy.servers = {};

  // Parse each server block (indent level 2)
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || /^\s*#/.test(line)) {
      i++;
      continue;
    }
    const lineIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (lineIndent < 2) break;

    const serverMatch = line.match(/^\s{2}(\w[\w-]*):\s*$/);
    if (!serverMatch) {
      // Non-blank, non-comment line at indent 2 that doesn't match a server name.
      // This is likely a bad indent or structural error — policy is being silently dropped.
      warnings.push(
        `line ${i + 1}: unrecognized line under servers: (expected "  <serverName>:"): ${line.trimEnd()}`,
      );
      i++;
      continue;
    }
    const serverName = serverMatch[1] ?? '';
    const serverPolicy: import('@ethosagent/types').McpServerPolicy = {};
    i++;

    // Parse server sub-keys at indent 4+
    while (i < lines.length) {
      const sline = lines[i] ?? '';
      if (sline.trim() === '' || /^\s*#/.test(sline)) {
        i++;
        continue;
      }
      const sIndent = sline.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (sIndent < 4) break;

      if (/^\s{4}tools:\s*$/.test(sline)) {
        serverPolicy.tools = [];
        i++;
        while (i < lines.length) {
          const tline = lines[i] ?? '';
          if (tline.trim() === '' || /^\s*#/.test(tline)) {
            i++;
            continue;
          }
          const tMatch = tline.match(/^\s{6}-\s+(.+)$/);
          if (!tMatch) break;
          serverPolicy.tools.push((tMatch[1] ?? '').trim());
          i++;
        }
        continue;
      }

      if (/^\s{4}reject_args:\s*$/.test(sline)) {
        serverPolicy.reject_args = {};
        i++;
        while (i < lines.length) {
          const rline = lines[i] ?? '';
          if (rline.trim() === '' || /^\s*#/.test(rline)) {
            i++;
            continue;
          }
          const rIndent = rline.match(/^(\s*)/)?.[1]?.length ?? 0;
          if (rIndent < 6) break;

          const toolMatch = rline.match(/^\s{6}(\w[\w-]*):\s*$/);
          if (!toolMatch) {
            i++;
            continue;
          }
          const toolName = toolMatch[1] ?? '';
          const argRules: Record<string, string[]> = {};
          i++;

          while (i < lines.length) {
            const aline = lines[i] ?? '';
            if (aline.trim() === '' || /^\s*#/.test(aline)) {
              i++;
              continue;
            }
            const aIndent = aline.match(/^(\s*)/)?.[1]?.length ?? 0;
            if (aIndent < 8) break;

            const argMatch = aline.match(/^\s{8}(\w[\w-]*):\s*$/);
            if (!argMatch) {
              i++;
              continue;
            }
            const argName = argMatch[1] ?? '';
            const values: string[] = [];
            i++;

            while (i < lines.length) {
              const vline = lines[i] ?? '';
              if (vline.trim() === '' || /^\s*#/.test(vline)) {
                i++;
                continue;
              }
              const vMatch = vline.match(/^\s{10}-\s+(.+)$/);
              if (!vMatch) break;
              values.push((vMatch[1] ?? '').trim());
              i++;
            }
            argRules[argName] = values;
          }
          serverPolicy.reject_args[toolName] = argRules;
        }
        continue;
      }

      const enabledMatch = sline.match(/^\s{4}enabled:\s*(true|false)\s*$/);
      if (enabledMatch) {
        serverPolicy.enabled = enabledMatch[1] === 'true';
        i++;
        continue;
      }

      // Non-blank, non-comment line at indent 4 that isn't tools: or reject_args:.
      // Unknown key — possible typo; the key's content is silently dropped.
      const unknownKeyMatch = sline.match(/^\s{4}(\w[\w-]*):/);
      const keyName = unknownKeyMatch ? unknownKeyMatch[1] : sline.trim();
      warnings.push(
        `line ${i + 1}: unknown key "${keyName}" under server "${serverName}" (expected "tools", "reject_args", or "enabled")`,
      );
      i++;
    }

    policy.servers[serverName] = serverPolicy;
  }

  return { policy, warnings };
}

/**
 * Serialize an `McpPolicy` back into `mcp.yaml` text — the inverse of
 * `parseMcpYaml`. Round-trips both `tools` and `reject_args` so editing a
 * tool subset never destroys argument-rejection rules.
 *
 * A server with no `tools` and no `reject_args` is still emitted (as a bare
 * `  <name>:` line) so the policy round-trips faithfully. Returns an empty
 * string when the policy has no servers — callers should treat that as
 * "delete the file" or "write nothing".
 */
export function renderMcpYaml(policy: import('@ethosagent/types').McpPolicy): string {
  const servers = policy.servers;
  if (!servers || Object.keys(servers).length === 0) return '';

  const lines: string[] = ['servers:'];
  for (const serverName of Object.keys(servers)) {
    const serverPolicy = servers[serverName] ?? {};
    lines.push(`  ${serverName}:`);
    if (serverPolicy.enabled !== undefined) {
      lines.push(`    enabled: ${serverPolicy.enabled}`);
    }
    if (serverPolicy.tools !== undefined) {
      lines.push('    tools:');
      for (const tool of serverPolicy.tools) {
        lines.push(`      - ${tool}`);
      }
    }
    const rejectArgs = serverPolicy.reject_args;
    if (rejectArgs !== undefined) {
      lines.push('    reject_args:');
      for (const toolName of Object.keys(rejectArgs)) {
        lines.push(`      ${toolName}:`);
        const argRules = rejectArgs[toolName] ?? {};
        for (const argName of Object.keys(argRules)) {
          lines.push(`        ${argName}:`);
          for (const value of argRules[argName] ?? []) {
            lines.push(`          - ${value}`);
          }
        }
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// FilePersonalityRegistry
// ---------------------------------------------------------------------------

export interface DescribedPersonality {
  config: PersonalityConfig;
  /** True if the personality is loaded from the package's bundled data dir
   *  (read-only); false if it lives under the user's writable
   *  `<userPersonalitiesDir>/<id>/`. */
  builtin: boolean;
  /** Per-personality MCP tool policy loaded from mcp.yaml (NOT part of the
   *  frozen PersonalityConfig schema). Undefined when the personality has no
   *  mcp.yaml file. */
  mcpPolicy?: import('@ethosagent/types').McpPolicy;
  /** Warnings from parsing mcp.yaml — present when the file contained
   *  structural problems that caused policy to be silently dropped (e.g.
   *  tab indentation, unknown keys, bad indent). Empty array omitted. */
  mcpWarnings?: string[];
}

export interface CreatePersonalityInput {
  id: string;
  name: string;
  description?: string;
  model?: string | import('@ethosagent/types').ModelTierConfig;
  toolset: string[];
  soulMd: string;
  provider?: string;
  capabilities?: string[];
  mcp_servers?: string[];
  plugins?: string[];
  fs_reach?: { read?: string[]; write?: string[] };
}

export interface UpdatePersonalityPatch {
  name?: string;
  description?: string;
  model?: string | import('@ethosagent/types').ModelTierConfig;
  toolset?: string[];
  soulMd?: string;
  mcp_servers?: string[];
  plugins?: string[];
  capabilities?: string[];
  provider?: string;
  fs_reach?: { read?: string[]; write?: string[] };
}

export class FilePersonalityRegistry implements PersonalityRegistry {
  private readonly personalities = new Map<string, PersonalityConfig>();
  /** Per-personality MCP policy loaded from mcp.yaml (sibling artifact, NOT
   *  on PersonalityConfig). Keyed by personality id. */
  private readonly mcpPolicies = new Map<string, import('@ethosagent/types').McpPolicy>();
  /** Warnings from parsing mcp.yaml, keyed by personality id. */
  private readonly mcpWarningsMap = new Map<string, string[]>();
  // dir → fingerprint of config.yaml + SOUL.md + toolset.yaml + mcp.yaml mtimes
  private readonly fingerprintCache = new Map<string, string>();
  private defaultId = 'researcher';
  private readonly storage: Storage;
  /** Directory holding user-created personalities (mutable). When unset,
   *  CRUD methods (create/update/delete/duplicate) are unavailable. */
  private readonly userDir: string | undefined;

  constructor(storage: Storage = new FsStorage(), userPersonalitiesDir?: string) {
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
    this.mcpWarningsMap.delete(id);
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
    if (entries.length === 0) return;

    await Promise.all(
      entries.map(async (entry) => {
        const personalityDir = join(dir, entry);
        await this.loadOne(personalityDir, entry);
      }),
    );
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

  async create(input: CreatePersonalityInput): Promise<DescribedPersonality> {
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
    await this.storage.write(join(dir, 'config.yaml'), renderConfigYaml(input));
    await this.storage.write(join(dir, 'toolset.yaml'), renderToolsetYaml(input.toolset));
    await this.storage.write(join(dir, 'SOUL.md'), input.soulMd);
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
      patch.mcp_servers !== undefined ||
      patch.plugins !== undefined ||
      patch.capabilities !== undefined ||
      patch.provider !== undefined ||
      patch.fs_reach !== undefined
    ) {
      const config = existing.config;
      if (patch.provider !== undefined && patch.provider !== '') {
        const validProviders = [
          'anthropic',
          'openai',
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
        const allPaths = [...(patch.fs_reach.read ?? []), ...(patch.fs_reach.write ?? [])];
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
      const merged = {
        id: config.id,
        name: patch.name ?? config.name,
        description: patch.description ?? config.description,
        model: patch.model ?? config.model,
        toolset: patch.toolset ?? config.toolset ?? [],
        soulMd: '',
        mcp_servers: patch.mcp_servers ?? config.mcp_servers,
        plugins: patch.plugins ?? config.plugins,
        capabilities: patch.capabilities === undefined ? config.capabilities : patch.capabilities,
        provider: patch.provider === undefined ? config.provider : patch.provider,
        fs_reach: patch.fs_reach === undefined ? config.fs_reach : patch.fs_reach,
      };
      await this.storage.write(join(dir, 'config.yaml'), renderConfigYaml(merged));
    }
    if (patch.toolset !== undefined) {
      await this.storage.write(join(dir, 'toolset.yaml'), renderToolsetYaml(patch.toolset));
    }
    if (patch.soulMd !== undefined) {
      await this.storage.write(join(dir, 'SOUL.md'), patch.soulMd);
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

  async deletePersonality(id: string): Promise<void> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    await this.storage.remove(dir, { recursive: true });
    this.remove(id);
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
    return {
      config,
      builtin,
      ...(mcpPolicy ? { mcpPolicy } : {}),
      ...(mcpWarnings ? { mcpWarnings } : {}),
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

  async loadBuiltins(): Promise<void> {
    // import.meta.dirname is the extensions/personalities/src directory
    const dataDir = join(import.meta.dirname, '..', 'data');
    await this.loadFromDirectory(dataDir);
    // Ensure researcher is the default if present
    if (this.personalities.has('researcher')) this.defaultId = 'researcher';
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async loadOne(dir: string, id: string): Promise<void> {
    // Fingerprint guard — invalidate when any of the three personality files change.
    // mtime alone is enough: filesystems we run on (APFS / ext4 / NTFS) all
    // expose sub-millisecond mtime, so two writes within the same tick
    // is vanishingly unlikely for personality files (humans editing config).
    const fingerprint = await this.fileFingerprint([
      join(dir, 'config.yaml'),
      join(dir, 'SOUL.md'),
      join(dir, 'toolset.yaml'),
      join(dir, 'mcp.yaml'),
    ]);
    if (this.fingerprintCache.get(dir) === fingerprint) return;
    this.fingerprintCache.set(dir, fingerprint);

    const { config, mcpPolicy, mcpWarnings } = await this.buildConfig(dir, id);
    if (config) {
      this.define(config);
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
    }
  }

  private async buildConfig(
    dir: string,
    id: string,
  ): Promise<{
    config: PersonalityConfig | null;
    mcpPolicy?: import('@ethosagent/types').McpPolicy;
    mcpWarnings?: string[];
  }> {
    // Must have at least config.yaml or SOUL.md to be considered a personality
    const [configSrc, toolsetSrc, soulExists, skillsExists, mcpSrc] = await Promise.all([
      this.storage.read(join(dir, 'config.yaml')),
      this.storage.read(join(dir, 'toolset.yaml')),
      this.storage.exists(join(dir, 'SOUL.md')),
      this.storage.exists(join(dir, 'skills')),
      this.storage.read(join(dir, 'mcp.yaml')),
    ]);

    if (!configSrc && !soulExists) return { config: null };

    const parsed = configSrc ? parseConfigYaml(configSrc) : { flat: {}, nested: {} };
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
    // Substitutions (${ETHOS_HOME}, ${self}, ${CWD}) are resolved by
    // the AgentLoop at turn construction time — the registry only
    // surfaces the raw strings.
    const fsReachRead = parseCsv(cfg['fs_reach.read']);
    const fsReachWrite = parseCsv(cfg['fs_reach.write']);
    const fsReach: PersonalityConfig['fs_reach'] | undefined =
      fsReachRead || fsReachWrite
        ? {
            ...(fsReachRead ? { read: fsReachRead } : {}),
            ...(fsReachWrite ? { write: fsReachWrite } : {}),
          }
        : undefined;

    // mcp_servers and plugins are space-separated lists in config.yaml.
    const mcpServers = cfg.mcp_servers ? cfg.mcp_servers.split(/\s+/).filter(Boolean) : undefined;
    const plugins = cfg.plugins ? cfg.plugins.split(/\s+/).filter(Boolean) : undefined;

    const budgetCapUsd =
      cfg.budgetCapUsd && /^\d+(\.\d+)?$/.test(cfg.budgetCapUsd)
        ? Number.parseFloat(cfg.budgetCapUsd)
        : undefined;

    const safety = parsed.nested.safety ? buildSafetyConfig(parsed.nested.safety) : undefined;

    // E5 — context_layering.* dotted keys. Mirrors the fs_reach.* pattern so
    // we don't need a new nested-block parser entry for one-off configs.
    const contextLayering = buildContextLayering(cfg);

    // E4 — context_engine + context_engine_options.* dotted keys.
    const contextEngine = cfg.context_engine || undefined;
    const contextEngineOptions = buildContextEngineOptions(cfg);

    // E3 — skill_evolution.* dotted keys.
    const skillEvolution = buildSkillEvolution(cfg);
    const dreamingConfig = buildDreamingConfig(cfg);
    const memoryConfig = buildMemoryConfig(cfg);
    const mcpExport = buildMcpExportConfig(cfg);
    const outboundPolicy = buildOutboundPolicy(cfg);

    const model = buildModelConfig(cfg);

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
      ...(toolsetSrc ? { toolset: parseToolsetYaml(toolsetSrc) } : {}),
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
      ...(memoryConfig !== undefined ? { memory: memoryConfig } : {}),
      ...(mcpExport !== undefined ? { mcp_export: mcpExport } : {}),
      ...(outboundPolicy !== undefined ? { outbound_policy: outboundPolicy } : {}),
    };

    validateUnsafeCombinations(id, config);
    let mcpPolicy: import('@ethosagent/types').McpPolicy | undefined;
    let mcpWarnings: string[] | undefined;
    if (mcpSrc) {
      const parsed = parseMcpYaml(mcpSrc);
      mcpPolicy = parsed.policy;
      if (parsed.warnings.length > 0) mcpWarnings = parsed.warnings;
    }
    return { config, mcpPolicy, mcpWarnings };
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
// Factory
// ---------------------------------------------------------------------------

export async function createPersonalityRegistry(
  storageOrOpts?: Storage | { storage?: Storage; userPersonalitiesDir?: string },
): Promise<FilePersonalityRegistry> {
  // Backwards-compatible: original signature took a single Storage argument.
  // New callers can pass { storage, userPersonalitiesDir } to enable CRUD.
  let storage: Storage | undefined;
  let userDir: string | undefined;
  if (storageOrOpts && isStorageLike(storageOrOpts)) {
    storage = storageOrOpts;
  } else if (storageOrOpts) {
    storage = storageOrOpts.storage;
    userDir = storageOrOpts.userPersonalitiesDir;
  }
  const registry = new FilePersonalityRegistry(storage, userDir);
  await registry.loadBuiltins();
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

function buildContextLayering(
  cfg: Record<string, string>,
): PersonalityConfig['context_layering'] | undefined {
  const mode = cfg['context_layering.mode'];
  const maxDepth = cfg['context_layering.max_depth'];
  const discovery = cfg['context_layering.discovery_files'];
  const cap = cfg['context_layering.cap_total_chars'];
  if (!mode && !maxDepth && !discovery && !cap) return undefined;
  const out: NonNullable<PersonalityConfig['context_layering']> = {};
  if (mode) {
    if (mode !== 'static' && mode !== 'progressive' && mode !== 'off') {
      throw new Error(
        `Invalid context_layering.mode: "${mode}". Expected one of: static, progressive, off`,
      );
    }
    out.mode = mode;
  }
  if (maxDepth && /^\d+$/.test(maxDepth)) out.max_depth = Number.parseInt(maxDepth, 10);
  if (discovery) {
    const list = discovery
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) out.discovery_files = list;
  }
  if (cap && /^\d+$/.test(cap)) out.cap_total_chars = Number.parseInt(cap, 10);
  return out;
}

function buildSkillEvolution(
  cfg: Record<string, string>,
): PersonalityConfig['skill_evolution'] | undefined {
  const enabled = cfg['skill_evolution.enabled'];
  const minToolCalls = cfg['skill_evolution.min_tool_calls'];
  const cooldown = cfg['skill_evolution.cooldown_minutes'];
  if (!enabled && !minToolCalls && !cooldown) return undefined;
  const out: NonNullable<PersonalityConfig['skill_evolution']> = {};
  if (enabled === 'true') out.enabled = true;
  else if (enabled === 'false') out.enabled = false;
  if (minToolCalls && /^\d+$/.test(minToolCalls)) {
    out.min_tool_calls = Number.parseInt(minToolCalls, 10);
  }
  if (cooldown && /^\d+$/.test(cooldown)) {
    out.cooldown_minutes = Number.parseInt(cooldown, 10);
  }
  return out;
}

function buildDreamingConfig(cfg: Record<string, string>): DreamingConfig | undefined {
  const enable = cfg['dreaming.enable'];
  if (enable !== 'true') return undefined;
  const idleMinutes = cfg['dreaming.idleMinutes'];
  const maxPerDay = cfg['dreaming.maxPerDay'];
  const prompt = cfg['dreaming.prompt'];
  const out: DreamingConfig = {
    enable: true,
    idleMinutes: idleMinutes && /^\d+$/.test(idleMinutes) ? Number.parseInt(idleMinutes, 10) : 60,
    maxPerDay: maxPerDay && /^\d+$/.test(maxPerDay) ? Number.parseInt(maxPerDay, 10) : 1,
  };
  if (prompt) out.prompt = prompt;
  return out;
}

function buildMemoryConfig(
  cfg: Record<string, string>,
): import('@ethosagent/types').PersonalityMemoryConfig | undefined {
  const provider = cfg['memory.provider'];
  if (!provider) return undefined;
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (!key.startsWith('memory.options.')) continue;
    const subKey = key.slice('memory.options.'.length);
    if (subKey.length === 0) continue;
    if (/^-?\d+$/.test(value)) options[subKey] = Number.parseInt(value, 10);
    else if (value === 'true') options[subKey] = true;
    else if (value === 'false') options[subKey] = false;
    else options[subKey] = value;
  }
  return { provider, ...(Object.keys(options).length > 0 ? { options } : {}) };
}

function buildOutboundPolicy(
  cfg: Record<string, string>,
): import('@ethosagent/types').OutboundPolicyConfig | undefined {
  const approve = cfg['outbound_policy.approve_before_send'];
  if (!approve) return undefined;
  const out: import('@ethosagent/types').OutboundPolicyConfig = {
    approve_before_send: approve === 'true',
  };
  const channels = cfg['outbound_policy.channels'];
  if (channels) out.channels = channels.split(/\s+/).filter(Boolean);
  const approver = cfg['outbound_policy.approver_personality'];
  if (approver) out.approver_personality = approver;
  return out;
}

function buildMcpExportConfig(
  cfg: Record<string, string>,
): import('@ethosagent/types').PersonalityMcpExportConfig | undefined {
  const enabled = cfg['mcp_export.enabled'];
  if (!enabled) return undefined;
  const out: import('@ethosagent/types').PersonalityMcpExportConfig = {
    enabled: enabled === 'true',
  };
  const tools = cfg['mcp_export.expose_tools'];
  if (tools === 'all' || tools === 'none') out.expose_tools = tools;
  else if (tools) out.expose_tools = tools.split(/\s+/).filter(Boolean);
  const memory = cfg['mcp_export.expose_memory'];
  if (memory === 'scoped' || memory === 'none' || memory === 'full') out.expose_memory = memory;
  if (cfg['mcp_export.expose_sessions'] === 'true') out.expose_sessions = true;
  if (cfg['mcp_export.expose_sessions'] === 'false') out.expose_sessions = false;
  const auth = cfg['mcp_export.auth'];
  if (auth === 'localhost' || auth === 'bearer') out.auth = auth;
  return out;
}

function buildModelConfig(cfg: Record<string, string>): string | ModelTierConfig | undefined {
  const trivial = cfg['model.trivial'];
  const defaultModel = cfg['model.default'];
  const deep = cfg['model.deep'];
  const dreaming = cfg['model.dreaming'];
  if (!trivial && !defaultModel && !deep && !dreaming) return cfg.model || undefined;
  const out: ModelTierConfig = {};
  if (trivial) out.trivial = trivial;
  if (defaultModel) out.default = defaultModel;
  if (deep) out.deep = deep;
  if (dreaming) out.dreaming = dreaming;
  return out;
}

function buildContextEngineOptions(
  cfg: Record<string, string>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (!key.startsWith('context_engine_options.')) continue;
    const subKey = key.slice('context_engine_options.'.length);
    if (subKey.length === 0) continue;
    if (/^-?\d+$/.test(value)) out[subKey] = Number.parseInt(value, 10);
    else if (/^-?\d+\.\d+$/.test(value)) out[subKey] = Number.parseFloat(value);
    else if (value === 'true') out[subKey] = true;
    else if (value === 'false') out[subKey] = false;
    else out[subKey] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function buildSafetyConfig(raw: Record<string, unknown>): PersonalitySafetyConfig {
  const result: PersonalitySafetyConfig = {};
  const obs = raw.observability as Record<string, unknown> | undefined;
  if (obs) {
    const validStoreValues = ['none', 'redacted', 'full'] as const;
    const validLlmValues = ['none', 'metadata', 'full'] as const;
    const observability: PersonalityObservabilityConfig = {};
    if (obs.storeToolArgs !== undefined) {
      if (!validStoreValues.includes(obs.storeToolArgs as (typeof validStoreValues)[number]))
        throw new Error(`Invalid storeToolArgs: "${obs.storeToolArgs}"`);
      observability.storeToolArgs =
        obs.storeToolArgs as PersonalityObservabilityConfig['storeToolArgs'];
    }
    if (obs.storeToolBodies !== undefined) {
      if (!validStoreValues.includes(obs.storeToolBodies as (typeof validStoreValues)[number]))
        throw new Error(`Invalid storeToolBodies: "${obs.storeToolBodies}"`);
      observability.storeToolBodies =
        obs.storeToolBodies as PersonalityObservabilityConfig['storeToolBodies'];
    }
    if (obs.storeLlmPayloads !== undefined) {
      if (!validLlmValues.includes(obs.storeLlmPayloads as (typeof validLlmValues)[number]))
        throw new Error(`Invalid storeLlmPayloads: "${obs.storeLlmPayloads}"`);
      observability.storeLlmPayloads =
        obs.storeLlmPayloads as PersonalityObservabilityConfig['storeLlmPayloads'];
    }
    if (Array.isArray(obs.redactPatterns)) {
      for (const p of obs.redactPatterns) {
        if (typeof p !== 'string') throw new Error('redactPatterns entries must be strings');
      }
      observability.redactPatterns = obs.redactPatterns as string[];
    }
    result.observability = observability;
  }

  // Ch.4b — approvalMode parsing
  if (raw.approvalMode !== undefined) {
    const mode = raw.approvalMode;
    if (mode !== 'manual' && mode !== 'smart' && mode !== 'off') {
      throw new Error(`Invalid approvalMode: "${mode}". Expected one of: manual, smart, off`);
    }
    result.approvalMode = mode;
  }
  return result;
}

// Ch.4b — load-time refusal of unsafe combinations (v1 floor).
//
// `approvalMode: off` paired with a channel-ingress platform is the
// catastrophic combination — a stranger or allowlisted remote user
// can drive auto-approved destructive actions. We refuse it at config
// load.
//
// **v1 limitation.** This check matches a hardcoded set of platform
// strings on `personality.platform`. A new channel adapter or a
// multi-channel binding wired solely at the gateway layer will not be
// caught here. The plan-tracked v2 lifts this check up to the wiring
// layer (which knows which surfaces actually bind the personality)
// and replaces the string match with a typed "ingress capability"
// flag. Until then, every channel-adapter package adding a new
// platform name is responsible for adding it to the set below — the
// alternative (silent bypass) is the worse failure mode.
const CHANNEL_INGRESS_PLATFORMS: ReadonlySet<string> = new Set([
  'telegram',
  'discord',
  'slack',
  'whatsapp',
  'email',
]);

function validateUnsafeCombinations(id: string, config: PersonalityConfig): void {
  const mode = config.safety?.approvalMode;
  if (mode === 'off' && config.platform && CHANNEL_INGRESS_PLATFORMS.has(config.platform)) {
    throw new Error(
      `personality "${id}" has approvalMode: off but is bound to channel "${config.platform}".\n` +
        '       Remote senders + auto-approve = remote-driven destructive actions.\n' +
        "       Either: (a) move approvalMode to 'smart' or 'manual', or\n" +
        '               (b) remove channel bindings from this personality (cli/cron only).\n' +
        '       This combination is not configurable; it is rejected at config load.',
    );
  }
}

function yamlScalar(value: string): string {
  if (/[:\n\r#[\]{}&*!|>'"%@`]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}

function renderConfigYaml(input: CreatePersonalityInput): string {
  const lines: string[] = [`name: ${yamlScalar(input.name)}`];
  if (input.description) lines.push(`description: ${yamlScalar(input.description)}`);
  if (input.provider) lines.push(`provider: ${yamlScalar(input.provider)}`);
  if (input.model) {
    if (typeof input.model === 'string') {
      lines.push(`model: ${yamlScalar(input.model)}`);
    } else {
      if (input.model.trivial) lines.push(`model.trivial: ${yamlScalar(input.model.trivial)}`);
      if (input.model.default) lines.push(`model.default: ${yamlScalar(input.model.default)}`);
      if (input.model.deep) lines.push(`model.deep: ${yamlScalar(input.model.deep)}`);
      if (input.model.dreaming) lines.push(`model.dreaming: ${yamlScalar(input.model.dreaming)}`);
    }
  }
  if (input.capabilities !== undefined && input.capabilities.length > 0) {
    lines.push(`capabilities: ${input.capabilities.map(yamlScalar).join(', ')}`);
  }
  if (input.mcp_servers !== undefined)
    lines.push(`mcp_servers: ${input.mcp_servers.map(yamlScalar).join(' ')}`);
  if (input.plugins !== undefined)
    lines.push(`plugins: ${input.plugins.map(yamlScalar).join(' ')}`);
  if (input.fs_reach?.read !== undefined && input.fs_reach.read.length > 0) {
    lines.push(`fs_reach.read: ${input.fs_reach.read.join(', ')}`);
  }
  if (input.fs_reach?.write !== undefined && input.fs_reach.write.length > 0) {
    lines.push(`fs_reach.write: ${input.fs_reach.write.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderToolsetYaml(toolset: string[]): string {
  if (toolset.length === 0) return '# No tools enabled — agent runs without external action.\n';
  return `${toolset.map((t) => `- ${t}`).join('\n')}\n`;
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
