import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { noopLogger } from '@ethosagent/logger';
import {
  createOpenClawApiShim,
  extractOpenClawRegister,
  isOpenClawPackageJson,
} from '@ethosagent/openclaw-compat';
import { checkPluginContractMajor, isEthosPlugin } from '@ethosagent/plugin-contract';
import { PluginApiImpl } from '@ethosagent/plugin-sdk';
import { canInstall, deriveTier, scanPluginCode } from '@ethosagent/safety-scanner';
import { FsStorage } from '@ethosagent/storage-fs';
export class PluginLoader {
  registries;
  storage;
  logger;
  apis = new Map();
  pluginSkillSources = [];
  plugins = new Map();
  compatCallbacks;
  credentialStorage;
  dataDir;
  manifests = new Map();
  onRouteRegistered;
  loadedManifests = new Map();
  pluginPaths = new Map();
  constructor(registries, opts = {}) {
    this.registries = registries;
    const defaultFsStorage = new FsStorage();
    this.storage = opts.storage ?? defaultFsStorage;
    this.credentialStorage = opts.credentialStorage ?? defaultFsStorage;
    this.dataDir = opts.dataDir ?? join(homedir(), '.ethos');
    this.logger = opts.logger ?? noopLogger;
    this.compatCallbacks = {
      onPlatformAdapter: opts.onPlatformAdapterRegistered,
    };
    this.onRouteRegistered = opts.onRouteRegistered;
  }
  // ---------------------------------------------------------------------------
  // Discovery + loading
  // ---------------------------------------------------------------------------
  /**
   * Run the full discovery chain and load all plugins found.
   * Order: user (~/.ethos/plugins/) → project (.ethos/plugins/) → npm
   * Later sources with the same id override earlier ones.
   */
  async loadAll() {
    const dirs = [join(homedir(), '.ethos', 'plugins'), join(process.cwd(), '.ethos', 'plugins')];
    for (const dir of dirs) {
      await this.loadFromDirectory(dir);
    }
    await this.loadFromNodeModules();
  }
  /**
   * Load all plugins from a directory. Each subdirectory is one plugin.
   * Silently skips directories that don't look like plugins.
   */
  async loadFromDirectory(dir) {
    // Packages the user intentionally placed in ~/.ethos/plugins/ are treated as
    // trusted-repo — the user made an explicit install decision.
    const isUserPluginsDir = dir === join(homedir(), '.ethos', 'plugins');
    const tierOverride = isUserPluginsDir ? 'trusted-repo' : undefined;
    const entries = await this.storage.listEntries(dir);
    for (const entry of entries) {
      if (!entry.isDir) continue;
      const pluginDir = join(dir, entry.name);
      try {
        await this.loadFromPluginDir(pluginDir, entry.name, tierOverride);
      } catch {
        // skip broken plugins
      }
    }
  }
  /**
   * Load a single plugin from a directory. The directory must contain
   * either `plugin.yaml` or `package.json` (with ethos.type=plugin),
   * and an `index.ts` or `index.js` that exports `activate`.
   */
  async loadFromPluginDir(dir, pluginId, tierOverride) {
    const id = pluginId ?? dir.split('/').pop() ?? 'unknown';
    // Read package.json once — used for skills_dir discovery, contract check, and permissions.
    const pkgSrc = await this.storage.read(join(dir, 'package.json'));
    const pkgJson = pkgSrc ? JSON.parse(pkgSrc) : {};
    // Store manifest for credential declaration lookups
    if (pkgSrc) {
      this.manifests.set(id, pkgJson);
      this.pluginPaths.set(id, dir);
    }
    // Skills-dir: any package declaring ethos.skills_dir contributes skills
    // without needing an activate() entry point.
    const ethosField = pkgJson.ethos;
    const skillsDirRel = ethosField?.skills_dir;
    if (typeof skillsDirRel === 'string') {
      this.pluginSkillSources.push({ label: id, dir: resolve(dir, skillsDirRel) });
    }
    // Phase 30.6 — gate on declared plugin contract major *before* importing.
    // We don't want a stale plugin's top-level code to run if its contract
    // declaration is incompatible.
    const reject = await checkContractMajorFromDir(this.storage, dir, id);
    if (reject) {
      this.logger.warn(`[plugin-loader] ${reject}`, { component: 'plugin-loader', pluginId: id });
      return;
    }
    // Resolve entry point — skills-only packages (no activate()) stop here.
    const entry = await resolveEntry(this.storage, dir);
    if (!entry) return;
    // Safety scan the entire plugin source tree before executing any code.
    const permissions = readPluginPermissions(pkgJson);
    const tier = tierOverride ?? deriveTier(dir);
    const scanResult = await scanPluginTree(this.storage, dir, permissions);
    const decision = canInstall(scanResult, tier);
    if (!decision.allowed) {
      this.logger.warn(`[plugin-loader] "${id}" blocked by safety scan: ${decision.blockedBy}`, {
        component: 'plugin-loader',
        pluginId: id,
        blockedBy: decision.blockedBy,
      });
      return;
    }
    // Dynamic import the plugin module — stays raw `import()`. Per
    // plan/storage_abstraction.md, dynamic import is a process operation,
    // not a fs read; Storage doesn't model it.
    let mod;
    try {
      mod = await import(entry);
    } catch (err) {
      this.logger.warn(`[plugin-loader] Failed to load plugin "${id}": ${String(err)}`, {
        component: 'plugin-loader',
        pluginId: id,
        error: String(err),
      });
      return;
    }
    await this.activatePlugin(id, mod);
  }
  /**
   * Scan node_modules for packages with `ethos.type = "plugin"` in package.json.
   * Only checks packages named `ethos-plugin-*` or scoped under `@ethos-plugins/*`
   * to keep this O(n) tractable. When `dir` is provided, only that directory is
   * scanned; otherwise the project's node_modules and `~/.ethos/plugins/node_modules`
   * are scanned in order.
   */
  async loadFromNodeModules(dir) {
    const pluginsNmDir = join(homedir(), '.ethos', 'plugins', 'node_modules');
    const dirs = dir ? [dir] : [resolve('node_modules'), pluginsNmDir];
    for (const nmDir of dirs) {
      await this.scanNodeModulesDir(nmDir, { allowAll: nmDir === pluginsNmDir });
    }
  }
  async scanNodeModulesDir(nmDir, opts = {}) {
    const entries = await this.storage.list(nmDir);
    if (entries.length === 0) return;
    // listEntries returns scope dirs (e.g. `@ethos-plugins`) without their packages,
    // so scoped names need a second list to surface `@ethos-plugins/foo`.
    const candidates = [];
    if (opts.allowAll) {
      // User's intentional plugin install dir — pick up ALL packages regardless of name/scope.
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === '.bin') continue;
        if (entry.startsWith('@')) {
          const scopedEntries = await this.storage.list(join(nmDir, entry));
          for (const sub of scopedEntries) {
            candidates.push(`${entry}/${sub}`);
          }
        } else {
          candidates.push(entry);
        }
      }
    } else {
      // Project node_modules — keep strict name filter for performance.
      for (const entry of entries) {
        if (entry.startsWith('ethos-plugin-')) {
          candidates.push(entry);
          continue;
        }
        if (entry === '@ethos-plugins') {
          const scopedEntries = await this.storage.list(join(nmDir, entry));
          for (const sub of scopedEntries) {
            candidates.push(`${entry}/${sub}`);
          }
        }
        if (entry === '@ethosagent') {
          const scopedEntries = await this.storage.list(join(nmDir, entry));
          for (const sub of scopedEntries) {
            candidates.push(`${entry}/${sub}`);
          }
        }
      }
    }
    for (const name of candidates) {
      const pkgPath = join(nmDir, name, 'package.json');
      try {
        const src = await this.storage.read(pkgPath);
        if (!src) continue;
        const raw = JSON.parse(src);
        // Skills-dir: any package declaring ethos.skills_dir contributes skills.
        const ethosNm = raw.ethos;
        const skillsDirNm = ethosNm?.skills_dir;
        if (typeof skillsDirNm === 'string') {
          this.pluginSkillSources.push({
            label: name,
            dir: resolve(join(nmDir, name), String(skillsDirNm)),
          });
        }
        const isEthos = isEthosPlugin(raw);
        const isOpenClaw = isOpenClawPackageJson(raw);
        if (!isEthos && !isOpenClaw) continue;
        if (isEthos) {
          // Phase 30.6 — reject incompatible contract major before import.
          const declared = raw.ethos?.pluginContractMajor;
          const compat = checkPluginContractMajor(declared, undefined, name);
          if (!compat.ok) {
            this.logger.warn(`[plugin-loader] ${compat.reason}`, {
              component: 'plugin-loader',
              pluginId: name,
            });
            continue;
          }
        }
        const entry = resolveNpmEntry(raw, join(nmDir, name));
        if (!entry) continue;
        // Safety scan the entire npm package source tree before executing any code.
        // User plugins dir is treated as trusted-repo — user made a deliberate install decision.
        const permissions = readPluginPermissions(raw);
        const tier = opts.allowAll ? 'trusted-repo' : deriveTier(name);
        const scanResult = await scanPluginTree(this.storage, join(nmDir, name), permissions);
        const decision = canInstall(scanResult, tier);
        if (!decision.allowed) {
          this.logger.warn(
            `[plugin-loader] "${name}" blocked by safety scan: ${decision.blockedBy}`,
            { component: 'plugin-loader', pluginId: name, blockedBy: decision.blockedBy },
          );
          continue;
        }
        const mod = await import(entry);
        // Use ethos.id if declared, otherwise strip @scope/ so the plugin ID
        // matches what users write in personality config.yaml (e.g. `tools-nse-market-data`
        // not `@ethosagent/tools-nse-market-data`).
        const declaredId = ethosNm?.id;
        const pluginId = declaredId ?? name.replace(/^@[^/]+\//, '');
        this.manifests.set(pluginId, raw);
        this.pluginPaths.set(pluginId, join(nmDir, name));
        await this.activatePlugin(pluginId, mod);
      } catch {
        // skip
      }
    }
  }
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  /** Unload a plugin by id — calls deactivate() and removes all registrations. */
  async unload(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (plugin?.deactivate) {
      try {
        await plugin.deactivate();
      } catch {
        // swallow deactivate errors
      }
    }
    const api = this.apis.get(pluginId);
    api?.cleanup();
    this.plugins.delete(pluginId);
    this.apis.delete(pluginId);
  }
  /** Unload all plugins. */
  async unloadAll() {
    for (const id of [...this.plugins.keys()]) {
      await this.unload(id);
    }
  }
  /** List ids of currently loaded plugins. */
  list() {
    return [...this.plugins.keys()];
  }
  /** Check if a plugin is loaded. */
  isLoaded(pluginId) {
    return this.plugins.has(pluginId);
  }
  /** Skill source directories declared by loaded packages via `ethos.skills_dir`. */
  getPluginSkillSources() {
    return [...this.pluginSkillSources];
  }
  /** Return all loaded/failed plugin manifests with status info. */
  listManifests() {
    return [...this.loadedManifests.values()];
  }
  // ---------------------------------------------------------------------------
  // Health checks
  // ---------------------------------------------------------------------------
  /** Run health checks for one or all plugins. Results sorted by severity. */
  async runHealthChecks(pluginId) {
    const results = [];
    const targets = pluginId ? [this.apis.get(pluginId)].filter(Boolean) : [...this.apis.values()];
    for (const api of targets) {
      if (!api) continue;
      const checks = api.getHealthChecks();
      for (const check of checks) {
        const start = performance.now();
        let result;
        try {
          result = await Promise.race([
            check.run(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Health check timed out after 5000ms')), 5000),
            ),
          ]);
        } catch (err) {
          result = { status: 'error', message: err instanceof Error ? err.message : String(err) };
        }
        result.durationMs = performance.now() - start;
        results.push({
          pluginId: api.pluginId,
          checkName: check.name,
          description: check.description,
          result,
        });
      }
      // v2.2 — synthetic health checks for crashed monitors
      const crashedMonitors = api.getCrashedMonitors();
      for (const monitorName of crashedMonitors) {
        results.push({
          pluginId: api.pluginId,
          checkName: `monitor:${monitorName}`,
          description: `Monitor '${monitorName}' runtime status`,
          result: {
            status: 'error',
            message: `Monitor crashed — see: ethos doctor ${api.pluginId} --logs --level error`,
          },
        });
      }
    }
    return results.sort((a, b) => {
      const order = { error: 0, warn: 1, ok: 2 };
      return order[a.result.status] - order[b.result.status];
    });
  }
  // ---------------------------------------------------------------------------
  // Credential management
  // ---------------------------------------------------------------------------
  /** Set a credential value for a loaded plugin. Throws if the plugin is not loaded. */
  async setCredential(pluginId, key, value) {
    const impl = this.apis.get(pluginId);
    if (!impl) throw new Error(`Plugin "${pluginId}" is not loaded`);
    await impl.setSecret(key, value);
  }
  /** Read credential metadata (updatedAt timestamp). Returns null if unset. */
  async getCredentialMeta(pluginId, key) {
    const basePath = join(this.dataDir, 'plugins', pluginId);
    const metaPath = `${basePath}/credentials/${key}.meta`;
    const raw = await this.credentialStorage.read(metaPath);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  /** Remove a credential and its metadata for a plugin. */
  async clearCredential(pluginId, key) {
    const basePath = join(this.dataDir, 'plugins', pluginId, 'credentials');
    const credPath = `${basePath}/${key}`;
    const metaPath = `${credPath}.meta`;
    await this.credentialStorage.remove(credPath).catch(() => {});
    await this.credentialStorage.remove(metaPath).catch(() => {});
  }
  /** Read the raw credential value. Returns null if unset. */
  async getCredentialValue(pluginId, ref) {
    const credPath = join(this.dataDir, 'plugins', pluginId, 'credentials', ref);
    return this.credentialStorage.read(credPath);
  }
  /** Return a redacted preview of a credential (first 4 + last 4 chars).
   *  Returns null when the credential is not set. */
  async getCredentialPreview(pluginId, ref) {
    const raw = await this.getCredentialValue(pluginId, ref);
    if (raw === null) return null;
    if (raw.length <= 8) return '****';
    return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
  }
  /**
   * List all credential keys for a plugin, merging manifest declarations
   * with on-disk credential state. Returns declared credentials (from
   * `ethos.credentials` in package.json) enriched with `isSet` / `updatedAt`,
   * plus any undeclared keys found on disk.
   */
  async listCredentialKeys(pluginId) {
    const declared = this.readDeclaredCredentials(pluginId);
    const basePath = join(this.dataDir, 'plugins', pluginId, 'credentials');
    const result = [];
    const seenKeys = new Set();
    for (const cred of declared) {
      seenKeys.add(cred.key);
      const meta = await this.getCredentialMeta(pluginId, cred.key);
      const isSet = await this.credentialStorage.exists(`${basePath}/${cred.key}`);
      result.push({
        key: cred.key,
        isSet,
        updatedAt: meta?.updatedAt ?? null,
        label: cred.label,
        type: cred.type,
        description: cred.description,
        refreshHint: cred.refreshHint,
        required: cred.required,
      });
    }
    // Scan for undeclared credentials on disk
    const entries = await this.credentialStorage.list(basePath).catch(() => []);
    for (const name of entries) {
      if (name.endsWith('.meta')) continue;
      if (seenKeys.has(name)) continue;
      const meta = await this.getCredentialMeta(pluginId, name);
      result.push({
        key: name,
        isSet: true,
        updatedAt: meta?.updatedAt ?? null,
        label: name,
        type: 'text',
      });
    }
    return result;
  }
  readDeclaredCredentials(pluginId) {
    const manifest = this.manifests.get(pluginId);
    return manifest?.ethos?.credentials ?? [];
  }
  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------
  /** Record activation status for a plugin in the loadedManifests map. */
  trackManifestStatus(id, status, error, dialect = 'ethos') {
    const pkgJson = this.manifests.get(id);
    const path = this.pluginPaths.get(id) ?? '';
    const source = path.includes('node_modules') ? 'npm' : 'user';
    const entry = {
      id,
      name: pkgJson?.name ?? id,
      version: pkgJson?.version ?? '0.0.0',
      description: pkgJson?.description ?? null,
      source,
      path,
      pluginContractMajor: pkgJson?.ethos?.pluginContractMajor ?? null,
      dialect,
      credentials: pkgJson?.ethos?.credentials ?? [],
      status,
      error,
    };
    this.loadedManifests.set(id, entry);
  }
  async activatePlugin(id, mod) {
    // Validate declared dependencies are loaded before activation
    const manifest = this.manifests.get(id);
    const deps = manifest?.ethos?.dependencies;
    if (Array.isArray(deps)) {
      for (const dep of deps) {
        if (typeof dep === 'string' && !this.plugins.has(dep)) {
          this.logger.warn(
            `[plugin-loader] Plugin "${id}" requires "${dep}" but it is not loaded — skipping`,
            { component: 'plugin-loader', pluginId: id },
          );
          this.trackManifestStatus(id, 'failed', `Missing dependency: ${dep}`);
          return;
        }
      }
    }
    // Try OpenClaw dialect first — register(api) export pattern
    const openclawRegister = extractOpenClawRegister(mod);
    if (openclawRegister && !isPluginModule(mod)) {
      await this.activateOpenClawPlugin(id, openclawRegister);
      return;
    }
    // Ethos-native dialect — activate(api) export pattern
    if (!isPluginModule(mod)) {
      this.logger.warn(
        `[plugin-loader] "${id}" has no activate() or register() export — skipping`,
        { component: 'plugin-loader', pluginId: id },
      );
      return;
    }
    // Unload existing version if reloading
    if (this.plugins.has(id)) {
      await this.unload(id);
    }
    const basePath = join(this.dataDir, 'plugins', id);
    const api = new PluginApiImpl(id, this.registries, {
      storage: this.credentialStorage,
      basePath,
    });
    try {
      await mod.activate(api);
    } catch (err) {
      this.logger.warn(`[plugin-loader] Plugin "${id}" activate() threw: ${String(err)}`, {
        component: 'plugin-loader',
        pluginId: id,
        error: String(err),
      });
      this.trackManifestStatus(id, 'failed', String(err));
      api.cleanup();
      return;
    }
    this.trackManifestStatus(id, 'loaded');
    this.apis.set(id, api);
    this.plugins.set(id, mod);
  }
  async activateOpenClawPlugin(id, registerFn) {
    const basePath = join(this.dataDir, 'plugins', id);
    const ethosApi = new PluginApiImpl(id, this.registries, {
      storage: this.credentialStorage,
      basePath,
    });
    const shim = createOpenClawApiShim(id, ethosApi, this.compatCallbacks);
    try {
      await registerFn(shim);
    } catch (err) {
      this.logger.warn(`[plugin-loader] OpenClaw plugin "${id}" register() threw: ${String(err)}`, {
        component: 'plugin-loader',
        pluginId: id,
        error: String(err),
      });
      ethosApi.cleanup();
      return;
    }
    this.apis.set(id, ethosApi);
    // Track in plugins map with a synthetic EthosPlugin so list()/isLoaded() work
    this.plugins.set(id, {
      activate: async () => {},
    });
  }
}
// ---------------------------------------------------------------------------
// Dependency ordering + priority sort
// ---------------------------------------------------------------------------
/**
 * Topological sort of plugin manifests by dependency order, with priority
 * tie-breaking. Throws on circular dependencies.
 */
