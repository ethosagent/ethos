import { isAbsolute, relative, resolve } from 'node:path';
import { PluginApiImpl } from '@ethosagent/plugin-sdk';
import type { Registration } from '../protocol';
import { type ChildRows, UNSUPPORTED } from './registries';

/** Where the tap reports what a plugin registered. */
export interface TapSink {
  rows: ChildRows;
  /** `<dataDir>/plugin-hosts/<id>`: the only place `registerDataSource` may point (D21). */
  stateDir: string;
  add(reg: Registration): void;
  /** A monitor or route now exists, so the host is long-lived (eager restart, D15). */
  longLived(): void;
}

let sink: TapSink | null = null;
let installed = false;

function need(): TapSink {
  if (!sink) throw new Error('plugin host api tap used before it was bound');
  return sink;
}

function insideStateDir(stateDir: string, path: string): boolean {
  const rel = relative(resolve(stateDir), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Observes what the plugin registers through its `PluginApiImpl`, without
 * touching the loader. `PluginLoader` builds the api privately, and several
 * registrations (`registerHealthCheck`, slash and CLI handlers, `registerOAuth`)
 * never reach `PluginRegistries`, so the only seam is the class itself.
 * Each wrapper calls the original first (its own checks, and the unsupported
 * registries, still throw naturally), then records the row. This runs only
 * inside the host process, where one plugin is loaded, so patching the
 * prototype is contained; it is idempotent.
 */
export function installApiTap(target: TapSink): void {
  sink = target;
  if (installed) return;
  installed = true;
  const proto = PluginApiImpl.prototype;

  const injector = proto.registerInjector;
  proto.registerInjector = function (this: PluginApiImpl, inj) {
    injector.call(this, inj);
    const s = need();
    s.rows.injectors.push(inj);
    s.add({
      kind: 'injector',
      index: s.rows.injectors.length - 1,
      id: inj.id,
      priority: inj.priority,
    });
  };

  const filter = proto.registerToolFilter;
  proto.registerToolFilter = function (this: PluginApiImpl, f) {
    filter.call(this, f);
    const s = need();
    s.add({
      kind: 'filter',
      index: s.rows.filters.length - 1,
      ...(f.toolName !== undefined ? { toolName: f.toolName } : {}),
      ...(f.toolset !== undefined ? { toolset: f.toolset } : {}),
      before: typeof f.before === 'function',
      after: typeof f.after === 'function',
    });
  };

  const evaluator = proto.registerEvaluator;
  proto.registerEvaluator = function (this: PluginApiImpl, e) {
    evaluator.call(this, e);
    const s = need();
    s.add({ kind: 'evaluator', index: s.rows.evaluators.length - 1, name: e.name });
  };

  const route = proto.registerRoute;
  proto.registerRoute = function (this: PluginApiImpl, opts) {
    route.call(this, opts);
    const s = need();
    s.add({
      kind: 'route',
      index: s.rows.routes.length - 1,
      method: opts.method ?? 'POST',
      path: opts.path,
    });
    s.longLived();
  };

  const health = proto.registerHealthCheck;
  proto.registerHealthCheck = function (this: PluginApiImpl, check) {
    health.call(this, check);
    const s = need();
    s.rows.healthChecks.push(check);
    s.add({
      kind: 'health_check',
      index: s.rows.healthChecks.length - 1,
      name: check.name,
      description: check.description,
    });
  };

  const slash = proto.registerSlashCommand;
  proto.registerSlashCommand = function (this: PluginApiImpl, cmd) {
    slash.call(this, cmd);
    const s = need();
    const name = cmd.name.toLowerCase();
    s.rows.slash.set(name, cmd.handler);
    s.add({ kind: 'slash', name, description: cmd.description, usage: cmd.usage });
  };

  const cli = proto.registerCliSubcommand;
  proto.registerCliSubcommand = function (this: PluginApiImpl, cmd) {
    cli.call(this, cmd);
    const s = need();
    const name = cmd.name.toLowerCase();
    s.rows.cli.set(name, cmd.handler);
    s.add({ kind: 'cli', name, description: cmd.description });
  };

  const extractor = proto.registerDocumentExtractor;
  proto.registerDocumentExtractor = function (this: PluginApiImpl, ex) {
    extractor.call(this, ex);
    const s = need();
    s.rows.extractors.push(ex);
    s.add({
      kind: 'extractor',
      index: s.rows.extractors.length - 1,
      name: ex.name,
      mimeTypes: ex.mimeTypes,
      ...(ex.maxInputBytes !== undefined ? { maxInputBytes: ex.maxInputBytes } : {}),
    });
  };

  const dataSource = proto.registerDataSource;
  proto.registerDataSource = function (this: PluginApiImpl, id, path) {
    const s = need();
    if (!insideStateDir(s.stateDir, path)) {
      throw new Error(
        `registerDataSource('${id}') path '${path}' must be inside the plugin host state dir '${s.stateDir}'`,
      );
    }
    dataSource.call(this, id, resolve(path));
    s.add({ kind: 'data_source', id, path: resolve(path) });
  };

  const personality = proto.registerPersonality;
  proto.registerPersonality = function (this: PluginApiImpl, config) {
    personality.call(this, config);
    need().add({ kind: 'personality', data: plain(config) });
  };

  const profile = proto.registerOAuthProfile;
  proto.registerOAuthProfile = function (this: PluginApiImpl, p) {
    profile.call(this, p);
    need().add({ kind: 'oauth_profile', data: plain(p) });
  };

  const page = proto.registerPluginPage;
  proto.registerPluginPage = function (this: PluginApiImpl, spec) {
    page.call(this, spec);
    need().add({ kind: 'page', data: plain(spec) });
  };

  const renderer = proto.registerRenderer;
  proto.registerRenderer = function (this: PluginApiImpl, spec) {
    renderer.call(this, spec);
    need().add({ kind: 'renderer', data: plain(spec) });
  };

  // OAuthConfig carries `buildAuthUrl` (synchronous) and `onCallback`: not data, and not an RPC.
  proto.registerOAuth = function (this: PluginApiImpl) {
    throw new Error(UNSUPPORTED('registerOAuth'));
  };

  const monitor = proto.startMonitor;
  proto.startMonitor = function (this: PluginApiImpl, name, params) {
    monitor.call(this, name, params);
    need().longLived();
  };
}

/** A JSON round trip: functions and `undefined` fall away, so only data is replayed. */
function plain(value: object): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? { ...parsed }
    : {};
}
