// world.yaml / worlds.yaml shapes. Parsing only: the single writer of both
// files is WorldConfigService (a later task); nothing here touches disk.

import { isNode, LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { isSafeSlug } from './ids';

export type MountMode = 'read' | 'propose';

const slug = z.string().refine(isSafeSlug, 'must be a lowercase slug (a-z, 0-9, _ and -)');

export const WorldFileSchema = z
  .object({
    id: slug,
    title: z.string().min(1),
    audience: z.enum(['owner_only', 'shareable']).default('owner_only'),
    backend: z.string().min(1).default('sqlite'),
    readers: z.array(slug).default([]),
    proposers: z.array(slug).default([]),
  })
  .strict();

export const MountsFileSchema = z
  .object({
    mounts: z
      .array(
        z
          .object({
            world: slug,
            mode: z.enum(['read', 'propose']),
            as: slug.optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type WorldFile = z.infer<typeof WorldFileSchema>;
export type MountsFile = z.infer<typeof MountsFileSchema>;

export interface ConfigIssue {
  /** 1-based line in the YAML text. */
  line: number;
  message: string;
}

export class WorldConfigError extends Error {
  readonly issues: ConfigIssue[];
  constructor(label: string, issues: ConfigIssue[]) {
    super(`${label}: ${issues.map((i) => `line ${i.line}: ${i.message}`).join('; ')}`);
    this.name = 'WorldConfigError';
    this.issues = issues;
  }
}

export type YamlDoc = ReturnType<typeof parseDocument>;

/** 1-based line and column of the node at `path`, walking up to the nearest parent that exists. */
export function posOf(
  doc: YamlDoc,
  lc: LineCounter,
  path: ReadonlyArray<PropertyKey>,
): { line: number; col: number } {
  const p = [...path];
  for (;;) {
    const node = p.length === 0 ? doc.contents : doc.getIn(p, true);
    if (isNode(node) && node.range) return lc.linePos(node.range[0]);
    if (p.length === 0) return { line: 1, col: 1 };
    p.pop();
  }
}

function parseWith<T>(
  label: string,
  text: string,
  schema: z.ZodType<T>,
  extra: (value: T, at: (path: ReadonlyArray<PropertyKey>) => number) => ConfigIssue[],
): T {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new WorldConfigError(
      label,
      doc.errors.map((e) => ({
        line: e.linePos?.[0].line ?? 1,
        message: e.message.split('\n')[0] ?? e.code,
      })),
    );
  }
  const at = (path: ReadonlyArray<PropertyKey>) => posOf(doc, lc, path).line;
  const parsed = schema.safeParse(doc.toJS());
  if (!parsed.success) {
    const issues: ConfigIssue[] = [];
    for (const issue of parsed.error.issues) {
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys) {
          issues.push({ line: at([...issue.path, key]), message: `unknown key "${key}"` });
        }
      } else {
        const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        issues.push({ line: at(issue.path), message: `${where}${issue.message}` });
      }
    }
    throw new WorldConfigError(label, issues);
  }
  const more = extra(parsed.data, at);
  if (more.length > 0) throw new WorldConfigError(label, more);
  return parsed.data;
}

export function parseWorldYaml(text: string): WorldFile {
  return parseWith('world.yaml', text, WorldFileSchema, (w, at) =>
    dupes('readers', w.readers, at).concat(dupes('proposers', w.proposers, at)),
  );
}

function dupes(
  key: string,
  values: string[],
  at: (path: ReadonlyArray<PropertyKey>) => number,
): ConfigIssue[] {
  const seen = new Set<string>();
  const out: ConfigIssue[] = [];
  values.forEach((v, i) => {
    if (seen.has(v)) out.push({ line: at([key, i]), message: `duplicate ${key} entry "${v}"` });
    seen.add(v);
  });
  return out;
}

/**
 * worlds.yaml. Rule 4 (aliases unique per personality, never another mount's
 * slug) is enforced here, pinned by world-config.test.ts 'duplicate alias
 * fails with the line' and 'alias may not equal another mounted world'.
 */
export function parseMountsYaml(text: string): MountsFile {
  return parseWith('worlds.yaml', text, MountsFileSchema, (m, at) => {
    const issues: ConfigIssue[] = [];
    const mountedSlugs = new Set(m.mounts.map((x) => x.world));
    const worldsSeen = new Set<string>();
    const aliasesSeen = new Set<string>();
    m.mounts.forEach((mount, i) => {
      if (worldsSeen.has(mount.world)) {
        issues.push({
          line: at(['mounts', i, 'world']),
          message: `world "${mount.world}" is mounted twice`,
        });
      }
      worldsSeen.add(mount.world);
      if (mount.as === undefined) return;
      if (aliasesSeen.has(mount.as)) {
        issues.push({ line: at(['mounts', i, 'as']), message: `duplicate alias "${mount.as}"` });
      }
      aliasesSeen.add(mount.as);
      if (mount.as !== mount.world && mountedSlugs.has(mount.as)) {
        issues.push({
          line: at(['mounts', i, 'as']),
          message: `alias "${mount.as}" equals the slug of another mounted world`,
        });
      }
    });
    return issues;
  });
}
