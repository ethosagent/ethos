// A real WorldService over the world-service test fakes (FakeWorldGraphProvider,
// real service.db, real config and schema services), reached through the real
// narrow WorldToolPort. gateway's memory-boundary-e2e test imports sibling
// packages by relative path the same way.

import type { ToolContext, ToolResult } from '@ethosagent/types';
import {
  createWorldToolPort,
  type WorldBuildDeps,
  WorldBuildService,
  type WorldToolPort,
} from '@ethosagent/world-service';
import {
  type ServiceHarness,
  serviceHarness,
} from '../../../world-service/src/__tests__/service-harness';

export const ctxFor = (over: Partial<ToolContext> = {}): ToolContext => ({
  sessionId: 's-41',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
  personalityId: 'engineer',
  roomAudience: 'private',
  ...over,
});

export interface ToolHarness extends ServiceHarness {
  port: WorldToolPort;
}

export async function toolHarness(
  opts: Parameters<typeof serviceHarness>[0] & {
    /** Build wiring over the harness service; omit for a port with no build runtime. */
    build?: (h: ServiceHarness) => Omit<WorldBuildDeps, 'service' | 'store' | 'schema'>;
  } = {},
): Promise<ToolHarness> {
  const { build, ...rest } = opts;
  const h = await serviceHarness(rest);
  const builder = build
    ? new WorldBuildService({ service: h.service, store: h.store, schema: h.schema, ...build(h) })
    : undefined;
  return Object.assign(h, { port: createWorldToolPort(h.service, builder) });
}

/** The text of a result, whether it succeeded or not. */
export const textOf = (r: ToolResult): string => (r.ok ? r.value : r.error);

/** Add a shared world and mount it for `engineer`. */
export async function addWorld(
  h: ToolHarness,
  id: string,
  opts: { audience?: 'owner_only' | 'shareable'; mount?: boolean; mode?: 'propose' | 'read' } = {},
): Promise<void> {
  await h.config.writeWorld(
    {
      id,
      title: id,
      audience: opts.audience ?? 'shareable',
      readers: opts.mode === 'read' ? ['engineer'] : [],
      proposers: opts.mode === 'read' ? [] : ['engineer'],
    },
    { by: 'test' },
  );
  if (opts.mount === false) return;
  const mounts = await h.config.readMounts('engineer');
  await h.config.writeMounts(
    'engineer',
    { mounts: [...mounts.mounts, { world: id, mode: opts.mode ?? 'propose' }] },
    { by: 'test' },
  );
}
