// Duplicate merge for a first build (plan world-model 5.2).
//
// Two extracted entities of the same type are ONE entity when they share a
// normalised name, an alias or an email (an email-shaped name counts, and its
// local part matches a plain name: `priya@acme.example` is `Priya`). A near
// match that shares nothing (edit distance <= 1 on names of 4+ letters, <= 2 on
// 9+) is NOT merged: it becomes a `duplicate` pair and the less-mentioned side
// is marked unsure. Emails are merge keys only; they are never kept as an
// alias or fact (vetFact refuses personal data on an agent write:
// fact-vetting.test.ts). Pinned by build.test.ts 'Priya and priya@acme.example
// merge; Pria is flagged unsure'.

import type { ExtractedEntity } from './extract';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface MergedEntity {
  type: string;
  name: string;
  aliases: string[];
  mentions: number;
  /** Highest confidence any mention carried. */
  confidence: number;
  sourceRef: string;
  order: number;
  /** Every normalised name this entity answers to (for resolving attribute and link endpoints). */
  keys: Set<string>;
}

export interface DuplicatePair {
  type: string;
  a: string;
  b: string;
  /** The side marked unsure. */
  unsure: string;
}

function keysOf(e: Pick<ExtractedEntity, 'name' | 'aliases' | 'email'>): Set<string> {
  const keys = new Set<string>();
  const add = (s: string): void => {
    if (EMAIL.test(s)) {
      const lower = s.toLowerCase();
      keys.add(`e:${lower}`);
      const local = normName(lower.slice(0, lower.indexOf('@')));
      if (local) keys.add(`n:${local}`);
    } else {
      const n = normName(s);
      if (n) keys.add(`n:${n}`);
    }
  };
  add(e.name);
  for (const a of e.aliases) add(a);
  if (e.email) add(e.email);
  return keys;
}

const isReal = (s: string): boolean => !EMAIL.test(s) && normName(s) !== '';

export function mergeEntities(raw: readonly ExtractedEntity[]): {
  entities: MergedEntity[];
  duplicates: DuplicatePair[];
} {
  const groups: MergedEntity[] = [];
  let order = 0;

  const absorb = (g: MergedEntity, e: ExtractedEntity): void => {
    const names = [e.name, ...e.aliases].filter(isReal);
    if (g.name === '' && names[0]) g.name = names[0];
    for (const n of names) {
      if (
        n !== g.name &&
        !g.aliases.some((a) => normName(a) === normName(n)) &&
        normName(n) !== normName(g.name)
      ) {
        g.aliases.push(n);
      }
    }
    for (const k of keysOf(e)) g.keys.add(k);
    g.mentions++;
    g.confidence = Math.max(g.confidence, e.confidence);
  };

  for (const e of raw) {
    const mine = keysOf(e);
    const hits = groups.filter((g) => g.type === e.type && [...mine].some((k) => g.keys.has(k)));
    let target = hits[0];
    if (!target) {
      target = {
        type: e.type,
        name: '',
        aliases: [],
        mentions: 0,
        confidence: 0,
        sourceRef: e.sourceRef,
        order: order++,
        keys: new Set(),
      };
      groups.push(target);
    }
    // An entity that bridges two groups joins them.
    for (const other of hits.slice(1)) {
      absorbGroup(target, other);
      groups.splice(groups.indexOf(other), 1);
    }
    absorb(target, e);
  }

  const entities = groups.filter((g) => g.name !== '');

  const duplicates: DuplicatePair[] = [];
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];
      if (!a || !b || a.type !== b.type) continue;
      if (!near(normName(a.name), normName(b.name))) continue;
      const weaker = a.mentions < b.mentions ? a : b.mentions < a.mentions ? b : b;
      duplicates.push({ type: a.type, a: a.name, b: b.name, unsure: weaker.name });
    }
  }
  return { entities, duplicates };
}

function absorbGroup(into: MergedEntity, from: MergedEntity): void {
  if (into.name === '') into.name = from.name;
  for (const a of [from.name, ...from.aliases]) {
    if (
      a &&
      normName(a) !== normName(into.name) &&
      !into.aliases.some((x) => normName(x) === normName(a))
    ) {
      into.aliases.push(a);
    }
  }
  for (const k of from.keys) into.keys.add(k);
  into.mentions += from.mentions;
  into.confidence = Math.max(into.confidence, from.confidence);
}

function near(a: string, b: string): boolean {
  if (a === '' || b === '' || a === b) return false;
  const shortest = Math.min(a.length, b.length);
  const limit = shortest >= 9 ? 2 : shortest >= 4 ? 1 : 0;
  return limit > 0 && editDistance(a, b) <= limit;
}

export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}