export function topologicalSort(manifests) {
  const graph = new Map();
  const ids = new Set(manifests.map((m) => m.id));
  for (const m of manifests) {
    graph.set(
      m.id,
      (m.dependencies ?? []).filter((d) => ids.has(d)),
    );
  }
  const visited = new Set();
  const visiting = new Set();
  const order = [];
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Circular plugin dependency detected: ${[...visiting, id].join(' → ')}`);
    }
    visiting.add(id);
    const deps = graph.get(id) ?? [];
    for (const dep of deps) visit(dep);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }
  // Sort by priority (descending) before visiting so that ties are broken by priority
  const sorted = [...manifests].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const m of sorted) visit(m.id);
  const idxMap = new Map(order.map((id, i) => [id, i]));
  return [...manifests].sort((a, b) => (idxMap.get(a.id) ?? 0) - (idxMap.get(b.id) ?? 0));
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Safety-scan helpers
// ---------------------------------------------------------------------------
/** Extract declared permissions from an already-parsed package.json object. */
function readPluginPermissions(pkgJson) {
  const ethos = pkgJson.ethos;
  if (typeof ethos !== 'object' || ethos === null || Array.isArray(ethos)) return {};
  const perms = ethos.permissions;
  if (typeof perms !== 'object' || perms === null || Array.isArray(perms)) return {};
  const p = perms;
  const result = {};
  if (p.shell === true) result.shell = true;
  if (Array.isArray(p.network)) {
    result.network = p.network.filter((x) => typeof x === 'string');
  } else if (p.network === true) {
    result.network = []; // declared but no host restriction
  }
  return result;
}
/**
 * Recursively scan all .js/.ts source files under `dir`, aggregating findings.
 * Skips node_modules to avoid scanning thousands of dependency files.
 */
async function scanPluginTree(storage, dir, permissions) {
  const findings = [];
  await collectFindings(storage, dir, permissions, findings);
  return {
    findings,
    hasRed: findings.some((f) => f.severity === 'red'),
    hasYellow: findings.some((f) => f.severity === 'yellow'),
  };
}
async function collectFindings(storage, dir, permissions, out) {
  const entries = await storage.listEntries(dir).catch(() => []);
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDir) {
      if (entry.name === 'node_modules') continue; // skip dep trees
      await collectFindings(storage, fullPath, permissions, out);
    } else if (
      /\.[jt]sx?$|\.(?:cjs|mjs)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.d.cts') &&
      !entry.name.endsWith('.d.mts')
    ) {
      const src = await storage.read(fullPath);
      if (src) out.push(...scanPluginCode(src, permissions).findings);
    }
  }
}
// ---------------------------------------------------------------------------
// Installed plugin manifest discovery
// ---------------------------------------------------------------------------
/**
 * Read installed plugin manifests without activating them. Surfaces
 * what the web Plugins tab shows: name + version + path, no live
 * registry side effects. Discovery order matches `loadAll`:
 * user → project → (npm scan, deferred for now).
 *
 * Returns sorted by name for deterministic UI rendering.
 */
export async function scanInstalledPlugins(opts) {
  const storage = opts.storage ?? new FsStorage();
  const out = [];
  out.push(...(await scanManifestsIn(storage, join(opts.userDir, 'plugins'), 'user')));
  if (opts.workingDir) {
    out.push(
      ...(await scanManifestsIn(storage, join(opts.workingDir, '.ethos', 'plugins'), 'project')),
    );
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
async function scanManifestsIn(storage, dir, source) {
  const entries = await storage.listEntries(dir);
  const out = [];
  for (const entry of entries) {
    if (!entry.isDir) continue;
    // npm-installed plugins live under node_modules/<pkg>/ — `ethos plugin
    // install` runs `npm install --prefix <dir>`, so manual drops and
    // npm installs both need to surface here.
    if (entry.name === 'node_modules') {
      out.push(...(await scanNodeModules(storage, join(dir, 'node_modules'), source)));
      continue;
    }
    const pluginDir = join(dir, entry.name);
    const manifest = await readManifest(storage, pluginDir);
    if (!manifest) continue;
    out.push(toInstalledPluginManifest(manifest, source, pluginDir));
  }
  return out;
}
async function scanNodeModules(storage, nmDir, source) {
  const entries = await storage.listEntries(nmDir);
  const out = [];
  for (const entry of entries) {
    if (!entry.isDir) continue;
    if (entry.name.startsWith('.')) continue; // skip .package-lock.json etc.
    if (entry.name.startsWith('@')) {
      // scoped: walk one level deeper (@scope/<pkg>/)
      const scoped = await storage.listEntries(join(nmDir, entry.name));
      for (const s of scoped) {
        if (!s.isDir) continue;
        const pluginDir = join(nmDir, entry.name, s.name);
        const manifest = await readManifest(storage, pluginDir);
        if (!manifest) continue;
        out.push(toInstalledPluginManifest(manifest, source, pluginDir));
      }
      continue;
    }
    const pluginDir = join(nmDir, entry.name);
    const manifest = await readManifest(storage, pluginDir);
    if (!manifest) continue;
    out.push(toInstalledPluginManifest(manifest, source, pluginDir));
  }
  return out;
}
function toInstalledPluginManifest(manifest, source, pluginDir) {
  const dialect = isOpenClawPackageJson(manifest) && !manifest.ethos ? 'openclaw' : 'ethos';
  const id =
    dialect === 'ethos'
      ? (manifest.ethos?.id ?? manifest.name)
      : (manifest.openclaw?.channel?.id ?? manifest.name);
  return {
    id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? null,
    source,
    path: pluginDir,
    pluginContractMajor: manifest.ethos?.pluginContractMajor ?? null,
    dialect,
    credentials: manifest.ethos?.credentials ?? [],
  };
}
async function readManifest(storage, pluginDir) {
  const raw = await storage.read(join(pluginDir, 'package.json'));
  if (raw === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Accept any package with an ethos field, or OpenClaw plugins (openclaw block present)
  if (!parsed.ethos && !isOpenClawPackageJson(parsed)) return null;
  return parsed;
}
function isPluginModule(mod) {
  return (
    mod !== null &&
    typeof mod === 'object' &&
    'activate' in mod &&
    typeof mod.activate === 'function'
  );
}
/**
 * Phase 30.6 — read the plugin's package.json (if present) and return a
 * rejection message string when the declared `ethos.pluginContractMajor` is
 * incompatible with the current contract. Returns `null` to allow the load.
 *
 * Plugins without a package.json or without the field are allowed (older
 * plugins predating the field; in-development plugins).
 */
async function checkContractMajorFromDir(storage, dir, id) {
  const src = await storage.read(join(dir, 'package.json'));
  if (!src) return null; // no package.json — allow (loader-only plugin)
  let raw;
  try {
    raw = JSON.parse(src);
  } catch {
    return null;
  }
  const declared = raw.ethos?.pluginContractMajor;
  const result = checkPluginContractMajor(declared, undefined, id);
  return result.ok ? null : (result.reason ?? `Plugin "${id}" rejected`);
}
/**
 * Returns true when `candidate` resolves to a path inside `container`.
 * Prevents path-traversal attacks via entries like `"main": "../../evil.js"`.
 */
function isContainedIn(candidate, container) {
  const resolved = resolve(candidate);
  const base = resolve(container);
  return resolved === base || resolved.startsWith(`${base}/`);
}
async function resolveEntry(storage, dir) {
  for (const name of ['index.ts', 'index.js', 'src/index.ts', 'src/index.js']) {
    const candidate = join(dir, name);
    if (await storage.exists(candidate)) return candidate;
  }
  // Check package.json main/exports
  const src = await storage.read(join(dir, 'package.json'));
  if (!src) return null;
  try {
    const raw = JSON.parse(src);
    const main = raw.main;
    if (main) {
      const candidate = join(dir, main);
      if (!isContainedIn(candidate, dir)) return null;
      if (await storage.exists(candidate)) return candidate;
    }
  } catch {
    // no parseable package.json
  }
  return null;
}
function resolveNpmEntry(pkg, dir) {
  const main = pkg.main;
  if (main) {
    const candidate = join(dir, main);
    return isContainedIn(candidate, dir) ? candidate : null;
  }
  const exports = pkg.exports;
  if (exports?.['.']) {
    const exp = exports['.'];
    if (typeof exp === 'string') {
      const candidate = join(dir, exp);
      return isContainedIn(candidate, dir) ? candidate : null;
    }
    if (typeof exp === 'object' && exp !== null) {
      const sub = exp;
      const raw = sub.import ?? sub.default ?? sub.require ?? '';
      if (!raw) return null;
      const candidate = join(dir, raw);
      return isContainedIn(candidate, dir) ? candidate : null;
    }
  }
  return join(dir, 'index.js');
}
