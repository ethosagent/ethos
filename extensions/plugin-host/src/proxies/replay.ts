import type { EthosPluginApi } from '@ethosagent/plugin-sdk';
import type { ToolRegistry } from '@ethosagent/types';
import { isModifyingHook, isVoidHook } from '../hook-names';
import type { HostLease } from '../pool';
import type { Registration } from '../protocol';
import {
  isOAuthProfile,
  isPageSpec,
  isPersonalityConfig,
  isRendererSpec,
} from '../registration-parse';
import { isInsideStateDir } from '../util';
import { createCliHandler, createSlashHandler } from './commands';
import { createModifyingHookProxy } from './modifying-hook';
import {
  createEvaluatorProxy,
  createExtractor,
  createFilterProxy,
  createHealthCheck,
  createInjectorProxy,
  createRouteHandler,
} from './registry-rows';
import { createToolProxy } from './tool';
import { createVoidHookProxy } from './void-hook';

export interface ReplayGuard {
  tools?: Pick<ToolRegistry, 'get' | 'getPluginId'>;
}

/**
 * Refuses a hosted tool whose name already exists in the parent registry under
 * another owner (a built-in has none). Enforcer of the "tool named like a
 * built-in is refused at replay" rule; pinned by `isolation-boundary.test.ts`.
 */
export function assertToolNameFree(reg: Registration, lease: HostLease, guard: ReplayGuard): void {
  if (reg.kind !== 'tool' || !guard.tools) return;
  const existing = guard.tools.get(reg.name);
  if (!existing || guard.tools.getPluginId?.(reg.name) === lease.pluginId) return;
  lease.emitEvent('plugin_host.denied', {
    plugin_id: lease.pluginId,
    kind: 'registration',
    ref: reg.name,
  });
  throw new Error(
    `Hosted plugin '${lease.pluginId}' registered a tool named '${reg.name}', which already exists in the parent tool registry (a hosted plugin cannot shadow a built-in or another plugin's tool)`,
  );
}

function refuse(lease: HostLease, what: string): never {
  throw new Error(`Hosted plugin '${lease.pluginId}' sent an invalid ${what} registration`);
}

/**
 * Replays one host registration onto the parent's real `PluginApiImpl` as a
 * proxy (plan §4.2). A registration the parent will not accept throws, which
 * fails the plugin's load through the loader's normal failure path (D9).
 * `registerDocumentExtractor` needs `extractors` because the SDK method is on
 * the api: it is called here like the others.
 */
export function replayRegistration(
  api: EthosPluginApi,
  reg: Registration,
  lease: HostLease,
  guard: ReplayGuard = {},
): void {
  switch (reg.kind) {
    case 'tool':
      assertToolNameFree(reg, lease, guard);
      api.registerTool(createToolProxy(reg, lease));
      return;
    case 'hook':
      if (reg.model === 'void') {
        if (!isVoidHook(reg.name)) {
          throw new Error(`Hosted plugin registered unknown void hook '${reg.name}'`);
        }
        api.registerVoidHook(reg.name, createVoidHookProxy(reg.name, lease));
        return;
      }
      if (!isModifyingHook(reg.name)) {
        throw new Error(`Hosted plugin registered unknown modifying hook '${reg.name}'`);
      }
      api.registerModifyingHook(reg.name, createModifyingHookProxy(reg.name, lease));
      return;
    case 'injector':
      api.registerInjector(createInjectorProxy(reg, lease));
      return;
    case 'filter':
      api.registerToolFilter(createFilterProxy(reg, lease));
      return;
    case 'evaluator':
      api.registerEvaluator(createEvaluatorProxy(reg, lease));
      return;
    case 'route':
      api.registerRoute({
        ...(reg.method === 'GET' ||
        reg.method === 'POST' ||
        reg.method === 'PUT' ||
        reg.method === 'DELETE'
          ? { method: reg.method }
          : {}),
        path: reg.path,
        handler: createRouteHandler(reg, lease),
      });
      return;
    case 'health_check':
      api.registerHealthCheck(createHealthCheck(reg, lease));
      return;
    case 'slash':
      api.registerSlashCommand({
        name: reg.name,
        description: reg.description,
        usage: reg.usage,
        handler: createSlashHandler(reg, lease),
      });
      return;
    case 'cli':
      api.registerCliSubcommand({
        name: reg.name,
        description: reg.description,
        handler: createCliHandler(reg, lease),
      });
      return;
    case 'extractor':
      api.registerDocumentExtractor(createExtractor(reg, lease));
      return;
    case 'data_source':
      if (!isInsideStateDir(lease.stateDir, reg.path)) {
        throw new Error(
          `Plugin '${lease.pluginId}' registerDataSource('${reg.id}') path '${reg.path}' is outside its state dir '${lease.stateDir}'`,
        );
      }
      api.registerDataSource(reg.id, reg.path);
      return;
    case 'personality':
      if (!isPersonalityConfig(reg.data)) refuse(lease, 'personality');
      api.registerPersonality(reg.data);
      return;
    case 'oauth_profile':
      if (!isOAuthProfile(reg.data)) refuse(lease, 'OAuth profile');
      api.registerOAuthProfile(reg.data);
      return;
    case 'page':
      if (!isPageSpec(reg.data)) refuse(lease, 'plugin page');
      api.registerPluginPage(reg.data);
      return;
    case 'renderer':
      if (!isRendererSpec(reg.data)) refuse(lease, 'renderer');
      api.registerRenderer(reg.data);
      return;
  }
}
