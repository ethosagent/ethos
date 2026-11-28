// WorldToolPort: what the `world_*` tools get (plan world-model Task 2.4).
//
// A frozen object holding ONLY these eleven methods, each bound to one
// WorldService. It has no provider, no `purge`, no `acceptProposal`, no
// `rejectProposal`, no `promoteToUser`, no `ownerWrite`/`ownerImport` and no
// config writer, so a tool cannot reach what an owner surface owns. Pinned by
// `__tests__/world-port.test.ts` 'R13 tool port is narrow' (exact key list,
// frozen, functions only). The type is the interface below: wiring builds the
// object with `createWorldToolPort`, and tools-world depends on the type.

import type { FactInput, GraphBundle, GraphQuery, TimeSlice } from '@ethosagent/types';
import type { ResolvedWorld } from './access';
import type { BuildIO, BuildReply, BuildRequest, WorldBuildService } from './build/build';
import type { SchemaChange } from './schema-diff';
import type {
  Caller,
  ImportOutcome,
  SchemaRequestOutcome,
  TaggedFacts,
  WorldService,
  WriteOutcome,
} from './service';

export interface WorldToolPort {
  visible(c: Caller): Promise<ResolvedWorld[]>;
  query(c: Caller, world: string | null, q: GraphQuery, slice?: TimeSlice): Promise<TaggedFacts>;
  neighbours(
    c: Caller,
    world: string | null,
    ref: string,
    hops: number,
    slice?: TimeSlice,
  ): Promise<TaggedFacts>;
  history(c: Caller, world: string, ref: string): Promise<TaggedFacts>;
  writeFacts(
    c: Caller,
    world: string | null,
    facts: FactInput[],
    why: string,
  ): Promise<WriteOutcome>;
  closeFact(
    c: Caller,
    world: string | null,
    factId: string,
    validTo: string,
    sourceRef: string,
  ): Promise<WriteOutcome>;
  proposeFacts(
    c: Caller,
    world: string | null,
    facts: FactInput[],
    why: string,
  ): Promise<WriteOutcome>;
  requestSchemaChange(
    c: Caller,
    world: string | null,
    change: SchemaChange,
    reason: string,
  ): Promise<SchemaRequestOutcome>;
  importBundle(c: Caller, world: string | null, bundle: GraphBundle): Promise<ImportOutcome>;
  exportBundle(c: Caller, world: string | null): Promise<GraphBundle>;
  /**
   * The first-build flow (estimate, run, save). `io` carries what only the
   * calling turn has: its own fs reach. `{ refused: 'not_available' }` when
   * no build runtime is composed (world-build.test.ts).
   */
  build(
    c: Caller,
    world: string | null,
    req: BuildRequest,
    io: BuildIO,
  ): Promise<BuildReply | { refused: 'not_available' }>;
}

export function createWorldToolPort(
  service: WorldService,
  builder?: WorldBuildService,
): WorldToolPort {
  const port: WorldToolPort = {
    visible: (c) => service.visible(c),
    query: (c, world, q, slice) => service.query(c, world, q, slice),
    neighbours: (c, world, ref, hops, slice) => service.neighbours(c, world, ref, hops, slice),
    history: (c, world, ref) => service.history(c, world, ref),
    writeFacts: (c, world, facts, why) => service.writeFacts(c, world, facts, why),
    closeFact: (c, world, factId, validTo, sourceRef) =>
      service.closeFact(c, world, factId, validTo, sourceRef),
    proposeFacts: (c, world, facts, why) => service.proposeFacts(c, world, facts, why),
    requestSchemaChange: (c, world, change, reason) =>
      service.requestSchemaChange(c, world, change, reason),
    importBundle: (c, world, bundle) => service.importBundle(c, world, bundle),
    exportBundle: (c, world) => service.exportBundle(c, world),
    build: async (c, world, req, io) =>
      builder ? builder.handle(c, world, req, io) : { refused: 'not_available' as const },
  };
  return Object.freeze(port);
}
