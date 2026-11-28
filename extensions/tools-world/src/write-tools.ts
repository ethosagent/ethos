// world_assert, world_close, world_propose, world_schema_change. Each routes
// through WorldToolPort, so the rules live in WorldService, not here:
//   - R1/R2: shared-world writes and writes that collide with a user or import
//     fact become proposals (write-routing.test.ts).
//   - R9: no `world` with 2+ visible worlds is refused WORLD_REQUIRED, pinned by
//     world-tools.test.ts 'R9 write without world refused when 2+ mounted'.
// The author is forced to `agent` by WorldService.agentCtx whatever this tool
// sends (write-routing.test.ts 'an agent cannot claim the user author').

import type { FactInput } from '@ethosagent/types';
import { schemaChangeZ, type WorldToolPort, type WriteOutcome } from '@ethosagent/world-service';
import { z } from 'zod';
import { callerOf, fail, NO_PERSONALITY, serviceError, type ToolDef, WORLD_PROP } from './common';

const MAX_FACTS = 50;
/** Default confidence for an agent's own claim: above the 0.7 direct-write floor. */
const DEFAULT_CONFIDENCE = 0.8;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-11-20');
const common = { source_ref: z.string().min(1).optional() };

const factZ = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('entity'),
    type: z.string().min(1),
    name: z.string().min(1),
    aliases: z.array(z.string()).optional(),
    ...common,
  }),
  z.object({
    kind: z.literal('attribute'),
    entity_id: z.string().min(1),
    key: z.string().min(1),
    value: z.unknown(),
    valid_from: date.optional(),
    confidence: z.number().min(0).max(1).optional(),
    ...common,
  }),
  z.object({
    kind: z.literal('edge'),
    type: z.string().min(1),
    from_id: z.string().min(1),
    to_id: z.string().min(1),
    attrs: z.record(z.string(), z.unknown()).optional(),
    valid_from: date.optional(),
    confidence: z.number().min(0).max(1).optional(),
    ...common,
  }),
]);

const factsZ = z.array(factZ).min(1).max(MAX_FACTS);

const closeZ = z.object({
  fact_id: z.string().min(1),
  valid_to: date,
  source_ref: z.string().min(1).optional(),
});

const FACTS_PROP = {
  type: 'array',
  description: `1 to ${MAX_FACTS} facts. An entity needs type and name. An attribute needs entity_id (the #id from a result), key and value. An edge needs type, from_id and to_id. Create entities in one call and refer to their #id in the next.`,
  items: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['entity', 'attribute', 'edge'] },
      type: { type: 'string' },
      name: { type: 'string' },
      aliases: { type: 'array', items: { type: 'string' } },
      entity_id: { type: 'string' },
      key: { type: 'string' },
      value: {},
      from_id: { type: 'string' },
      to_id: { type: 'string' },
      attrs: { type: 'object' },
      valid_from: { type: 'string', description: 'YYYY-MM-DD the fact became true.' },
      confidence: {
        type: 'number',
        description: 'Under 0.7 on your private world becomes a proposal. Default 0.8.',
      },
      source_ref: {
        type: 'string',
        description: 'Where you learned it. Default: this conversation.',
      },
    },
    required: ['kind'],
  },
} as const;

const WHY_PROP = {
  type: 'string',
  description: 'One line on why, shown to the owner on a proposal.',
} as const;

/** `applied 2 · proposed 1 (conflicts with your fact: …) · refused 0`, then one line per refusal. */
export function summarise(out: WriteOutcome): string {
  const conflict = out.conflicts?.length
    ? ` (conflicts with your fact: ${out.conflicts.join('; ')})`
    : '';
  const lines = [
    `applied ${out.applied.length} · proposed ${out.proposed.length}${conflict} · refused ${out.refused.length}`,
  ];
  for (const r of out.refused) lines.push(`refused #${r.index}: ${r.reason}`);
  if (out.proposed.length > 0) lines.push("Proposed facts wait for the owner's decision.");
  return lines.join('\n');
}

