import type { EthosPluginApi } from '@ethosagent/plugin-sdk';
import { isModifyingHook, isVoidHook } from '../hook-names';
import type { HostLease } from '../pool';
import type { Registration } from '../protocol';
import { createModifyingHookProxy } from './modifying-hook';
import { createToolProxy } from './tool';
import { createVoidHookProxy } from './void-hook';

/** Replays one host registration onto the parent's real `PluginApiImpl` as a proxy. */
export function replayRegistration(api: EthosPluginApi, reg: Registration, lease: HostLease): void {
  if (reg.kind === 'tool') {
    api.registerTool(createToolProxy(reg, lease));
    return;
  }
  if (reg.model === 'void') {
    if (!isVoidHook(reg.name))
      throw new Error(`Hosted plugin registered unknown void hook '${reg.name}'`);
    api.registerVoidHook(reg.name, createVoidHookProxy(reg.name, lease));
    return;
  }
  if (!isModifyingHook(reg.name)) {
    throw new Error(`Hosted plugin registered unknown modifying hook '${reg.name}'`);
  }
  api.registerModifyingHook(reg.name, createModifyingHookProxy(reg.name, lease));
}
