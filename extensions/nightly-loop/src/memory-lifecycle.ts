// Fact lifecycle ops (memory-lifecycle L4, §3c) — supersede + retract.
//
// The inverse-of-restore pair: an ACTIVE `### <slug>` section leaves the live
// memory file for `memory-archive.md` with a dated, human-readable note, and its
// sidecar entry is stamped with a lifecycle state. Both ops mirror
// `restoreArchivedSlug` (memory-restore) — provider-driven, history-recorded via
// the injected write handle — and reuse the M3 archive block format unchanged, so
// `parseArchiveBlocks` / restore keep working with zero format change.
//
// What separates a RETRACT from a plain delete: it also tombstones every fact in
// the section (via the injected `addTombstone`, backed by L2's TombstoneStore),
// so proactive capture never re-proposes the fact — even after a nightly reword,
// because the tombstone key is the content-normalized `hashFact`.
//
// Single-writer coexistence: the nightly pass is the sidecar's primary writer;
// these explicit lifecycle ops are the sanctioned second writer (§3c). They use
// read-modify-`writeMeta` (atomic) and touch ONLY the target slug's entry plus
// the retracted-hash list, so they never clobber another slug's decay
// bookkeeping. `planConsolidation` carries lifecycle entries forward, so a
// concurrent nightly rebuild does not drop a recorded state. The durable
// capture-skip guarantee rides on the append-only TombstoneStore, not the
// sidecar, so even a lost sidecar-state race never resurrects a retracted fact.

import type { MemoryContext, MemoryProvider, MemoryUpdate } from '@ethosagent/types';
import { type ScoredSection, slugify } from './memory-consolidation';
import { formatArchiveBlock, type MemoryMeta, type MetaEntry } from './memory-decay';

const ACTIVE_KEYS = ['MEMORY.md', 'USER.md'] as const;
type ActiveKey = (typeof ACTIVE_KEYS)[number];
const ARCHIVE_KEY = 'memory-archive.md';

/** Sidecar read/modify/write, injected so this module stays Storage-free. */
export interface SupersedeDeps {
  readMeta(): Promise<MemoryMeta>;
  writeMeta(meta: MemoryMeta): Promise<void>;
  /** Injected clock (epoch-ms); defaults to `Date.now()`. */
  now?: number;
}

export interface RetractDeps extends SupersedeDeps {
  /** Content-normalized fact hash — MUST be `@ethosagent/memory-capture`'s `hashFact`. */
  hashFact(text: string): string;
  /** Append a tombstone (L2 TombstoneStore) so capture never re-proposes the fact. */
  addTombstone(factHash: string, reason?: string): Promise<void>;
}

export type LifecycleResult =
  | { ok: true; fromKey: ActiveKey; tombstoned?: number }
  | { ok: false; error: string; availableSlugs: string[] };

/**
 * Mark `slug` superseded by `bySlug`: move the section to the archive with a
 * `> Superseded by [[#<bySlug>]] on <date>` note and record `supersededBy` in the
 * sidecar. Existing verbs only (`replace` + `add`), history-recorded.
 */
export async function supersedeSlug(
  memory: Pick<MemoryProvider, 'read' | 'sync'>,
  ctx: MemoryContext,
  slug: string,
  bySlug: string,
  deps: SupersedeDeps,
): Promise<LifecycleResult> {
  const { located, slugs } = await locate(memory, ctx, slug);
  if (!located) {
    return { ok: false, error: `No active section with slug "${slug}".`, availableSlugs: slugs };
  }
  const now = deps.now ?? Date.now();
  const meta = await deps.readMeta();
  const prior = meta.keys[located.key]?.[slug];
  const date = new Date(now).toISOString().slice(0, 10);

  await moveToArchive(memory, ctx, {
    key: located.key,
    slug,
    remaining: located.remaining,
    note: `> Superseded by [[#${bySlug}]] on ${date}.`,
    body: located.body,
    score: prior?.importance ?? 0.5,
    now,
  });

  setEntry(meta, located.key, slug, {
    importance: prior?.importance ?? 0.5,
    lastSeen: prior?.lastSeen ?? now,
    state: 'superseded',
    supersededBy: bySlug,
  });
  await deps.writeMeta(meta);
  return { ok: true, fromKey: located.key };
}

/**
 * Retract `slug`: move the section to the archive with a `> Retracted` note,
 * tombstone every fact in it so capture can never re-propose it, and record the
 * retracted state + hashes in the sidecar. Tombstones are written BEFORE the
 * archive move so a crash mid-op still leaves the fact un-recapturable.
 */
