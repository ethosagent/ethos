/** Returns true when a handler should fire given the allowedPlugins filter.
 *  When `allowedPlugins` is omitted, only built-in handlers (no `pluginId`)
 *  are allowed — plugin-registered handlers are blocked by default. */
function isAllowed(h, allowedPlugins) {
  if (!h.pluginId) return true; // built-in handler — always fires
  if (allowedPlugins === undefined) return false; // no allowlist — block plugin handlers
  return allowedPlugins.includes(h.pluginId);
}
export class DefaultHookRegistry {
  voidHandlers = new Map();
  modifyingHandlers = new Map();
  claimingHandlers = new Map();
  registerVoid(name, handler, opts) {
    const entry = {
      handler: handler,
      pluginId: opts?.pluginId,
      failurePolicy: opts?.failurePolicy ?? 'fail-open',
    };
    const list = this.voidHandlers.get(name) ?? [];
    list.push(entry);
    this.voidHandlers.set(name, list);
    return () => this.remove(this.voidHandlers, name, entry);
  }
  registerModifying(name, handler, opts) {
    const entry = {
      handler: handler,
      pluginId: opts?.pluginId,
      failurePolicy: 'fail-open',
    };
    const list = this.modifyingHandlers.get(name) ?? [];
    list.push(entry);
    this.modifyingHandlers.set(name, list);
    return () => this.remove(this.modifyingHandlers, name, entry);
  }
  registerClaiming(name, handler, opts) {
    const entry = {
      handler: handler,
      pluginId: opts?.pluginId,
      failurePolicy: 'fail-open',
    };
    const list = this.claimingHandlers.get(name) ?? [];
    list.push(entry);
    this.claimingHandlers.set(name, list);
    return () => this.remove(this.claimingHandlers, name, entry);
  }
  // Void hooks: all handlers run in parallel via Promise.allSettled.
  // Failures are logged but never propagate (fail-open by default).
  // allowedPlugins gates plugin-registered handlers; built-in handlers always fire.
  async fireVoid(name, payload, allowedPlugins) {
    const handlers = (this.voidHandlers.get(name) ?? []).filter((h) =>
      isAllowed(h, allowedPlugins),
    );
    await Promise.allSettled(handlers.map((h) => h.handler(payload)));
  }
  // Modifying hooks: handlers run sequentially; results are merged (first non-null value per key wins).
  async fireModifying(name, payload, allowedPlugins) {
    const handlers = (this.modifyingHandlers.get(name) ?? []).filter((h) =>
      isAllowed(h, allowedPlugins),
    );
    const merged = {};
    for (const h of handlers) {
      try {
        const result = await h.handler(payload);
        if (result && typeof result === 'object') {
          for (const [k, v] of Object.entries(result)) {
            if (!(k in merged) && v !== null && v !== undefined) {
              merged[k] = v;
            }
          }
        }
      } catch {
        // fail-open: continue with other handlers
      }
    }
    return merged;
  }
  // Claiming hooks: handlers run sequentially, stop after first { handled: true }.
  async fireClaiming(name, payload, allowedPlugins) {
    const handlers = (this.claimingHandlers.get(name) ?? []).filter((h) =>
      isAllowed(h, allowedPlugins),
    );
    for (const h of handlers) {
      try {
        const result = await h.handler(payload);
        if (result && result.handled) {
          return result;
        }
      } catch {
        // fail-open: try next handler
      }
    }
    return { handled: false };
  }
  unregisterPlugin(pluginId) {
    for (const map of [this.voidHandlers, this.modifyingHandlers, this.claimingHandlers]) {
      for (const [name, handlers] of map.entries()) {
        map.set(
          name,
          handlers.filter((h) => h.pluginId !== pluginId),
        );
      }
    }
  }
  remove(map, name, entry) {
    const list = map.get(name) ?? [];
    map.set(
      name,
      list.filter((h) => h !== entry),
    );
  }
}
