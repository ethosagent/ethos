import type { VoidHooks } from '@ethosagent/types';
import type { HostLease } from '../pool';

/**
 * One proxy per (plugin, void hook name). Never awaits the host: the payload
 * joins the host's bounded FIFO queue (1000, drop-oldest, counted) and the
 * returned promise resolves at once (D10).
 */
export function createVoidHookProxy<K extends keyof VoidHooks>(
  name: K,
  lease: HostLease,
): (payload: VoidHooks[K]) => Promise<void> {
  return (payload) => {
    lease.fireVoid(name, payload);
    return Promise.resolve();
  };
}
