// Memory-provider helpers for `buildAgentLoop`, extracted from build-agent-loop.ts
// (size gate); build-agent-loop.ts is their only caller.
import type { MemoryProvider } from '@ethosagent/types';

/**
 * `MemoryProvider` (five methods, drift-gated) has no close; a backend that
 * holds a connection of its own — memory-vector's memory.db — exposes one.
 */
export async function closeMemoryProvider(provider: MemoryProvider): Promise<void> {
  const close = (provider as Partial<{ close: () => unknown }>).close;
  if (typeof close === 'function') await close.call(provider);
}

/**
 * L-T3 — the replay arm's memory: reads pass through, `sync` does nothing.
 *
 * A replay is a measurement: it must not record what it said. The backends
 * write through `WiringContext.storage`, which under replay IS the overlay, so
 * the alternative to a no-op is a `BoundaryError` — a `memory_write` coming
 * back as a tool failure the model then reasons about, which changes the very
 * behaviour the arm is measuring. A no-op `sync` is the honest shape: memory is
 * READ exactly as the live agent reads it, and nothing is written.
 *
 * Not a reusable policy: it is one arm of `CreateAgentLoopOptions.replay`, and
 * build-agent-loop.ts is its only caller.
 */
export function readOnlyMemory(base: MemoryProvider): MemoryProvider {
  return {
    prefetch: (ctx) => base.prefetch(ctx),
    read: (key, ctx) => base.read(key, ctx),
    search: (query, ctx, opts) => base.search(query, ctx, opts),
    list: (ctx, opts) => base.list(ctx, opts),
    sync: async () => {},
  };
}
