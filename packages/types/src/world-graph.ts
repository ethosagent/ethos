// World graph contract — the 14-method `WorldGraphProvider` plus the fact,
// schema and query shapes it speaks.
//
// STATUS: PROPOSED. This contract is on the ARCHITECTURE.md §VII roster under
// O-8, pending maintainer approval of the RFC
// docs/content/building/explanation/world-graph-governance.md. The freeze
// below takes effect only on that approval.
//
// The contract is FROZEN at fourteen methods. Adding, removing or renaming
// one requires the drift gate in __tests__/world-graph-method-count.test.ts
// (test 'world-graph method count is 14') to be updated in the same commit.
// That test is what enforces the count.
//
// Zero dependencies: only `import type` from sibling contract files, and no
// `node:*` import (pinned by __tests__/world-graph-types.test.ts, test
// 'no node:* import in world-graph.ts').
//
// `getFact` is the by-id read: the attribute or edge with that id in that
// world in any state (closed and retired included), null when absent or in
// another world. WorldService uses it so closing or promoting one fact does
// not read the whole world through `export`.
//
// A provider is reached only through WorldService / WorldSchemaService;
// those, not the backend, enforce proposals, access, authority and conflicts.

import type { Logger } from './logger';
import type { SecretsResolver } from './secrets';

/** `world:<slug>` for a shared world, `personality:<pid>` for a private one. */
export type WorldId = `world:${string}` | `personality:${string}`;
export type FactAuthor = 'user' | 'import' | 'connector' | 'agent';
/** user and import outrank everything else. */
export const AUTHORITATIVE_AUTHORS: readonly FactAuthor[] = ['user', 'import'];

export interface Entity {
  id: string;
  world: WorldId;
  type: string;
  name: string;
  aliases: string[];
  recordedAt: string;
  retiredAt: string | null;
  sourceRef: string;
  author: FactAuthor;
  mergedInto: string | null;
}

export interface AttributeFact {
  id: string;
  world: WorldId;
  entityId: string;
  key: string;
  value: unknown;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
  retiredAt: string | null;
  sourceRef: string;
  author: FactAuthor;
  confidence: number;
}

export interface Edge {
  id: string;
  world: WorldId;
  type: string;
  fromId: string;
  toId: string;
  attrs: Record<string, unknown>;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
  retiredAt: string | null;
  sourceRef: string;
  author: FactAuthor;
  confidence: number;
}

/** asOf = world clock (default now); knownAt = Ethos clock (default now). */
export interface TimeSlice {
  asOf?: string;
  knownAt?: string;
}

export type GraphQuery =
  | { kind: 'entities'; text?: string; types?: string[]; limit: number }
  | {
      kind: 'edges';
      fromId?: string;
      toId?: string;
      types?: string[];
      includeClosed?: boolean;
      limit: number;
    }
  | {
      kind: 'paths';
      fromId: string;
      via: string[];
      toType?: string;
      maxHops: number;
      limit: number;
    };

export interface Facts {
  entities: Entity[];
  attributes: AttributeFact[];
  edges: Edge[];
  paths?: string[][];
  truncated: boolean;
}

export interface Subgraph extends Facts {
  centre: string;
  hops: number;
}

export type FactInput =
  | {
      kind: 'entity';
      type: string;
      name: string;
      aliases?: string[];
      sourceRef: string;
      author: FactAuthor;
    }
  | {
      kind: 'attribute';
      entityId: string;
      key: string;
      value: unknown;
      validFrom?: string;
      sourceRef: string;
      author: FactAuthor;
      confidence: number;
    }
  | {
      kind: 'edge';
      type: string;
      fromId: string;
      toId: string;
      attrs?: Record<string, unknown>;
      validFrom?: string;
      sourceRef: string;
      author: FactAuthor;
      confidence: number;
    };

export type WriteResult =
  | { ok: true; ids: string[] }
  | { ok: false; code: 'not_found' | 'schema' | 'closed' | 'invalid'; reason: string };

export interface AttrSpec {
  type: 'string' | 'int' | 'number' | 'bool' | 'date' | 'url';
  min?: number;
  max?: number;
  enum?: string[];
}

export interface WorldSchema {
  version: number;
  entities: Record<string, { attrs: Record<string, AttrSpec> }>;
  edges: Record<
    string,
    { from: string[]; to: string[]; attrs: Record<string, AttrSpec>; unique?: 'from' | 'to' }
  >;
}

export interface GraphBundle {
  schema: WorldSchema | null;
  entities: Entity[];
  attributes: AttributeFact[];
  edges: Edge[];
}

export interface ImportReport {
  entities: number;
  attributes: number;
  edges: number;
  skipped: Array<{ line: number; reason: string }>;
}

export interface WorldProviderCapabilities {
  bitemporal: boolean;
  fullText: boolean;
  vector: boolean;
  maxHops: number;
}

export interface ChangeRow {
  at: string;
  kind: 'opened' | 'closed' | 'retired' | 'entity';
  factId: string;
  sourceRef: string;
  author: FactAuthor;
}

export interface WorldGraphProvider {
  query(world: WorldId, q: GraphQuery, slice?: TimeSlice): Promise<Facts>;
  neighbours(world: WorldId, entityId: string, hops: number, slice?: TimeSlice): Promise<Subgraph>;
  history(
    world: WorldId,
    entityId: string,
  ): Promise<{ attributes: AttributeFact[]; edges: Edge[] }>;
  changes(world: WorldId, since: string, limit: number): Promise<ChangeRow[]>;
  assert(world: WorldId, facts: FactInput[]): Promise<WriteResult>;
  close(
    world: WorldId,
    factId: string,
    validTo: string,
    sourceRef: string,
    author: FactAuthor,
  ): Promise<WriteResult>;
  retire(
    world: WorldId,
    factId: string,
    sourceRef: string,
    author: FactAuthor,
  ): Promise<WriteResult>;
  /** One attribute or edge by id, in any state (closed, retired); null if absent or in another world. */
  getFact(world: WorldId, factId: string): Promise<AttributeFact | Edge | null>;
  getSchema(world: WorldId): Promise<WorldSchema | null>;
  applySchema(world: WorldId, schema: WorldSchema): Promise<WriteResult>;
  import(world: WorldId, data: GraphBundle): Promise<ImportReport>;
  export(world: WorldId): Promise<GraphBundle>;
  purge(world: WorldId, scope: { entityId?: string }, reason: string): Promise<{ removed: number }>;
  capabilities(): WorldProviderCapabilities;
}

export interface WorldGraphProviderFactoryContext {
  config: Record<string, unknown>;
  dataDir: string;
  secrets: SecretsResolver;
  logger: Logger;
}

export type WorldGraphProviderFactory = (
  ctx: WorldGraphProviderFactoryContext,
) => WorldGraphProvider | Promise<WorldGraphProvider>;

export interface WorldGraphProviderRegistry {
  register(name: string, f: WorldGraphProviderFactory): void;
  unregister(name: string): void;
  get(name: string): WorldGraphProviderFactory | undefined;
  list(): string[];
}
