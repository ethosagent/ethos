import type { PluginApiImpl } from '@ethosagent/plugin-sdk';
import type { Registration } from '../protocol';
import { regKey } from '../registration-diff';
import { type ChildData, type ChildRows, UNSUPPORTED } from './registries';

export interface RowSyncOptions {
  rows: ChildRows;
  data: ChildData;
  /** The plugin's loaded api, read through `PluginLoader.getApi`. Undefined until the load finishes. */
  api: () => PluginApiImpl | undefined;
  /** What the plugin put in `registries.pluginPages` / `renderers`, read live. */
  pages: () => Iterable<object>;
  renderers: () => Iterable<object>;
  /** `registries.dataSources.get(pluginId)`, already confined to the state dir by `StateDirMap`. */
  dataSources: () => ReadonlyMap<string, string>;
}

/**
 * Reads what the plugin registered, from the registries this host owns and from
 * the loaded `PluginApiImpl`'s public getters (slash, cli and health checks never
 * reach a registry). Each call returns only rows not reported before, so the
 * runtime calls it after the load and again after every request, which is how a
 * registration made after `activate()` reaches the parent as `registration.added`.
 * A registration made by a timer between two requests is announced at the next
 * one (the parent pings periodically), not at the instant it happens.
 */
export function createRowSync(opts: RowSyncOptions): { collect(): Registration[] } {
  const seen = new Set<string>();
  const { rows, data } = opts;

  const fresh = (out: Registration[], reg: Registration): void => {
    const key = regKey(reg);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(reg);
  };

  return {
    collect() {
      const out: Registration[] = [];
      const api = opts.api();

      rows.injectors.forEach((inj, index) => {
        fresh(out, { kind: 'injector', index, id: inj.id, priority: inj.priority });
      });
      rows.filters.forEach((f, index) => {
        fresh(out, {
          kind: 'filter',
          index,
          ...(f.toolName !== undefined ? { toolName: f.toolName } : {}),
          ...(f.toolset !== undefined ? { toolset: f.toolset } : {}),
          before: typeof f.before === 'function',
          after: typeof f.after === 'function',
        });
      });
      rows.evaluators.forEach((e, index) => {
        fresh(out, { kind: 'evaluator', index, name: e.name });
      });
      rows.routes.forEach((r, index) => {
        fresh(out, { kind: 'route', index, method: r.method, path: r.path });
      });
      rows.extractors.forEach((ex, index) => {
        fresh(out, {
          kind: 'extractor',
          index,
          name: ex.name,
          mimeTypes: ex.mimeTypes,
          ...(ex.maxInputBytes !== undefined ? { maxInputBytes: ex.maxInputBytes } : {}),
        });
      });
      for (const [id, path] of opts.dataSources()) fresh(out, { kind: 'data_source', id, path });
      for (const config of data.personalities) {
        fresh(out, { kind: 'personality', data: plain(config) });
      }
      for (const profile of data.oauthProfiles) {
        fresh(out, { kind: 'oauth_profile', data: plain(profile) });
      }
      for (const spec of opts.pages()) fresh(out, { kind: 'page', data: plain(spec) });
      for (const spec of opts.renderers()) fresh(out, { kind: 'renderer', data: plain(spec) });

      if (!api) return out;

      // `healthChecks` is the api's own array, so the index is the api's.
      rows.healthChecks.length = 0;
      api.getHealthChecks().forEach((check, index) => {
        rows.healthChecks.push(check);
        fresh(out, {
          kind: 'health_check',
          index,
          name: check.name,
          description: check.description,
        });
      });
      for (const cmd of api.getAllSlashCommands()) {
        const handler = api.getSlashHandler(cmd.name);
        if (handler) rows.slash.set(cmd.name, handler);
        fresh(out, { kind: 'slash', ...cmd });
      }
      for (const cmd of api.getAllCliSubcommands()) {
        const handler = api.getCliSubcommandHandler(cmd.name);
        if (handler) rows.cli.set(cmd.name, handler);
        fresh(out, { kind: 'cli', ...cmd });
      }
      return out;
    },
  };
}

/**
 * `registerOAuth` takes an `OAuthConfig` with a synchronous `buildAuthUrl` and an
 * `onCallback`: not data, not an RPC. The api only stores it, so the refusal is
 * made after the load, from `getOAuthConfig()`. Throws the unsupported error.
 */
export function refuseOAuthConfig(api: PluginApiImpl | undefined): void {
  if (api?.getOAuthConfig() !== undefined) throw new Error(UNSUPPORTED('registerOAuth'));
}

/** A JSON round trip: functions and `undefined` fall away, so only data is replayed. */
function plain(value: object): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? { ...parsed }
    : {};
}