export async function retractSlug(
  memory: Pick<MemoryProvider, 'read' | 'sync'>,
  ctx: MemoryContext,
  slug: string,
  deps: RetractDeps,
  reason?: string,
): Promise<LifecycleResult> {
  const { located, slugs } = await locate(memory, ctx, slug);
  if (!located) {
    return { ok: false, error: `No active section with slug "${slug}".`, availableSlugs: slugs };
  }
  const now = deps.now ?? Date.now();
  const meta = await deps.readMeta();
  const prior = meta.keys[located.key]?.[slug];
  const date = new Date(now).toISOString().slice(0, 10);

  // Tombstone the whole-section fact AND each bullet line, so capture's per-fact
  // dedup matches whichever granularity it later extracts (§3c).
  const hashes = unique(factCandidates(located.body).map((f) => deps.hashFact(f)));
  for (const h of hashes) await deps.addTombstone(h, reason ?? 'retracted');

  await moveToArchive(memory, ctx, {
    key: located.key,
    slug,
    remaining: located.remaining,
    note: `> Retracted${reason ? `: ${reason}` : ''} on ${date}.`,
    body: located.body,
    score: prior?.importance ?? 0.5,
    now,
  });

  setEntry(meta, located.key, slug, {
    importance: prior?.importance ?? 0.5,
    lastSeen: prior?.lastSeen ?? now,
    state: 'retracted',
  });
  meta.retractedHashes = unique([...(meta.retractedHashes ?? []), ...hashes]);
  await deps.writeMeta(meta);
  return { ok: true, fromKey: located.key, tombstoned: hashes.length };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Located {
  key: ActiveKey;
  body: string;
  remaining: string;
}

/** Find `slug` across the live files; also collect all active slugs for errors. */
async function locate(
  memory: Pick<MemoryProvider, 'read'>,
  ctx: MemoryContext,
  slug: string,
): Promise<{ located: Located | null; slugs: string[] }> {
  const slugs: string[] = [];
  let located: Located | null = null;
  for (const key of ACTIVE_KEYS) {
    const text = (await memory.read(key, ctx))?.content ?? '';
    for (const s of listSlugs(text)) slugs.push(s);
    if (!located) {
      const spliced = splice(text, slug);
      if (spliced) located = { key, body: spliced.body, remaining: spliced.remaining };
    }
  }
  return { located, slugs: unique(slugs) };
}

async function moveToArchive(
  memory: Pick<MemoryProvider, 'sync'>,
  ctx: MemoryContext,
  args: {
    key: ActiveKey;
    slug: string;
    remaining: string;
    note: string;
    body: string;
    score: number;
    now: number;
  },
): Promise<void> {
  const notedSection: ScoredSection = {
    slug: args.slug,
    content: `${args.note}\n\n${args.body}`,
    score: args.score,
  };
  const updates: MemoryUpdate[] = [
    { action: 'replace', key: args.key, content: args.remaining },
    {
      action: 'add',
      key: ARCHIVE_KEY,
      content: formatArchiveBlock(notedSection, args.key, args.now),
    },
  ];
  await memory.sync(updates, ctx);
}

function setEntry(meta: MemoryMeta, key: string, slug: string, entry: MetaEntry): void {
  const map = meta.keys[key] ?? {};
  map[slug] = entry;
  meta.keys[key] = map;
}

/** Split the `### <slug>` section out of `text`, returning its body + the rest. */
function splice(text: string, slug: string): { body: string; remaining: string } | null {
  const heads = headings(text);
  const idx = heads.findIndex((h) => h.slug === slug);
  if (idx < 0) return null;
  const cur = heads[idx];
  if (!cur) return null;
  const next = heads[idx + 1];
  const end = next ? next.headStart : text.length;
  const body = text.slice(cur.bodyStart, end).trim();
  const remaining = `${text.slice(0, cur.headStart)}${text.slice(end)}`
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { body, remaining };
}

function listSlugs(text: string): string[] {
  return headings(text).map((h) => h.slug);
}

interface Heading {
  slug: string;
  headStart: number;
  bodyStart: number;
}

function headings(text: string): Heading[] {
  const re = /^###\s+(.+?)\s*$/gm;
  const out: Heading[] = [];
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    out.push({ slug: slugify(m[1] ?? ''), headStart: m.index, bodyStart: m.index + m[0].length });
    m = re.exec(text);
  }
  return out;
}

/** Candidate fact strings for tombstoning: the whole body + each bullet line. */
function factCandidates(body: string): string[] {
  const out: string[] = [];
  const trimmed = body.trim();
  if (trimmed) out.push(trimmed);
  for (const line of body.split('\n')) {
    const stripped = line
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*>\s?/, '')
      .trim();
    if (stripped) out.push(stripped);
  }
  return unique(out);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
