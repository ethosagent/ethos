import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  describeUndoneInstall,
  draftPluginGrant,
  findPreviousCopy,
  grantsPath,
  type InstalledPluginManifest,
  type InstallStage,
  installPackedTarball,
  isExactVersion,
  isValidNpmPackageName,
  isValidPluginId,
  type PluginGrant,
  type PluginGrantDraft,
  PluginIntegrityError,
  type PluginLoader,
  pinPluginToPersonality,
  pluginLockEntryFor,
  readGrants,
  readLockfile,
  recordGrant,
  scanInstalledPlugins,
  scanPluginPackage,
  type UndoPluginInstallInput,
  undoPluginInstall,
} from '@ethosagent/plugin-loader';
import { loadMcpConfig, type McpServerConfig } from '@ethosagent/tools-mcp';
import {
  EthosError,
  type EthosErrorCode,
  type PluginPageSpec,
  type Storage,
  type ToolRegistry,
} from '@ethosagent/types';
import type { CredentialKeyInfo, McpServerInfo, PluginInfo } from '@ethosagent/web-contracts';

// Re-exported so rpc/ can reference the type without importing the extension
// directly (layering rule: rpc/ must not import @ethosagent/plugin-loader).
export type { PluginLoader } from '@ethosagent/plugin-loader';

/**
 * npm exited non-zero. Carries both streams because `npm view --json` writes its
 * structured `{"error":{"code","summary"}}` to STDOUT on failure, and the human
 * `npm error code E404` lines to stderr (both verified on npm 11.12.1).
 * `classifyNpmFailure` reads it; an injected `runNpm` throws it the same way.
 */
