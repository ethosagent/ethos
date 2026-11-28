// Shared setup for schema-rules / schema-service tests: a real SQLiteWorldServiceStore
// in a temp dir, a FakeStorage, a FakeWorldGraphProvider, and a WorldSchemaService.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorldId } from '@ethosagent/types';
import { WorldSchemaService, worldSchemaPath } from '../schema-service';
import { SQLiteWorldServiceStore, serviceDbPath } from '../service-store';
import { FakeStorage, FakeWorldGraphProvider } from './fakes';

export const STARTER = `version: 1
entities:
  Team: { attrs: { mission: { type: string } } }
  Person: { attrs: { email: { type: string } } }
  Skill: { attrs: {} }
edges:
  member_of: { from: [Person], to: [Team], attrs: { role: { type: string } } }
  expert_in: "Person -> Skill"
  depends_on: "Team -> Team"
`;

export interface Harness {
  dir: string;
  storage: FakeStorage;
  provider: FakeWorldGraphProvider;
  store: SQLiteWorldServiceStore;
  service: WorldSchemaService;
  /** Hand-write the starter schema.yaml for `world` and load it (records v1). */
  seed(world: WorldId, yaml?: string): Promise<void>;
  path(world: WorldId): string;
  dispose(): void;
}

export async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'world-service-'));
  const storage = new FakeStorage();
  const provider = new FakeWorldGraphProvider();
  let tick = 0;
  const now = () => Date.UTC(2026, 10, 28, 12, 0, tick++);
  const store = new SQLiteWorldServiceStore(serviceDbPath(dir), { now: () => new Date(now()) });
  const service = new WorldSchemaService({
    storage,
    dataDir: dir,
    store,
    provider: async () => provider,
    now,
  });
  return {
    dir,
    storage,
    provider,
    store,
    service,
    async seed(world, yaml = STARTER) {
      storage.files.set(worldSchemaPath(dir, world), yaml);
      await service.load(world);
    },
    path: (world) => worldSchemaPath(dir, world),
    dispose() {
      store.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
