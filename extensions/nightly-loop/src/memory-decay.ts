// Importance scoring + decay (memory-experience pillar C, §4).
//
// Decay is DEMOTION TO ARCHIVE, never deletion. At consolidation time each
// distilled section carries a model-assigned importance (§4.1); its effective
// weight is that importance decayed by recency over a half-life. Sections that
// fall below a threshold MOVE to `memory-archive.md` (a `remove`-from-MEMORY.md
// via `replace` + an `add` to the archive — existing contract verbs, no new
// MemoryUpdate action). Everything here is a PURE function of its inputs so it
// is trivially testable; the sidecar I/O and the `sync()` happen in the
// orchestrator's injected deps.
//
// Slug — not content hash — is the stable identity the whole pillar keys on:
// content hashes churn on every reword and would orphan `lastSeen`. The sidecar
// `memory-meta.json` is written by the nightly pass ONLY (single writer, §4.1).

import type { MemoryUpdate } from '@ethosagent/types';
import { type ConsolidationResult, type ScoredSection, slugify } from './memory-consolidation';

const ARCHIVE_KEY = 'memory-archive.md';

/** Per-slug importance + recency, stored in the sidecar keyed by (key, slug). */
export interface MetaEntry {
  /** Model-assigned importance in [0,1] from the latest consolidation. */
  importance: number;
  /** epoch-ms this slug was first seen; preserved across rewords (§4.1). */
  lastSeen: number;
  /**
   * Fact lifecycle state (L4, §3c). Absent ≡ 'active' — existing sidecars (and
   * every slug the nightly decay pass tracks) carry no `state` and read as
   * active. Only explicit lifecycle ops (`ethos memory supersede|retract`) set
   * 'superseded' / 'retracted'; those sections have left the live file for the
   * archive, so they never reappear as a scored consolidation section.
   * 'user-removed' (§5 sidecar-drift reconciliation) is set by the nightly pass
   * when an active slug's `### <slug>` section vanished from the live file
   * without a lifecycle op — the user hand-deleted it. Carried forward like
   * 'retracted'; the section is never resurrected.
   */
  state?: 'active' | 'superseded' | 'retracted' | 'user-removed';
  /** For a superseded section: the slug that replaced it (L4, §3c). */
  supersededBy?: string;
}

/** Sidecar shape — `memory-meta.json` per scope. `keys[file][slug] = entry`. */
export interface MemoryMeta {
  version: 1;
  keys: Record<string, Record<string, MetaEntry>>;
  /**
   * Fact-hashes retracted via `ethos memory retract` (L4, §3c). The DURABLE
   * capture-skip list is the append-only `TombstoneStore` capture consults; this
   * sidecar field is the lifecycle ledger, carried forward across nightly passes.
   */
  retractedHashes?: string[];
}

/** Tuning knobs; the orchestrator resolves defaults via `resolveDecayParams`. */
export interface DecayConfig {
  /** Recency half-life in days (default 30). */
  halfLifeDays?: number;
  /** Effective weight below which a section is archived (default 0.05). */
  threshold?: number;
  /** When true (default), USER.md is exempt from decay entirely (§4.3). */
  exemptUser?: boolean;
}

export interface DecayParams {
  halfLifeMs: number;
  threshold: number;
  exemptUser: boolean;
  /** Injected clock — keeps the planner pure/testable. */
  now: number;
}

/** Explicit defaults (§4.3): USER.md exempt by default, not emergent. */
export const DEFAULT_DECAY_CONFIG: Required<DecayConfig> = {
  halfLifeDays: 30,
  threshold: 0.05,
  exemptUser: true,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveDecayParams(config: DecayConfig | undefined, now: number): DecayParams {
  const halfLifeDays = config?.halfLifeDays ?? DEFAULT_DECAY_CONFIG.halfLifeDays;
  return {
    halfLifeMs: Math.max(1, halfLifeDays) * DAY_MS,
    threshold: config?.threshold ?? DEFAULT_DECAY_CONFIG.threshold,
    exemptUser: config?.exemptUser ?? DEFAULT_DECAY_CONFIG.exemptUser,
    now,
  };
}

export function emptyMeta(): MemoryMeta {
  return { version: 1, keys: {} };
}

/**
 * Tolerant sidecar reader. Any structural problem returns an empty meta so a
 * corrupt file degrades to "no history" (fresh slugs), never a crash.
 */
export function parseMemoryMeta(raw: string | null): MemoryMeta {
  if (!raw) return emptyMeta();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyMeta();
  }
  if (!parsed || typeof parsed !== 'object') return emptyMeta();
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1 || !obj.keys || typeof obj.keys !== 'object') return emptyMeta();

  const keys: MemoryMeta['keys'] = {};
  for (const [key, slugMap] of Object.entries(obj.keys as Record<string, unknown>)) {
    if (!slugMap || typeof slugMap !== 'object') continue;
    const out: Record<string, MetaEntry> = {};
    for (const [slug, entry] of Object.entries(slugMap as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.importance === 'number' && typeof e.lastSeen === 'number') {
        const parsedEntry: MetaEntry = { importance: e.importance, lastSeen: e.lastSeen };
        if (
          e.state === 'superseded' ||
          e.state === 'retracted' ||
          e.state === 'active' ||
          e.state === 'user-removed'
        ) {
          parsedEntry.state = e.state;
        }
        if (typeof e.supersededBy === 'string') parsedEntry.supersededBy = e.supersededBy;
        out[slug] = parsedEntry;
      }
    }
    if (Object.keys(out).length > 0) keys[key] = out;
  }
  const retractedHashes = Array.isArray(obj.retractedHashes)
    ? obj.retractedHashes.filter((h): h is string => typeof h === 'string')
    : [];
  return {
    version: 1,
    keys,
    ...(retractedHashes.length > 0 ? { retractedHashes } : {}),
  };
}

