import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  draftPluginGrant,
  type InstalledPluginManifest,
  isValidNpmPackageName,
  isValidPluginId,
  type PluginLoader,
  pinPluginToPersonality,
  recordGrant,
  scanInstalledPlugins,
  scanPluginPackage,
} from '@ethosagent/plugin-loader';
import { loadMcpConfig, type McpServerConfig } from '@ethosagent/tools-mcp';
import type { PluginPageSpec, Storage, ToolRegistry } from '@ethosagent/types';
import type { CredentialKeyInfo, McpServerInfo, PluginInfo } from '@ethosagent/web-contracts';

// Re-exported so rpc/ can reference the type without importing the extension
// directly (layering rule: rpc/ must not import @ethosagent/plugin-loader).
export type { PluginLoader } from '@ethosagent/plugin-loader';

function spawnNpm(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderrChunks: Buffer[] = [];
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const stderr = Buffer.concat(stderrChunks).toString().trim();
        reject(new Error(stderr || `npm exited with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

// Plugins service — composes the plugin manifest scan
// (~/.ethos/plugins/<id>/) and the MCP config (~/.ethos/mcp.json).
// Calls into @ethosagent/plugin-loader's `scanInstalledPlugins` and
// @ethosagent/tools-mcp's `loadMcpConfig`; sanitisation + sort happen
// here so the extensions stay free of web-contract types.

export interface PluginsServiceOptions {
  storage: Storage;
  /** Root data dir — `~/.ethos/`. */
  dataDir: string;
  /** Working dir for the optional project-level scan. */
  workingDir?: string;
  /** Plugin loader instance for credential management. */
  pluginLoader?: PluginLoader;
  /** v2.3 — Plugin page registry. When present, getPageSpec can look up pages. */
  pluginPages?: Map<string, PluginPageSpec>;
  /**
   * v2.3 — Tool ownership map. Maps tool name to the pluginId that registered it.
   * Used by invokeToolForPage to verify the tool is owned by the requesting plugin,
   * preventing a plugin from declaring another plugin's tool in its page spec.
   */
  pluginToolOwnership?: Map<string, string>;
  /** Runs npm with an argv array. Defaults to spawning `npm`; tests inject a fake. */
  runNpm?: (args: string[]) => Promise<void>;
}

export class PluginsService {
  constructor(private readonly opts: PluginsServiceOptions) {}

  /**
   * Install a plugin from npm and leave behind what `ethos plugin install`
   * does: a capability grant (`consent: 'interactive'`) in the plugins dir's
   * `grants.json`, and — when `personalityId` is given — a `plugins.lock` pin
   * plus the personality's `plugins:` line (only if its `config.yaml` already
   * exists). Both are built by the same helpers the CLI uses
   * (`draftPluginGrant`, `pinPluginToPersonality` in
   * `extensions/plugin-loader/src/install-record.ts`).
   *
   * No current web caller passes `personalityId`: the Library page and the
   * personality create wizard both install globally. The option is the seam a
   * future install surface for an existing personality would use.
   *
   * Unlike the CLI, the grant is written AFTER npm has put the code on disk:
   * its capabilities are the installed package's declared `ethos.permissions`,
   * which cannot be read before the package exists. If recording fails this
   * throws with the package installed and no grant — the state every web
   * install left before grants were recorded here.
   */
  async install(packageSpec: string, opts: { personalityId?: string } = {}): Promise<void> {
    const { personalityId } = opts;
    // The id becomes a path segment under `personalities/`.
    if (personalityId !== undefined && !isValidPluginId(personalityId)) {
      throw new Error(`Invalid personality id "${personalityId}"`);
    }
    const { storage } = this.opts;
    const dir = join(this.opts.dataDir, 'plugins');
    await mkdir(dir, { recursive: true });
    const before = await readPrefixDependencies(storage, dir);
    await (this.opts.runNpm ?? spawnNpm)([
      'install',
      '--prefix',
      dir,
      '--ignore-scripts',
      '--no-audit',
      packageSpec,
    ]);

    const after = await readPrefixDependencies(storage, dir);
    const pkgDir = join(dir, 'node_modules', installedPackageName(packageSpec, before, after));
    let pkgJson: unknown;
    try {
      const src = await storage.read(join(pkgDir, 'package.json'));
      pkgJson = src === null ? undefined : JSON.parse(src);
    } catch {
      pkgJson = undefined;
    }
    const scan = await scanPluginPackage(storage, pkgDir, pkgJson);
    const { draft } = draftPluginGrant({
      pkgJson,
      requestedSpec: packageSpec,
      // npm packages are always `community` — the tier `installPlugin` records.
      scan: { tier: 'community', ...scan },
    });
    await recordGrant(storage, dir, {
      ...draft,
      grantedAt: new Date().toISOString(),
      consent: 'interactive',
    });
    if (personalityId !== undefined) {
      await pinPluginToPersonality({
        storage,
        pluginsDir: dir,
        personalityDir: join(this.opts.dataDir, 'personalities', personalityId),
        draft,
      });
    }
  }

  async uninstall(pluginId: string): Promise<void> {
    const dir = join(this.opts.dataDir, 'plugins');
    await spawnNpm(['uninstall', '--prefix', dir, pluginId]);
  }

  async setCredential(pluginId: string, key: string, value: string): Promise<void> {
    if (!this.opts.pluginLoader) throw new Error('Plugin loader not available');
    await this.opts.pluginLoader.setCredential(pluginId, key, value);
  }

  async getCredentialMeta(pluginId: string, key: string): Promise<{ updatedAt: string } | null> {
    if (!this.opts.pluginLoader) return null;
    return this.opts.pluginLoader.getCredentialMeta(pluginId, key);
  }

  async listCredentialKeys(pluginId: string): Promise<CredentialKeyInfo[]> {
    if (!this.opts.pluginLoader) return [];
    const keys = await this.opts.pluginLoader.listCredentialKeys(pluginId);
    return keys.map((k) => ({
      key: k.key,
      label: k.label,
      type: k.type,
      description: k.description ?? null,
      refreshHint: k.refreshHint ?? null,
      required: k.required ?? null,
      isSet: k.isSet,
      updatedAt: k.updatedAt,
    }));
  }

  async list(): Promise<{ plugins: PluginInfo[]; mcpServers: McpServerInfo[] }> {
    const [manifests, mcpRaw] = await Promise.all([
      scanInstalledPlugins({
        userDir: this.opts.dataDir,
        storage: this.opts.storage,
        ...(this.opts.workingDir ? { workingDir: this.opts.workingDir } : {}),
      }),
      loadMcpConfig(this.opts.storage),
    ]);
    const mcpServers = mcpRaw
      .filter(isValidMcpServer)
      .map(toWireMcpServer)
      .sort((a, b) => a.name.localeCompare(b.name));
    // `scanInstalledPlugins` is a static disk read — it knows nothing about
    // what this process actually loaded. Merge the loader's live manifests on
    // top so each row reports its real status, error and safety findings. The
    // disk scan derives an id the same way the loader does, but a plugin whose
    // manifest omits `ethos.id` keys on the full package name in one and the
    // unscoped name in the other, so package name is the second key.
    const live = this.opts.pluginLoader?.listManifests() ?? [];
    const liveByKey = new Map<string, InstalledPluginManifest>();
    for (const m of live) liveByKey.set(m.id, m);
    for (const m of live) if (!liveByKey.has(m.name)) liveByKey.set(m.name, m);
    const plugins = manifests.map((m) =>
      toWirePlugin(m, liveByKey.get(m.id) ?? liveByKey.get(m.name)),
    );
    return { plugins, mcpServers };
  }

  async getCredential(pluginId: string, ref: string): Promise<string | null> {
    if (!this.opts.pluginLoader) return null;
    return this.opts.pluginLoader.getCredentialValue(pluginId, ref);
  }

  async credentialPreview(pluginId: string, ref: string): Promise<string | null> {
    if (!this.opts.pluginLoader) return null;
    return this.opts.pluginLoader.getCredentialPreview(pluginId, ref);
  }

  async executeTool(
    pluginId: string,
    toolName: string,
    args?: Record<string, unknown>,
    toolRegistry?: ToolRegistry,
  ): Promise<{ ok: boolean; value?: string; error?: string; code?: string }> {
    // Verify the tool is owned by the requesting plugin.
    const ownerPluginId = this.opts.pluginToolOwnership?.get(toolName);
    if (ownerPluginId !== pluginId) {
      return { ok: false, error: `Tool "${toolName}" is not owned by plugin "${pluginId}"` };
    }
    if (!toolRegistry) {
      return { ok: false, error: 'Tool registry not available' };
    }
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      return { ok: false, error: `Tool "${toolName}" not found` };
    }
    const MAX_RESULT_CHARS = 80_000;
    try {
      const result = await tool.execute(args ?? {}, {
        sessionId: `plugin-panel:${pluginId}`,
        sessionKey: `plugin-panel:${pluginId}`,
        platform: 'web-panel',
        workingDir: this.opts.dataDir,
        currentTurn: 0,
        messageCount: 0,
        abortSignal: AbortSignal.timeout(30_000),
        emit: () => {},
        resultBudgetChars: MAX_RESULT_CHARS,
      });
      if (result.ok) {
        const value =
          result.value.length > MAX_RESULT_CHARS
            ? `${result.value.slice(0, MAX_RESULT_CHARS)}\n[truncated]`
            : result.value;
        return { ok: true, value };
      }
      return { ok: false, error: result.error, code: result.code };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async requestOAuth(pluginId: string, _oauthRef: string): Promise<{ url: string }> {
    const apiKey = await this.getCredential(pluginId, 'brokers/zerodha/apiKey');
    if (!apiKey) {
      throw new Error(`API key not set for plugin ${pluginId}. Configure it in Settings first.`);
    }
    const url = `https://kite.trade/connect/login?v=3&api_key=${apiKey}`;
    return { url };
  }

  async completeOAuth(
    pluginId: string,
    _oauthRef: string,
    requestToken: string,
    toolRegistry?: ToolRegistry,
  ): Promise<{ ok: boolean; userId?: string }> {
    const result = await this.executeTool(
      pluginId,
      'zerodha_auth_complete',
      { request_token: requestToken },
      toolRegistry,
    );
    if (!result.ok) return { ok: false };
    try {
      const parsed = JSON.parse(result.value ?? '{}') as { user_id?: string };
      return { ok: true, userId: parsed.user_id };
    } catch {
      return { ok: true };
    }
  }

  async getPageSpec(pluginId: string): Promise<PluginPageSpec | null> {
    return this.opts.pluginPages?.get(pluginId) ?? null;
  }

  async invokeToolForPage(
    pluginId: string,
    toolName: string,
    args?: Record<string, unknown>,
    toolRegistry?: ToolRegistry,
  ): Promise<{ ok: boolean; value: string; structured?: Record<string, unknown>; error?: string }> {
    // Verify the tool is declared in this plugin's page spec to prevent
    // arbitrary tool execution through the page endpoint.
    const spec = this.opts.pluginPages?.get(pluginId);
    if (!spec) {
      return { ok: false, value: '', error: `No page spec registered for plugin "${pluginId}"` };
    }
    const allowedTools = new Set<string>();
    for (const section of spec.sections) {
      if ('toolName' in section && typeof section.toolName === 'string') {
        allowedTools.add(section.toolName);
      }
    }
    if (!allowedTools.has(toolName)) {
      return {
        ok: false,
        value: '',
        error: `Tool "${toolName}" is not declared in plugin "${pluginId}" page spec`,
      };
    }
    // Verify the tool is owned by the requesting plugin. A plugin's page spec
    // can only reference tools that the same plugin registered — not tools from
    // other plugins or built-in tools.
    const ownerPluginId = this.opts.pluginToolOwnership?.get(toolName);
    if (ownerPluginId !== pluginId) {
      return {
        ok: false,
        value: '',
        error: `Tool "${toolName}" is not owned by plugin "${pluginId}"`,
      };
    }
    if (!toolRegistry) {
      return { ok: false, value: '', error: 'Tool registry not available' };
    }
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      return { ok: false, value: '', error: `Tool "${toolName}" not found` };
    }
    const MAX_PAGE_RESULT_CHARS = 80_000;
    try {
      const result = await tool.execute(args ?? {}, {
        sessionId: `page:${pluginId}`,
        sessionKey: `page:${pluginId}`,
        platform: 'web-page',
        workingDir: this.opts.dataDir,
        currentTurn: 0,
        messageCount: 0,
        abortSignal: AbortSignal.timeout(30_000),
        emit: () => {},
        resultBudgetChars: MAX_PAGE_RESULT_CHARS,
      });
      if (result.ok) {
        const value =
          result.value.length > MAX_PAGE_RESULT_CHARS
            ? `${result.value.slice(0, MAX_PAGE_RESULT_CHARS)}\n[truncated]`
            : result.value;
        return {
          ok: true,
          value,
          ...(result.structured ? { structured: result.structured } : {}),
        };
      }
      return { ok: false, value: '', error: result.error };
    } catch (err) {
      return { ok: false, value: '', error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** The `dependencies` map npm keeps in the prefix's own package.json. */
async function readPrefixDependencies(
  storage: Storage,
  prefix: string,
): Promise<Record<string, unknown>> {
  try {
    const src = await storage.read(join(prefix, 'package.json'));
    if (src === null) return {};
    const deps = (JSON.parse(src) as { dependencies?: unknown } | null)?.dependencies;
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) return {};
    return deps as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Which package `npm install <spec>` put under the prefix. A plain registry
 * spec (`name`, `name@range`, `@scope/name@tag`) names it; any other form (a
 * tarball, a git URL, a path) is found as the one dependency npm added or
 * changed. Anything else is refused rather than guessed: a grant recorded
 * against the wrong package is worse than none.
 */
function installedPackageName(
  spec: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@');
  const named = at === -1 ? spec : spec.slice(0, at);
  if (isValidNpmPackageName(named) && after[named] !== undefined) return named;
  const changed = Object.keys(after).filter((name) => after[name] !== before[name]);
  const [only] = changed;
  if (changed.length === 1 && only !== undefined) return only;
  throw new Error(
    `npm installed '${spec}' but the installed package could not be identified, so no capability grant was recorded. Install it with: ethos plugin install ${spec}`,
  );
}

/**
 * `disk` is the manifest as it sits in the filesystem; `live` is the same
 * plugin as this process actually loaded it, when the loader knows about it.
 * A plugin with no `live` entry was never activated here — status stays null
 * rather than claiming a failure we did not observe.
 */
function toWirePlugin(disk: InstalledPluginManifest, live?: InstalledPluginManifest): PluginInfo {
  const findings = live?.scanFindings ?? [];
  return {
    id: disk.id,
    name: disk.name,
    version: disk.version,
    description: disk.description,
    source: disk.source,
    path: disk.path,
    pluginContractMajor: disk.pluginContractMajor,
    hasHomePanel: disk.hasHomePanel ?? false,
    status: live?.status ?? null,
    error: live?.error ?? null,
    ...(findings.length > 0 ? { scanFindings: findings } : {}),
  };
}

function isValidMcpServer(entry: McpServerConfig): boolean {
  if (typeof entry.name !== 'string') return false;
  return (
    entry.transport === 'stdio' ||
    entry.transport === 'sse' ||
    entry.transport === 'streamable-http'
  );
}

function toWireMcpServer(entry: McpServerConfig): McpServerInfo {
  return {
    name: entry.name,
    transport: entry.transport,
    command: typeof entry.command === 'string' ? entry.command : null,
    url: typeof entry.url === 'string' ? entry.url : null,
    auth_status: null,
    created_via: entry.created_via ?? null,
    mcpResultLimitChars: entry.mcpResultLimitChars ?? null,
    deprecated: entry.transport === 'sse',
  };
}