const outcome = (out: WriteOutcome) =>
  out.applied.length + out.proposed.length === 0 && out.refused.length > 0
    ? fail('input_invalid', summarise(out))
    : ({ ok: true, value: summarise(out) } as const);

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function createWriteTools(port: WorldToolPort): ToolDef[] {
  const toInputs = (facts: z.infer<typeof factsZ>, defaultSource: string): FactInput[] =>
    facts.map((f): FactInput => {
      const sourceRef = f.source_ref ?? defaultSource;
      if (f.kind === 'entity') {
        return {
          kind: 'entity',
          type: f.type,
          name: f.name,
          ...(f.aliases ? { aliases: f.aliases } : {}),
          sourceRef,
          author: 'agent',
        };
      }
      if (f.kind === 'attribute') {
        return {
          kind: 'attribute',
          entityId: f.entity_id,
          key: f.key,
          value: f.value,
          ...(f.valid_from ? { validFrom: f.valid_from } : {}),
          sourceRef,
          author: 'agent',
          confidence: f.confidence ?? DEFAULT_CONFIDENCE,
        };
      }
      return {
        kind: 'edge',
        type: f.type,
        fromId: f.from_id,
        toId: f.to_id,
        ...(f.attrs ? { attrs: f.attrs } : {}),
        ...(f.valid_from ? { validFrom: f.valid_from } : {}),
        sourceRef,
        author: 'agent',
        confidence: f.confidence ?? DEFAULT_CONFIDENCE,
      };
    });

  const writer = (
    name: 'world_assert' | 'world_propose',
    description: string,
    send: WorldToolPort['writeFacts'],
  ): ToolDef => ({
    name,
    description,
    toolset: 'world',
    maxResultChars: 4000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: { world: WORLD_PROP, facts: FACTS_PROP, why: WHY_PROP },
      required: ['facts'],
    },
    async execute(args, ctx) {
      const caller = callerOf(ctx);
      if (!caller) return NO_PERSONALITY;
      const parsed = factsZ.safeParse(args.facts);
      if (!parsed.success) {
        return fail('input_invalid', `facts: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      }
      try {
        const out = await send(
          caller,
          str(args.world),
          toInputs(parsed.data, `chat:${ctx.sessionId}`),
          typeof args.why === 'string' ? args.why : '',
        );
        return outcome(out);
      } catch (e) {
        return serviceError(e);
      }
    },
  });

  const assert = writer(
    'world_assert',
    'Record facts you learned (people, services, relationships, attributes). On your private world they apply now; on a shared world, or when they conflict with something the user told you, they become proposals the owner reviews. Name a "world" when more than one is visible.',
    (c, w, f, why) => port.writeFacts(c, w, f, why),
  );

  const propose = writer(
    'world_propose',
    'Propose facts for the owner to accept or reject, on any world, including your private one. Use for batches you are unsure about.',
    (c, w, f, why) => port.proposeFacts(c, w, f, why),
  );

  const close: ToolDef = {
    name: 'world_close',
    description:
      'Mark a fact as no longer true from a date (it is closed, never deleted, so history keeps it). "fact_id" is the #id on a result line. Closing a fact the user told you, or any fact on a shared world, becomes a proposal.',
    toolset: 'world',
    maxResultChars: 4000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        world: WORLD_PROP,
        fact_id: { type: 'string', description: 'Fact id (#id from a result).' },
        valid_to: { type: 'string', description: 'YYYY-MM-DD it stopped being true.' },
        source_ref: {
          type: 'string',
          description: 'Where you learned it. Default: this conversation.',
        },
      },
      required: ['fact_id', 'valid_to'],
    },
    async execute(args, ctx) {
      const caller = callerOf(ctx);
      if (!caller) return NO_PERSONALITY;
      const parsed = closeZ.safeParse(args);
      if (!parsed.success) {
        return fail(
          'input_invalid',
          `${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}`,
        );
      }
      try {
        const out = await port.closeFact(
          caller,
          str(args.world),
          parsed.data.fact_id,
          parsed.data.valid_to,
          parsed.data.source_ref ?? `chat:${ctx.sessionId}`,
        );
        return outcome(out);
      } catch (e) {
        return serviceError(e);
      }
    },
  };

  const schemaChange: ToolDef = {
    name: 'world_schema_change',
    description:
      "Ask to change a world's schema: add an entity type, edge type, attribute or allowed pair; rename, merge or remove types. Additive changes on your private world apply now; everything else becomes a proposal. Removing a type that facts use is refused.",
    toolset: 'world',
    maxResultChars: 4000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        world: WORLD_PROP,
        change: {
          type: 'object',
          description:
            'One of: {op:"add_entity_type",type,attrs?}, {op:"add_edge_type",type,from[],to[],attrs?,unique?}, {op:"add_attribute",on:{entity}|{edge},key,spec}, {op:"add_allowed_pair",edge,from?,to?}, {op:"rename_type",kind,from,to}, {op:"rename_attribute",on,from,to}, {op:"merge_types",kind:"entity",from,into}, {op:"remove_type",kind,type}.',
        },
        reason: WHY_PROP,
      },
      required: ['change'],
    },
    async execute(args, ctx) {
      const caller = callerOf(ctx);
      if (!caller) return NO_PERSONALITY;
      const parsed = schemaChangeZ.safeParse(args.change);
      if (!parsed.success) {
        return fail('input_invalid', `change: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      }
      try {
        const r = await port.requestSchemaChange(
          caller,
          str(args.world),
          parsed.data,
          typeof args.reason === 'string' ? args.reason : '',
        );
        if ('applied' in r) return { ok: true, value: `schema updated: now version ${r.applied}` };
        if ('proposalId' in r) {
          return { ok: true, value: "schema change proposed; it waits for the owner's decision." };
        }
        return fail('input_invalid', `refused: ${r.refused}`);
      } catch (e) {
        return serviceError(e);
      }
    },
  };

  return [assert, close, propose, schemaChange];
}