export interface ConsolidationPlan {
  /** MEMORY.md/USER.md `replace` + `memory-archive.md` `add`, existing verbs. */
  updates: MemoryUpdate[];
  /** Next sidecar state — the nightly pass (single writer) persists this. */
  nextMeta: MemoryMeta;
  /** Slugs demoted to the archive this pass (for the step log). */
  archivedSlugs: string[];
  /**
   * Slugs newly marked 'user-removed' this pass (§5 reconciliation) — the
   * caller history-records the sidecar transition so a hand-deletion leaves an
   * auditable trace.
   */
  userRemovedSlugs: string[];
}

interface FileInput {
  key: 'MEMORY.md' | 'USER.md';
  sections: ScoredSection[];
  currentText: string;
  exempt: boolean;
}

/**
 * Plan a decay-aware consolidation. For each file, sections whose effective
 * weight (importance × 2^(-age/halfLife)) falls below the threshold move to the
 * archive; the rest are re-rendered back into the live file. USER.md is exempt
 * by default and is then just re-written (never archived, never destroyed on an
 * empty distillation). The returned `nextMeta` tracks only KEPT slugs of
 * non-exempt files — archived and dropped slugs fall out, so a later restore
 * re-enters as a fresh slug.
 */
export function planConsolidation(args: {
  current: { memory: string; user: string };
  result: ConsolidationResult;
  meta: MemoryMeta;
  params: DecayParams;
}): ConsolidationPlan {
  const { current, result, meta, params } = args;
  const updates: MemoryUpdate[] = [];
  const archivedSlugs: string[] = [];
  const userRemovedSlugs: string[] = [];
  const nextMeta = emptyMeta();
  /** Slugs the model produced this pass (kept OR archived), per file — these
   *  went through the scoring path above and are never drift candidates. */
  const scoredSlugsByKey = new Map<string, Set<string>>();

  const files: FileInput[] = [
    {
      key: 'MEMORY.md',
      sections: result.memorySections ?? [],
      currentText: current.memory,
      exempt: false,
    },
    {
      key: 'USER.md',
      sections: result.userSections ?? [],
      currentText: current.user,
      exempt: params.exemptUser,
    },
  ];

  for (const file of files) {
    scoredSlugsByKey.set(file.key, new Set(file.sections.map((s) => s.slug)));
    if (file.sections.length === 0) continue;

    const prior = meta.keys[file.key] ?? {};
    const kept: ScoredSection[] = [];
    const archived: ScoredSection[] = [];
    const keyMeta: Record<string, MetaEntry> = {};

    for (const section of file.sections) {
      const priorEntry = prior[section.slug];
      // Preserve lastSeen across rewords (slug is the stable key); a brand-new
      // slug is seen `now`. This is what keeps a stale section decaying instead
      // of resetting every night when the model rephrases it.
      const lastSeen = priorEntry ? priorEntry.lastSeen : params.now;
      const age = params.now - lastSeen;
      const weight = section.score * 2 ** (-age / params.halfLifeMs);

      if (!file.exempt && weight < params.threshold) {
        archived.push(section);
      } else {
        kept.push(section);
        if (!file.exempt) keyMeta[section.slug] = { importance: section.score, lastSeen };
      }
    }

    if (Object.keys(keyMeta).length > 0) nextMeta.keys[file.key] = keyMeta;

    const keptText = kept.map(renderSection).join('\n\n').trim();
    const changed = keptText !== file.currentText.trim();

    if (file.exempt) {
      // Never destructive: an empty distillation leaves USER.md as-is.
      if (keptText.length > 0 && changed) {
        updates.push({ action: 'replace', key: file.key, content: keptText });
      }
    } else if (changed && (keptText.length > 0 || archived.length > 0)) {
      // A `replace` to '' is acceptable here only because the removed bytes are
      // captured in the archive `add` below (and, always, in the history diff).
      updates.push({ action: 'replace', key: file.key, content: keptText });
    }

    for (const section of archived) {
      updates.push({
        action: 'add',
        key: ARCHIVE_KEY,
        content: formatArchiveBlock(section, file.key, params.now),
      });
      archivedSlugs.push(section.slug);
    }
  }

  // L4: preserve the lifecycle ledger across the nightly rebuild. Superseded /
  // retracted slugs have left the live files, so they never surface as a scored
  // section above — carry their sidecar entries (and the retracted-hash list)
  // forward verbatim. Active importance is rebuilt from the scored sections;
  // lifecycle state is copied, not recomputed. This is the single-writer's half
  // of the L4 coexistence contract: the nightly pass never drops a state an
  // explicit lifecycle op recorded (see extensions/nightly-loop/memory-lifecycle).
  //
  // §5 sidecar-drift reconciliation rides the same sweep: an ACTIVE entry whose
  // `### <slug>` section is no longer in the live file's PRE-PASS text was
  // hand-deleted by the user (a model reword still carries the heading; a
  // model drop leaves the heading in the pre-pass text). Mark it 'user-removed'
  // and carry it forward like a retraction — never resurrect the section. If
  // the user later re-adds the section by hand it is re-scored above and the
  // fresh active entry wins.
  const liveSlugsByKey = new Map<string, Set<string>>([
    ['MEMORY.md', liveSlugs(current.memory)],
    ['USER.md', liveSlugs(current.user)],
  ]);
  for (const [fileKey, slugMap] of Object.entries(meta.keys)) {
    for (const [slug, entry] of Object.entries(slugMap)) {
      if (entry.state === 'superseded' || entry.state === 'retracted') {
        const carried = nextMeta.keys[fileKey] ?? {};
        carried[slug] = entry;
        nextMeta.keys[fileKey] = carried;
        continue;
      }
      if (nextMeta.keys[fileKey]?.[slug]) continue; // re-scored this pass — active wins
      if (entry.state === 'user-removed') {
        const carried = nextMeta.keys[fileKey] ?? {};
        carried[slug] = entry;
        nextMeta.keys[fileKey] = carried;
        continue;
      }
      // Drift test: an active entry counts as hand-deleted only when the model
      // did NOT score the slug this pass (a scored slug was kept or archived
      // above — both legitimate) AND its `### <slug>` heading is absent from
      // the PRE-PASS live text.
      if (scoredSlugsByKey.get(fileKey)?.has(slug)) continue;
      const live = liveSlugsByKey.get(fileKey);
      if (live !== undefined && !live.has(slug)) {
        const carried = nextMeta.keys[fileKey] ?? {};
        carried[slug] = { ...entry, state: 'user-removed' };
        nextMeta.keys[fileKey] = carried;
        userRemovedSlugs.push(slug);
      }
    }
  }
  if (meta.retractedHashes && meta.retractedHashes.length > 0) {
    nextMeta.retractedHashes = [...meta.retractedHashes];
  }

  return { updates, nextMeta, archivedSlugs, userRemovedSlugs };
}

