// Memory-note linking (plan world-model Task 7.5). `worlds.linkify` answers for
// one world; the Memory page asks only the worlds the note's personality can
// see (its private world plus its non-inert mounts) and merges the answers.
// Pinned by pages/__tests__/memory-entity-links.test.ts.

export interface LinkSpan {
  text: string;
  entity?: { id: string; type: string; world: string };
}

interface MountView {
  mounts: ReadonlyArray<{ world: string }>;
  effective: ReadonlyArray<{ world: string; note?: string | undefined }>;
}

/** The wire ids of the worlds a personality can see: private, then mounts that are not inert. */
export function visibleWorldIds(personalityId: string, m: MountView | undefined): string[] {
  const out = [`personality:${personalityId}`];
  for (const mount of m?.mounts ?? []) {
    const note = m?.effective.find((e) => e.world === mount.world)?.note;
    if (note?.startsWith('inert:')) continue;
    out.push(`world:${mount.world}`);
  }
  return out;
}

/**
 * Merge per-world spans over the same `text`. Earlier worlds win an overlap,
 * so the private world's reading beats a shared one's.
 */
export function mergeSpans(
  text: string,
  results: ReadonlyArray<{
    world: string;
    spans: ReadonlyArray<{ text: string; entity?: { id: string; type: string } | undefined }>;
  }>,
): LinkSpan[] {
  const ranges: Array<{ start: number; end: number; entity: NonNullable<LinkSpan['entity']> }> = [];
  for (const r of results) {
    let at = 0;
    for (const s of r.spans) {
      const end = at + s.text.length;
      if (s.entity && !ranges.some((x) => at < x.end && end > x.start)) {
        ranges.push({ start: at, end, entity: { ...s.entity, world: r.world } });
      }
      at = end;
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  const out: LinkSpan[] = [];
  let last = 0;
  for (const r of ranges) {
    if (r.start > last) out.push({ text: text.slice(last, r.start) });
    out.push({ text: text.slice(r.start, r.end), entity: r.entity });
    last = r.end;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function entityHref(world: string, entityId: string): string {
  return `/world?${new URLSearchParams({ world, entity: entityId }).toString()}`;
}
