// Shared setup for the WorldService tests (write-routing, fact-vetting,
// world-port): a real SQLiteWorldServiceStore, a FakeStorage, ONE
// FakeWorldGraphProvider serving every world (it keeps facts per world id),
// and the real config, schema and service classes on top.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { WorldId } from '@ethosagent/types';
import { WorldConfigService } from '../config-service';
import { WorldSchemaService, worldSchemaPath } from '../schema-service';
import { type Caller, WorldService } from '../service';
import { SQLiteWorldServiceStore, serviceDbPath } from '../service-store';
import { FakeWorldGraphProvider } from './fakes';

export const SCHEMA = `version: 1
entities:
  Person:
    attrs:
      email: { type: string }
      title: { type: string }
      salary: { type: int, sensitive: true }
  Service:
    attrs:
      tier: { type: string }
  Skill: { attrs: {} }
edges:
  owns: { from: [Person], to: [Service], attrs: {}, unique: to }
  expert_in: "Person -> Skill"
`;

export const PRIVATE: WorldId = 'personality:engineer';
export const ACME: WorldId = 'world:acme';

export const caller = (over: Partial<Caller> = {}): Caller => ({
  personalityId: 'engineer',
  audience: 'private',
  sessionId: 's1',
  surface: 'tool',
  ...over,
});

export interface ServiceHarness {
  dir: string;
  provider: FakeWorldGraphProvider;
  store: SQLiteWorldServiceStore;
  service: WorldService;
  schema: WorldSchemaService;
  errors: unknown[];
  dispose(): void;
}

export async function serviceHarness(
  opts: { mountAcme?: boolean; schemaFor?: WorldId[] } = {},
): Promise<ServiceHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'world-service-svc-'));
  const storage = new InMemoryStorage();
  const provider = new FakeWorldGraphProvider();
  let tick = 0;
  const now = () => Date.UTC(2026, 10, 28, 12, 0, tick++);
  const store = new SQLiteWorldServiceStore(serviceDbPath(dir), { now: () => new Date(now()) });
  const schema = new WorldSchemaService({
    storage,
    dataDir: dir,
    store,
    provider: async () => provider,
    now,
  });
  const config = new WorldConfigService({ storage, dataDir: dir, now: () => new Date(now()) });
  await config.writeWorld(
    { id: 'acme', title: 'Acme', audience: 'shareable', readers: [], proposers: ['engineer'] },
    { by: 'test' },
  );
  if (opts.mountAcme !== false) {
    await config.writeMounts(
      'engineer',
      { mounts: [{ world: 'acme', mode: 'propose' }] },
      { by: 'test' },
    );
  }
  for (const w of opts.schemaFor ?? [PRIVATE, ACME]) {
    await storage.mkdir(dirname(worldSchemaPath(dir, w)));
    await storage.write(worldSchemaPath(dir, w), SCHEMA);
    await schema.load(w);
  }
  const errors: unknown[] = [];
  const service = new WorldService({
    providers: async () => provider,
    schema,
    store,
    config,
    now,
    onError: (e) => errors.push(e),
  });
  return {
    dir,
    provider,
    store,
    service,
    schema,
    errors,
    dispose() {
      store.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
