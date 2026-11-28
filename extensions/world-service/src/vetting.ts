// vetFact: the content checks a fact passes before it is written or proposed
// (plan world-model Task 2.4, step 3; failure mode R11).
//
// Pure: no I/O. WorldService.writeFacts calls it for every fact on every path
// (direct write, proposal, import), so a fact that fails here never reaches a
// backend or the proposals table. Pinned by `__tests__/fact-vetting.test.ts`:
// 'R11 a fact carrying a secret is refused', 'R11 a secret is refused at
// proposal creation on a shared world too', 'sensitive attribute refused for
// the agent, allowed for the owner'.
//
// What it checks:
//   - secrets (`detectSecrets`, packages/safety/redact) in every string of the
//     fact: names, aliases, attribute values, edge attribute values, source
//     refs. Applies to the owner too.
//   - personal data (`redactPii` changes the string) for the agent only; an
//     owner may record an email address.
//   - `sensitive: true` attributes (schema.yaml): the agent may never write
//     one. A bare attribute fact carries only an entity id, so its type is
//     unknown here; the check is conservative and refuses the key when ANY
//     entity type marks it sensitive.
//   - schema fit, only when the world has a schema (version > 0): known entity
//     type, known edge type, known edge attribute keys. The backend remains the
//     precise check for an attribute's entity type (FakeWorldGraphProvider and
//     SQLiteWorldGraphProvider both validate on `assert`).
//   - confidence within 0..1 and a non-blank source ref.
//
// Refusal reasons name the kind of hit, never the matched text, so a secret is
// not echoed into a tool result or a log.

import { detectSecrets, redactPii } from '@ethosagent/safety-redact';
import type { FactInput, WorldSchema } from '@ethosagent/types';

export interface VetContext {
  schema: WorldSchema;
  /** `entity:<Type>.<attr>` / `edge:<Type>.<attr>` keys flagged `sensitive: true`. */
  sensitive: readonly string[];
  actor: 'agent' | 'owner';
}

export type VetResult = { ok: true } | { ok: false; reason: string };

const refuse = (reason: string): VetResult => ({ ok: false, reason });

/** Every string inside a JSON-ish value (object keys excluded). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

function textsOf(f: FactInput): string[] {
  switch (f.kind) {
    case 'entity':
      return [f.name, ...(f.aliases ?? []), f.sourceRef];
    case 'attribute':
      return [f.key, ...strings(f.value), f.sourceRef];
    case 'edge':
      return [...strings(f.attrs ?? {}), f.sourceRef];
  }
}

export function vetFact(f: FactInput, ctx: VetContext): VetResult {
  if (f.sourceRef.trim() === '') return refuse('sourceRef is required');
  if (f.kind !== 'entity' && !(f.confidence >= 0 && f.confidence <= 1)) {
    return refuse('confidence must be between 0 and 1');
  }

  for (const t of textsOf(f)) {
    const hit = detectSecrets(t)[0];
    if (hit) return refuse(`looks like a secret (${hit.label}); not stored`);
    if (ctx.actor === 'agent' && redactPii(t) !== t) {
      return refuse('contains personal data (email, phone, card or id number); not stored');
    }
  }

  if (ctx.actor === 'agent') {
    if (
      f.kind === 'attribute' &&
      ctx.sensitive.some((k) => k.startsWith('entity:') && k.endsWith(`.${f.key}`))
    ) {
      return refuse(`sensitive attribute '${f.key}' is owner-only`);
    }
    if (f.kind === 'edge') {
      for (const key of Object.keys(f.attrs ?? {})) {
        if (ctx.sensitive.includes(`edge:${f.type}.${key}`)) {
          return refuse(`sensitive attribute '${key}' is owner-only`);
        }
      }
    }
  }

  if (ctx.schema.version > 0) {
    if (f.kind === 'entity' && !Object.hasOwn(ctx.schema.entities, f.type)) {
      return refuse(`entity type '${f.type}' is not in the schema`);
    }
    if (f.kind === 'edge') {
      const spec = Object.hasOwn(ctx.schema.edges, f.type) ? ctx.schema.edges[f.type] : undefined;
      if (!spec) return refuse(`edge type '${f.type}' is not in the schema`);
      for (const key of Object.keys(f.attrs ?? {})) {
        if (!Object.hasOwn(spec.attrs, key))
          return refuse(`edge '${f.type}' has no attribute '${key}'`);
      }
    }
    if (
      f.kind === 'attribute' &&
      !Object.values(ctx.schema.entities).some((e) => Object.hasOwn(e.attrs, f.key))
    ) {
      return refuse(`attribute '${f.key}' is not in the schema`);
    }
  }
  return { ok: true };
}
