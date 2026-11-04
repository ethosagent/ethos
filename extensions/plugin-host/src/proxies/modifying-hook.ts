import type { ModifyingHooks } from '@ethosagent/types';
import type { HostLease } from '../pool';

/**
 * One proxy per (plugin, modifying hook name). The host runs the plugin's
 * handlers through a local `DefaultHookRegistry.fireModifying`, so the
 * within-plugin merge is the in-process one. A timeout, a crash or a throw
 * yields null, which is today's fail-open. `before_prompt_build.overrideSystem`
 * is dropped (D18).
 */
export function createModifyingHookProxy<K extends keyof ModifyingHooks>(
  name: K,
  lease: HostLease,
): (payload: ModifyingHooks[K][0]) => Promise<Partial<ModifyingHooks[K][1]> | null> {
  return async (payload) => {
    const result = await lease.fireModifying(name, payload);
    if (!result) return null;
    const { overrideSystem: _dropped, ...rest } = result;
    const kept = name === 'before_prompt_build' ? rest : result;
    const out: Partial<ModifyingHooks[K][1]> = {};
    Object.assign(out, kept);
    return out;
  };
}