export class NpmExitError extends Error {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(exitCode: number | null, stdout: string, stderr: string) {
    super(stderr || `npm exited with code ${exitCode}`);
    this.name = 'NpmExitError';
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** npm with an argv array — no shell. Resolves with npm's stdout (`npm view --json` is read from it). */
function spawnNpm(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    proc.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new NpmExitError(code, stdout, Buffer.concat(stderrChunks).toString().trim()));
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
  /**
   * Runs npm with an argv array and resolves with its stdout. Defaults to
   * spawning `npm`; tests inject a fake. EVERY npm call `install` makes — the
   * `view`, the `pack` and the `install` — goes through it.
   */
  runNpm?: (args: string[]) => Promise<string>;
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
   * The workspace plugins page (`/p/:personalityId/plugins`) passes the route's
   * `personalityId`, so its installs write the `plugins.lock` pin — the web form
   * of `ethos plugin install --personality`. The global Library Plugins page and
   * the personality create wizard pass none and install globally (the wizard
   * because the personality does not exist until it is submitted).
   *
   * The bytes installed are verified, the same way `ethos plugin install`
   * verifies them (`installScannedPlugin`, `apps/ethos/src/commands/plugin.ts`):
   *
   *   1. `resolveRegistrySpec` refuses anything that is not a registry package
   *      (`INVALID_INPUT`, before npm runs), then resolves the spec with
   *      `npm view` to an exact `name@version` and the registry's sha512
   *      `dist.integrity`. No such version → `PLUGIN_SPEC_UNVERIFIABLE`; no such
   *      package → `PLUGIN_PACKAGE_NOT_FOUND`; npm could not get an answer →
   *      `PLUGIN_REGISTRY_FAILED`; npm cannot be spawned → `NOT_CONFIGURED`
   *      (`classifyNpmFailure`).
   *   2. `installPackedTarball` packs that version, refuses a tarball whose SRI
   *      differs from `dist.integrity` BEFORE `npm install` runs
   *      (`PLUGIN_INTEGRITY_MISMATCH`, nothing installed, granted or pinned), and
   *      installs the verified file with `--ignore-scripts`. A failed `npm pack` or
   *      `npm install` is classified by the same `classifyNpmFailure`: no registry
   *      answer → `PLUGIN_REGISTRY_FAILED`, no npm → `NOT_CONFIGURED`, anything
   *      else → `PLUGIN_INSTALL_FAILED` carrying npm's code and summary.
   *   3. The grant is recorded from the installed package.json — refused
   *      `PLUGIN_PACKAGE_MISMATCH` when it names another package or version.
   *   4. With `personalityId`, the pin is that same SRI — no second pack.
   *
   * Unlike the CLI, the grant is written AFTER npm has put the code on disk:
   * its capabilities are the installed package's declared `ethos.permissions`,
   * which cannot be read before the package exists. So a failed `npm install`
   * (npm's own rollback can leave files behind), and every failure after a
   * successful one — rewriting the prefix's package.json /
   * package-lock.json, reading and scanning the package, a package mismatch,
   * recording the grant, writing the pin — goes through `refuseInstalled`, which
   * undoes the install with the routine `ethos plugin install` also uses
   * (`undoPluginInstall`, extensions/plugin-loader/src/install-undo.ts) and says
   * what the undo actually left (`describeUndoneInstall`): an ungranted package
   * would otherwise load on the next start, because the loader refuses only a
   * REVOKED grant. When a copy of the plugin was installed before this attempt
   * (`findPreviousCopy`, read before npm runs, because `npm install` replaces
   * it), the undo reinstalls it from a verified `plugins.lock` pin, or says it
   * was removed and how to reinstall it. A grant or pin this attempt wrote is
   * put back to what it was before (`restoreGrant`, grants.ts, for the grant).
   */
  async install(packageSpec: string, opts: { personalityId?: string } = {}): Promise<void> {
    const { personalityId } = opts;
    // The id becomes a path segment under `personalities/`.
    if (personalityId !== undefined && !isValidPluginId(personalityId)) {
      throw new Error(`Invalid personality id "${personalityId}"`);
    }
    const npm = this.opts.runNpm ?? spawnNpm;
    const resolved = await resolveRegistrySpec(packageSpec, npm);
    const { storage, dataDir } = this.opts;
    const dir = join(dataDir, 'plugins');
    await mkdir(dir, { recursive: true });
    const pkgDir = join(dir, 'node_modules', resolved.name);
    const undo: UndoPluginInstallInput = {
      storage,
      pluginsDir: dir,
      name: resolved.name,
      previous: await findPreviousCopy({
        storage,
        pluginsDir: dir,
        personalitiesDir: join(dataDir, 'personalities'),
        name: resolved.name,
        preferredPersonality: personalityId,
      }),
      runNpm: async (args) => {
        await npm(args);
      },
      describeFailure: describeError,
    };
    const installed = `npm installed the verified tarball of ${resolved.name}@${resolved.version}`;
    /** What was under way once `npm install` had succeeded; null until it has. */
    let afterInstall: string | null = null;
    /** True while `npm install` is running, and after it exits non-zero. */
    let npmInstallFailed = false;
    let integrity: string;
    let draft: PluginGrantDraft;
    try {
      ({ integrity } = await installPackedTarball({
        package: resolved.name,
        version: resolved.version,
        pluginsDir: dir,
        storage,
        expected: {
          integrity: resolved.integrity,
          from: 'the registry publishes as its dist.integrity',
        },
        runNpm: async (args) => {
          const step = args[0] === 'pack' ? 'pack' : 'install';
          if (step === 'install') npmInstallFailed = true;
          try {
            await npm(args);
          } catch (err) {
            // A failed `npm install` is classified in the catch below, after the
            // undo has checked what it left on disk.
            if (step === 'install') throw err;
            throw (
              classifyNpmFailure(err, {
                step,
                spec: `${resolved.name}@${resolved.version}`,
                name: resolved.name,
                outcome: 'Nothing was installed, granted or pinned.',
              }) ?? err
            );
          }
          if (step === 'install') {
            npmInstallFailed = false;
            afterInstall = `rewriting ${join(dir, 'package.json')} and package-lock.json to record it`;
          }
        },
      }));
      afterInstall = `reading and scanning ${pkgDir}`;
      let pkgJson: unknown;
      try {
        const src = await storage.read(join(pkgDir, 'package.json'));
        pkgJson = src === null ? undefined : JSON.parse(src);
      } catch {
        pkgJson = undefined;
      }
      const scan = await scanPluginPackage(storage, pkgDir, pkgJson);
      ({ draft } = draftPluginGrant({
        pkgJson,
        requestedSpec: packageSpec,
        // npm packages are always `community` — the tier `installPlugin` records.
        scan: { tier: 'community', ...scan },
      }));
    } catch (err) {
      if (afterInstall !== null) {
        throw await refuseInstalled(undo, {
          code: 'PLUGIN_INSTALL_FAILED',
          found: `${installed}, but ${afterInstall} failed (${describeError(err)}).`,
          action: POST_INSTALL_RETRY_ACTION,
        });
      }
      if (npmInstallFailed) {
        const spec = `${resolved.name}@${resolved.version}`;
        // An empty `outcome`: the undo's confirmed end state is the rest of the cause.
        const classified = classifyNpmFailure(err, {
          step: 'install',
          spec,
          name: resolved.name,
          outcome: '',
        });
        throw await refuseInstalled(
          undo,
          classified === null
            ? {
                code: 'PLUGIN_INSTALL_FAILED',
                found: `npm install '${spec}' failed (${describeError(err)}).`,
                action: POST_INSTALL_RETRY_ACTION,
              }
            : {
                code: classified.code,
                found: classified.cause.trimEnd(),
                action: classified.action,
              },
          'npm-install-failed',
        );
      }
      if (err instanceof PluginIntegrityError) {
        throw new EthosError({
          code: 'PLUGIN_INTEGRITY_MISMATCH',
          cause: `The tarball npm downloaded for ${resolved.name}@${resolved.version} does not match the registry's published digest (expected ${err.expected}, got ${err.actual}). Nothing was installed, granted or pinned.`,
          action:
            'Retry the install. If it is refused again, do not install this package: the registry served bytes that do not match its own published digest.',
        });
      }
      throw err;
    }

    // A grant recorded against a package other than the one verified is worse than none.
    if (draft.package !== resolved.name || draft.version !== resolved.version) {
      throw await refuseInstalled(undo, {
        code: 'PLUGIN_PACKAGE_MISMATCH',
        found: `${installed}, but ${pkgDir}/package.json names ${draft.package}@${draft.version}.`,
        action:
          'Do not install this package: the package.json inside its published tarball does not name the package and version the registry publishes it as. Report it to the package maintainer.',
      });
    }
    try {
      // Read first: `recordGrant` replaces any grant already recorded under this id.
      const previousGrant = (await readGrants(storage, dir))[draft.id] ?? null;
      const grant: PluginGrant = {
        ...draft,
        grantedAt: new Date().toISOString(),
        consent: 'interactive',
      };
      await recordGrant(storage, dir, grant);
      undo.grant = { id: draft.id, recorded: grant, previous: previousGrant };
    } catch (err) {
      throw await refuseInstalled(undo, {
        code: 'PLUGIN_INSTALL_FAILED',
        found: `${installed}, but recording its capability grant in ${grantsPath(dir)} failed (${describeError(err)}).`,
        action: POST_INSTALL_RETRY_ACTION,
      });
    }
    if (personalityId !== undefined) {
      const personalityDir = join(dataDir, 'personalities', personalityId);
      try {
        // Read first: the pin replaces any entry already pinned under this id.
        const previousPin = (await readLockfile(storage, personalityDir))[draft.id] ?? null;
        undo.pin = {
          personalityId,
          personalityDir,
          pluginId: draft.id,
          written: pluginLockEntryFor(draft, integrity),
          previous: previousPin,
        };
        await pinPluginToPersonality({ storage, personalityDir, draft, integrity });
      } catch (err) {
        throw await refuseInstalled(undo, {
          code: 'PLUGIN_INSTALL_FAILED',
          found: `${installed}, but pinning it to personality ${personalityId} failed (${describeError(err)}).`,
          action: POST_INSTALL_RETRY_ACTION,
        });
      }
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
/** What may follow `name@` in a registry spec: an exact version, a semver range or a
 *  dist-tag. No `:` and no `/`, so never a git URL, a tarball URL, a `file:` path or an
 *  `npm:` alias. */
const REGISTRY_SELECTOR_RE = /^[A-Za-z0-9.+^~<>=|* -]*$/;

const SHA512_SRI_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

const REGISTRY_SPEC_ACTION =
  'Install a published npm package by name (e.g. ethos-plugin-foo or ethos-plugin-foo@1.2.3), not a git URL, tarball, or local path.';

/** One key of a parsed JSON object, or undefined. Reads `npm view --json` without a cast. */
function jsonField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/**
 * `packageSpec` → the exact `name@version` an install will verify and pin, and the
 * registry's sha512 `dist.integrity` for it.
 *
 * Refuses before npm runs when the spec is not `name` or `name@<version|range|tag>`
 * — the same line `readScannedIntegrity` (`apps/ethos/src/commands/plugin.ts`)
 * draws for the CLI: without a registry digest there is nothing to hold the install
 * to, and the install fetches `name@version` from the registry, which is not what a
 * git URL or a path names.
 *
 * A range several versions satisfy comes back from `npm view` as an array in
 * ascending order (verified on npm 11); the last entry, the highest match, is the
 * one installed. Limitation: `npm install <range>` would prefer the `latest` tag
 * when it satisfies the range, so a range can resolve to a higher version here than
 * it would there — the grant and pin still name exactly what was installed.
 */
async function resolveRegistrySpec(
  spec: string,
  npm: (args: string[]) => Promise<string>,
): Promise<{ name: string; version: string; integrity: string }> {
  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@');
  const name = at === -1 ? spec : spec.slice(0, at);
  const selector = at === -1 ? '' : spec.slice(at + 1);
  if (!isValidNpmPackageName(name) || !REGISTRY_SELECTOR_RE.test(selector)) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `'${spec}' is not a published npm package spec, so there is no registry digest to hold the install to`,
      action: REGISTRY_SPEC_ACTION,
    });
  }
  let stdout: string;
  try {
    stdout = await npm(['view', spec, 'name', 'version', 'dist.integrity', '--json']);
  } catch (err) {
    throw (
      classifyNpmFailure(err, { step: 'view', spec, name, outcome: 'Nothing was installed.' }) ??
      err
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = undefined;
  }
  const answer: unknown = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  const resolvedName = jsonField(answer, 'name');
  const version = jsonField(answer, 'version');
  const integrity = jsonField(answer, 'dist.integrity');
  if (
    resolvedName !== name ||
    typeof version !== 'string' ||
    !isExactVersion(version) ||
    typeof integrity !== 'string' ||
    !SHA512_SRI_RE.test(integrity)
  ) {
    throw new EthosError({
      code: 'PLUGIN_SPEC_UNVERIFIABLE',
      cause: `npm view '${spec}' returned no exact ${name} version with a sha512 dist.integrity, so the install cannot be verified`,
      action: REGISTRY_SPEC_ACTION,
    });
  }
  return { name, version, integrity };
}

/** Node's errno codes npm reports when the request never got an HTTP answer. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ERR_SOCKET_TIMEOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * npm's own error code and one-line summary for a failed npm command: the
 * `{"error":{"code","summary"}}` object `npm view --json` prints to stdout, else the
 * `npm error code <CODE>` line and the next `npm error …` line on stderr (what
 * `npm pack` and `npm install` print; verified on npm 11.12.1).
 */
function npmErrorReport(err: NpmExitError): { code: string | null; summary: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(err.stdout);
  } catch {
    parsed = undefined;
  }
  const error = jsonField(parsed, 'error');
  const code = jsonField(error, 'code');
  const summary = jsonField(error, 'summary');
  if (typeof code === 'string') {
    return { code, summary: typeof summary === 'string' ? summary : '' };
  }
  const lines = err.stderr.split('\n').map((line) => line.replace(/^npm error\s*/, '').trim());
  const codeLine = lines.findIndex((line) => /^code \S+$/.test(line));
  if (codeLine === -1) {
    return { code: null, summary: lines.find((line) => line !== '') ?? '' };
  }
  return {
    code: lines[codeLine]?.slice('code '.length) ?? null,
    summary:
      lines.slice(codeLine + 1).find((line) => line !== '' && !/^(syscall|errno) /.test(line)) ??
      '',
  };
}

/** `CODE: summary` for an npm failure, as the refusals quote it. */
function describeNpmFailure(err: NpmExitError): string {
  const { code, summary } = npmErrorReport(err);
  return code ? `${code}: ${summary}` : summary || `npm exited with code ${err.exitCode}`;
}

interface NpmFailureContext {
  /** Which npm command failed. */
  step: 'view' | 'pack' | 'install';
  /** What was asked for: the caller's spec for `view`, the resolved `name@version` after. */
  spec: string;
  name: string;
  /** The sentence that says what the failure left behind, e.g. "Nothing was installed." */
  outcome: string;
}

/**
 * Turn a failed npm command into the refusal it is, or `null` when `err` is not a
 * failure of npm itself (rethrown unchanged).
 *
 * Told apart by npm's reported error code, never by guessing:
 *   - `spawn` itself failing (`ENOENT`/`EACCES`: no runnable npm) → `NOT_CONFIGURED`.
 *   - a Node network errno (`NETWORK_ERROR_CODES`) — the registry never answered —
 *     → `PLUGIN_REGISTRY_FAILED`, at every step.
 *   - `npm view` only:
 *     - `E404` with "No match found for version …" — the package exists, the
 *       version/range/tag does not (npm 11.12.1 prints this for `left-pad@99.0.0`,
 *       `left-pad@^99` and `left-pad@nosuchtag`) → `PLUGIN_SPEC_UNVERIFIABLE`.
 *     - any other `E404` ("Not Found - GET <registry>/<name>") → `PLUGIN_PACKAGE_NOT_FOUND`.
 *       Limitation: npm reports a private package this server cannot read the same way.
 *     - any other failure (registry 5xx, E401/E403, unparseable output) →
 *       `PLUGIN_REGISTRY_FAILED`: `view` does nothing but ask the registry.
 *   - `npm pack` / `npm install`: an `E5xx` (npm-registry-fetch reports an HTTP
 *     error status as `E<status>`) → `PLUGIN_REGISTRY_FAILED`; anything else →
 *     `PLUGIN_INSTALL_FAILED`. By then `view` has already answered for this exact
 *     version, so an `E404` here is a dependency the registry does not have
 *     (verified on npm 11.12.1 for a tarball depending on a missing package), and
 *     the rest are local — disk, permissions, a dependency conflict.
 * npm's own code and summary go in every cause.
 */
function classifyNpmFailure(err: unknown, ctx: NpmFailureContext): EthosError | null {
  const { step, spec, name, outcome } = ctx;
  if (!(err instanceof NpmExitError)) {
    const errno =
      err instanceof Error ? Object.getOwnPropertyDescriptor(err, 'code')?.value : undefined;
    if (errno === 'ENOENT' || errno === 'EACCES') {
      return new EthosError({
        code: 'NOT_CONFIGURED',
        cause: `This server cannot run npm (${errno} spawning npm), so it cannot install '${spec}'. ${outcome}`,
        action: `Put npm on the server's PATH and restart it, or install from a terminal with: ethos plugin install ${spec}`,
      });
    }
    return null;
  }
  const { code, summary } = npmErrorReport(err);
  const reported = describeNpmFailure(err);
  if (code !== null && NETWORK_ERROR_CODES.has(code)) {
    return new EthosError({
      code: 'PLUGIN_REGISTRY_FAILED',
      cause: `npm ${step} '${spec}' could not reach the npm registry (${reported}). ${outcome}`,
      action:
        "Check this server's network connection and npm proxy settings, then retry the install.",
    });
  }
  if (step === 'view') {
    if (code === 'E404' && /^No match found for version /.test(summary)) {
      return new EthosError({
        code: 'PLUGIN_SPEC_UNVERIFIABLE',
        cause: `npm view '${spec}' found no published ${name} version matching the spec (${reported}). ${outcome}`,
        action: `Ask for a version ${name} has published — list them with: npm view ${name} versions`,
      });
    }
    if (code === 'E404') {
      return new EthosError({
        code: 'PLUGIN_PACKAGE_NOT_FOUND',
        cause: `The npm registry has no package named '${name}' that this server can read (${reported}). ${outcome}`,
        action: `Check the package name's spelling. If '${name}' is private, configure npm on the server with a token that can read it.`,
      });
    }
    return new EthosError({
      code: 'PLUGIN_REGISTRY_FAILED',
      cause: `npm view '${spec}' failed (${reported}). ${outcome}`,
      action: `Retry the install. If it fails again, run npm view ${spec} on the server to see npm's full error.`,
    });
  }
  if (code !== null && /^E5\d\d$/.test(code)) {
    return new EthosError({
      code: 'PLUGIN_REGISTRY_FAILED',
      cause: `npm ${step} '${spec}' got an error answer from the npm registry (${reported}). ${outcome}`,
      action: 'Retry the install once the registry is answering again.',
    });
  }
  return new EthosError({
    code: 'PLUGIN_INSTALL_FAILED',
    cause: `npm ${step} '${spec}' failed (${reported}). ${outcome}`,
    action:
      "Fix what npm reports, then retry the install. npm writes the full log of the failed run under _logs/ in the server's npm cache directory (npm config get cache).",
  });
}

const POST_INSTALL_RETRY_ACTION = 'Fix what the error reports, then retry the install.';

/** One failure's message, as a refusal quotes it in parentheses. */
function describeError(err: unknown): string {
  if (err instanceof NpmExitError) return describeNpmFailure(err);
  if (err instanceof PluginIntegrityError) {
    return `the tarball's SRI ${err.actual} does not match the pinned ${err.expected}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Undo the install (`undoPluginInstall`, extensions/plugin-loader/src/install-undo.ts)
 * and build the refusal for a failed `npm install` (`stage: 'npm-install-failed'`) or a
 * failure that came after a successful one.
 * `found` says what went wrong; the rest of the cause is the end state the undo
 * confirmed (`describeUndoneInstall`) and never a state it did not reach.
 */
async function refuseInstalled(
  undo: UndoPluginInstallInput,
  failure: { code: EthosErrorCode; found: string; action: string },
  stage: Exclude<InstallStage, 'before-npm-install'> = 'after-npm-install',
): Promise<EthosError> {
  const outcome = await undoPluginInstall({ ...undo, stage });
  const { cause, action } = describeUndoneInstall({
    undo,
    outcome,
    found: failure.found,
    action: failure.action,
    restartsWhen: 'this server restarts',
  });
  return new EthosError({ code: failure.code, cause, action });
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