/** Render a section as `### <slug>\n<content>`. */
export function renderSection(section: ScoredSection): string {
  return `### ${section.slug}\n${section.content.trim()}`;
}

/** Slugs of the `### <heading>` sections present in a live file's text. */
function liveSlugs(text: string): Set<string> {
  const out = new Set<string>();
  const re = /^###\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    out.add(slugify(m[1] ?? ''));
    m = re.exec(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Archive block format — a machine-parseable marker + the section, so restore
// can move a section back BY SLUG (§4.2). The archive is not the pristine
// MEMORY.md, so a marker comment is acceptable here (unlike in MEMORY.md).
// ---------------------------------------------------------------------------

export interface ArchiveBlock {
  slug: string;
  fromKey: string;
  iso: string;
  /** Full block text incl. marker — used to re-serialise the archive. */
  raw: string;
  /** Just the `### <slug>\n<body>` section — used to restore into the file. */
  section: string;
}

export function formatArchiveBlock(section: ScoredSection, fromKey: string, now: number): string {
  const iso = new Date(now).toISOString();
  return `<!-- archived ${iso} slug=${section.slug} from=${fromKey} -->\n${renderSection(section)}`;
}

const ARCHIVE_MARKER = /<!-- archived (\S+) slug=(\S+) from=(\S+) -->/g;

export function parseArchiveBlocks(archive: string): ArchiveBlock[] {
  const markers: Array<{
    index: number;
    markerLen: number;
    iso: string;
    slug: string;
    from: string;
  }> = [];
  let m: RegExpExecArray | null = ARCHIVE_MARKER.exec(archive);
  while (m !== null) {
    markers.push({
      index: m.index,
      markerLen: m[0].length,
      iso: m[1] ?? '',
      slug: m[2] ?? '',
      from: m[3] ?? '',
    });
    m = ARCHIVE_MARKER.exec(archive);
  }
  ARCHIVE_MARKER.lastIndex = 0;

  const blocks: ArchiveBlock[] = [];
  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i];
    if (!cur) continue;
    const next = markers[i + 1];
    const end = next ? next.index : archive.length;
    blocks.push({
      slug: cur.slug,
      fromKey: cur.from,
      iso: cur.iso,
      raw: archive.slice(cur.index, end).trim(),
      section: archive.slice(cur.index + cur.markerLen, end).trim(),
    });
  }
  return blocks;
}
