// world_query, world_neighbours, world_history: reads through the narrow
// WorldReadPort (visible/query/neighbours/history only). Service-mediated like memory_read (`capabilities: {}`), so
// the tool holds no provider and no Storage. The port resolves which worlds
// the turn may see (mounts, grants, audience), so an owner_only world is
// already absent in a shared turn (R6: world-tools.test.ts 'shared turn drops
// owner_only worlds from results'); every line carries its world tag (R8:
// 'R8 unscoped queries are tagged and span only mounted worlds').

import type { GraphQuery, TimeSlice } from '@ethosagent/types';
import type { WorldReadPort } from '@ethosagent/world-service';
import {
  AS_OF,
  callerOf,
  fail,
  NO_PERSONALITY,
  readResult,
  resolveWorld,
  serviceError,
  type ToolDef,
  WORLD_PROP,
} from './common';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_HOPS = 3;

const AS_OF_PROP = {
  type: 'string',
  description: 'ISO date (YYYY-MM-DD) to read the world as it was then. Default now.',
} as const;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const strs = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 0 ? v : undefined;
const int = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.trunc(v)))
    : fallback;

function sliceOf(asOf: unknown): TimeSlice | undefined | 'bad' {
  const v = str(asOf);
  if (v === undefined) return undefined;
  return AS_OF.test(v) ? { asOf: v } : 'bad';
}

export function createReadTools(port: WorldReadPort): ToolDef[] {
  const query: ToolDef = {
    name: 'world_query',
    description:
      'Search the knowledge graph (worlds) for people, services, relationships and other entities. Results are tagged with their world (acme:Ravi). Use "text" and "types" to find entities, or "paths" to walk relationships from an entity id. Without "world" it spans every visible world.',
    toolset: 'world',
    maxResultChars: 8000,
    capabilities: {},
    outputIsUntrusted: true,
    schema: {
      type: 'object',
      properties: {
        world: WORLD_PROP,
        text: { type: 'string', description: 'Name or text to search for.' },
        types: { type: 'array', items: { type: 'string' }, description: 'Entity types to keep.' },
        as_of: AS_OF_PROP,
        limit: {
          type: 'number',
          description: `Max entities (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
        paths: {
          type: 'object',
          description: 'Walk relationships instead of searching names.',
          properties: {
            from: { type: 'string', description: 'Starting entity id (#id from a result).' },
            via: { type: 'array', items: { type: 'string' }, description: 'Edge types to follow.' },
            to_type: { type: 'string', description: 'Stop at entities of this type.' },
            max_hops: { type: 'number', description: `Max hops (default 2, max ${MAX_HOPS}).` },
          },
          required: ['from', 'via'],
        },
      },
    },
    async execute(args, ctx) {
      const caller = callerOf(ctx);
      if (!caller) return NO_PERSONALITY;
      const slice = sliceOf(args.as_of);
      if (slice === 'bad')
        return fail('input_invalid', 'as_of must be an ISO date like 2026-11-20.');
      const limit = int(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
      let q: GraphQuery;
      const p = args.paths;
      if (typeof p === 'object' && p !== null) {
        const from = str('from' in p ? p.from : undefined);
        const via = strs('via' in p ? p.via : undefined);
        if (!from || !via)
          return fail('input_invalid', 'paths needs "from" (an entity id) and "via" (edge types).');
        const toType = str('to_type' in p ? p.to_type : undefined);
        q = {
          kind: 'paths',
          fromId: from,
          via,
          ...(toType ? { toType } : {}),
          maxHops: int('max_hops' in p ? p.max_hops : undefined, 2, 1, MAX_HOPS),
          limit,
        };
      } else {
        const text = str(args.text);
        const types = strs(args.types);
        q = { kind: 'entities', ...(text ? { text } : {}), ...(types ? { types } : {}), limit };
      }
      try {
        const facts = await port.query(caller, str(args.world) ?? null, q, slice);
        return await readResult(port, caller, facts);
      } catch (e) {
        return serviceError(e);
      }
    },
  };

  const neighbours: ToolDef = {
    name: 'world_neighbours',
    description:
      'Show an entity and what it connects to, up to 3 hops. "entity" is the #id shown by world_query. Results are tagged with their world.',
    toolset: 'world',
    maxResultChars: 8000,
    capabilities: {},
    outputIsUntrusted: true,
    schema: {
      type: 'object',
      properties: {
        world: WORLD_PROP,
        entity: { type: 'string', description: 'Entity id (#id from a result).' },
        hops: { type: 'number', description: `Hops to walk (default 1, max ${MAX_HOPS}).` },
        as_of: AS_OF_PROP,
      },
      required: ['entity'],
    },
    async execute(args, ctx) {
      const caller = callerOf(ctx);
      if (!caller) return NO_PERSONALITY;
      const entity = str(args.entity);
      if (!entity) return fail('input_invalid', '"entity" is required.');
      const slice = sliceOf(args.as_of);
      if (slice === 'bad')
        return fail('input_invalid', 'as_of must be an ISO date like 2026-11-20.');
      try {
        const facts = await port.neighbours(
          caller,
          str(args.world) ?? null,
          entity,
          int(args.hops, 1, 1, MAX_HOPS),
          slice,
        );
        return await readResult(port, caller, facts);
      } catch (e) {
        return serviceError(e);
      }
    },
  };

  const history: ToolDef = {
    name: 'world_history',
    description:
      'Show every value an entity has had over time, closed ones included (who owned it before). "entity" is the #id shown by world_query. Needs "world" when more than one world is visible.',
    toolset: 'world',
    maxResultChars: 8000,
    capabilities: {},
    outputIsUntrusted: true,
    schema: {
      type: 'object',
      properties: {
        world: WORLD_PROP,
        entity: { type: 'string', description: 'Entity id (#id from a result).' },
      },
      required: ['entity'],
    },
    async execute(args, ctx) {
      const caller = callerOf(ctx);
      if (!caller) return NO_PERSONALITY;
      const entity = str(args.entity);
      if (!entity) return fail('input_invalid', '"entity" is required.');
      const w = await resolveWorld(port, caller, str(args.world));
      if (!w.ok) return fail('input_invalid', w.error);
      try {
        const facts = await port.history(caller, w.label, entity);
        return await readResult(port, caller, facts);
      } catch (e) {
        return serviceError(e);
      }
    },
  };

  return [query, neighbours, history];
}
