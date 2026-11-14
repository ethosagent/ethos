// Licence detection and draft-entry writing of scripts/catalog-import-hermes.ts.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { scanSkillMd } from '@ethosagent/safety-scanner';
import {
  type Classified,
  type Env,
  frontmatter,
  type HermesEntry,
  type HermesSource,
  oneLine,
  SLUG_RE,
  safe,
} from './types';

// ---------------------------------------------------------------------------
// Licence detection (SPDX: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0)
// ---------------------------------------------------------------------------
//
// Heuristic, and said so in every generated entry: each family needs several
// canonical markers, more than one matching family or any extra restriction
// language gives null (reported, not drafted), and a human confirms the result.

const LICENSE_FAMILIES: ReadonlyArray<{ spdx: string; maxLen: number; markers: RegExp[] }> = [
  {
    spdx: 'MIT',
    maxLen: 2500,
    markers: [
      /Permission is hereby granted, free of charge/i,
      /THE SOFTWARE IS PROVIDED ["“”']?AS IS["“”']?/i,
      /above copyright notice and this permission notice shall be included/i,
    ],
  },
  {
    spdx: 'ISC',
    maxLen: 2000,
    markers: [
      /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/i,
      /THE SOFTWARE IS PROVIDED ["“”']?AS IS["“”']? AND THE AUTHOR DISCLAIMS ALL WARRANTIES/i,
    ],
  },
  {
    spdx: 'Apache-2.0',
    maxLen: 14000,
    markers: [/Apache License/, /Version 2\.0/, /TERMS AND CONDITIONS FOR USE, REPRODUCTION/i],
  },
  {
    spdx: 'MPL-2.0',
    maxLen: 20000,
    markers: [/Mozilla Public License/i, /Version 2\.0/, /Exhibit A/i],
  },
  {
    spdx: 'BSD-2-Clause',
    maxLen: 3000,
    markers: [
      /Redistribution and use in source and binary forms, with or without modification, are permitted provided that/i,
      /Redistributions of source code must retain the above copyright notice/i,
      /Redistributions in binary form must reproduce the above copyright notice/i,
      /THIS SOFTWARE IS PROVIDED BY/i,
    ],
  },
];

const RESTRICTION_RE = /commons clause|non-?\s?commercial|not for commercial/i;

export function detectLicense(text: string): string | null {
  const t = text.replace(/\s+/g, ' ');
  const hits = LICENSE_FAMILIES.filter(
    (f) => t.length <= f.maxLen && f.markers.every((m) => m.test(t)),
  ).map((f) => f.spdx);
  if (hits.length !== 1) return null;
  const spdx = hits[0] as string;
  if ((spdx === 'MIT' || spdx === 'ISC' || spdx.startsWith('BSD')) && RESTRICTION_RE.test(t)) {
    return null;
  }
  if (spdx === 'BSD-2-Clause' && /Neither the name of .{0,120}(?:endorse|promote)/i.test(t)) {
    return 'BSD-3-Clause';
  }
  return spdx;
}

const LICENSE_FILE_RE = /^(LICEN[CS]E|COPYING)(\.\w+)?$/i;

type FoundLicense = { ok: true; spdx: string; file: string } | { ok: false; reason: string };

/**
 * Licence files are found in the tree listings (case-insensitive name match,
 * top level only). The subdir's own licence wins when it is recognised; an
 * unrecognised one falls back to the repo root.
 */
async function findLicense(e: HermesEntry, src: HermesSource): Promise<FoundLicense> {
  const seen: string[] = [];
  const places: Array<{
    label: string;
    files: string[];
    read: (f: string) => Promise<string | null>;
  }> = [
    {
      label: e.subdir || '(repo root)',
      files: (await src.tree(e)).filter((f) => !f.includes('/')),
      read: (f) => src.read(e, f),
    },
  ];
  if (e.subdir !== '') {
    places.push({
      label: '(repo root)',
      files: await src.rootFiles(e),
      read: (f) => src.readRoot(e, f),
    });
  }
  for (const p of places) {
    for (const f of p.files.filter((n) => LICENSE_FILE_RE.test(n)).sort()) {
      const spdx = detectLicense((await p.read(f)) ?? '');
      if (spdx !== null)
        return { ok: true, spdx, file: p.label === '(repo root)' ? f : `${p.label}/${f}` };
      seen.push(`${p.label}/${f}`);
    }
  }
  return {
    ok: false,
    reason:
      seen.length > 0
        ? `licence file(s) not recognised as MIT, Apache-2.0, BSD-2/3-Clause, ISC or MPL-2.0 (${seen.join(', ')})`
        : 'no licence file in the subdir or the repo root',
  };
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export interface Drafted {
  entry: HermesEntry;
  kind: 'skill' | 'mcp';
  id: string;
  file: string;
}
export interface NotDrafted {
  name: string;
  reason: string;
}

/**
 * A TS single-quoted string literal; the only way untrusted text reaches
 * generated source. Backslash, quote and every control character (and U+2028/9)
 * are escaped. Pinned by the "adversarial strings" test.
 */
export function q(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (ch === '\\' || ch === "'") out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else out += ch;
  }
  return `'${out}'`;
}

function camel(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** reviewedAt placeholder: scripts/check-catalog.ts fails it ("is not a date") until a human sets a real date. */
export const UNREVIEWED = 'UNREVIEWED';

function header(e: HermesEntry, license: { spdx: string; file: string }, extra: string): string {
  return [
    `// Drafted by scripts/catalog-import-hermes.ts from the Hermes plugin-catalog entry "${e.name}"`,
    `// (Hermes tier "${safe(e.hermesTier, 40)}", ignored: imported entries are always community, D24).`,
    '// UNREVIEWED and NOT admitted: the importer does not run Phase 4. This file must pass',
    '// `pnpm tsx scripts/check-catalog.ts --changed` and a human review before it merges.',
    '// reviewedAt is a placeholder that check-catalog rejects until a human sets the review date.',
    '// capabilities are conservative defaults the reviewer must set from the real code.',
    `// Licence ${license.spdx} was detected heuristically from ${safe(license.file, 120)}; a human must confirm it.`,
    extra,
  ]
    .filter(Boolean)
    .join('\n');
}

// The tier literal below is the only tier this script writes; pinned by the
// "Hermes tier never sets the Ethos tier" test in scripts/__tests__/catalog-import-hermes.test.ts.
function entrySource(a: {
  e: HermesEntry;
  kind: 'skill' | 'mcp';
  id: string;
  name: string;
  description: string;
  pin: string;
  license: { spdx: string; file: string };
  caps: { env: string[]; fs: string; network: string };
  tail: string;
  extraComment: string;
  homepageSubdir: string;
}): string {
  const { e } = a;
  const homepage = `https://github.com/${e.owner}/${e.repo}${a.homepageSubdir ? `/tree/${e.sha}/${a.homepageSubdir}` : ''}`;
  return `import type { CatalogEntry } from '@ethosagent/types';

${header(e, a.license, a.extraComment)}
export const ${camel(a.id)}: CatalogEntry = {
  id: ${q(a.id)},
  kind: ${q(a.kind)},
  name: ${q(a.name)},
  description: ${q(a.description)},
  category: ${q(oneLine(e.category, 40) || 'Other')},
  publisher: ${q(e.owner)},
  tier: 'community',
  pin: ${a.pin},
  capabilities: {
    network: [${a.caps.network}],
    auth: ${a.caps.env.length > 0 ? "'env'" : "'none'"},
    env: [${a.caps.env.map(q).join(', ')}],
    filesystem: ${q(a.caps.fs)},
    shell: false,
  },
  license: ${q(a.license.spdx)},
  homepage: ${q(homepage)},
  reviewedAt: ${q(UNREVIEWED)},
${a.tail}};
`;
}

async function writeNew(path: string, content: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export async function draftEntry(
  c: Classified,
  env: Env,
  entriesDir: string,
): Promise<{ drafted: Drafted[]; skipped: NotDrafted[] }> {
  const e = c.entry;
  const drafted: Drafted[] = [];
  const skipped: NotDrafted[] = [];
  const skip = (reason: string, name = e.name): void => void skipped.push({ name, reason });

  const found = await findLicense(e, env.source);
  if (!found.ok) {
    skip(found.reason);
    return { drafted, skipped };
  }
  const license = { spdx: found.spdx, file: found.file };
  const gitPin = (subdir: string, digest: string): string => `{
    type: 'git',
    repo: ${q(`https://github.com/${e.owner}/${e.repo}`)},
    commit: ${q(e.sha)},${subdir ? `\n    subdir: ${q(subdir)},` : ''}
    contentDigest: ${q(digest)},
  }`;

  if (c.bucket === 'portable-skills') {
    // One entry per SKILL.md, pinned to that skill's own directory so the
    // digest covers just that skill.
    const usedIds = new Set<string>();
    for (const skillPath of c.skillPaths) {
      const dirRel = dirname(skillPath);
      const label = `${e.name}/${dirRel}`;
      const sub: HermesEntry = { ...e, subdir: e.subdir ? `${e.subdir}/${dirRel}` : dirRel };
      const outcome = await env.withTree(sub, async (dir, digest) => {
        const text = await readFile(join(dir, 'SKILL.md'), 'utf8');
        const scan = scanSkillMd(text, skillPath);
        if (scan.hasRed || scan.hasYellow) {
          return `${scan.hasRed ? 'red' : 'yellow'} scanSkillMd finding in ${skillPath}: ${scan.findings[0]?.message ?? ''}`;
        }
        const fm = frontmatter(text);
        const fmName =
          typeof fm?.name === 'string' && fm.name.trim() !== '' ? fm.name.trim() : null;
        return {
          digest,
          skillName: fmName ?? (dirRel.split('/').pop() as string),
          description: typeof fm?.description === 'string' ? oneLine(fm.description) : '',
        };
      });
      if (typeof outcome === 'string') {
        skip(outcome, label);
        continue;
      }
      const id = `hermes-${e.name}-${slugify(outcome.skillName)}`;
      if (!SLUG_RE.test(id) || usedIds.has(id)) {
        skip(
          `skill name "${safe(outcome.skillName, 60)}" gives a non-slug or duplicate id "${safe(id, 80)}"`,
          label,
        );
        continue;
      }
      usedIds.add(id);
      const file = join(entriesDir, 'skill', `${id}.ts`);
      const src = entrySource({
        e,
        kind: 'skill',
        id,
        name: outcome.skillName,
        description: outcome.description || `Imported from the Hermes plugin-catalog: ${e.name}`,
        pin: gitPin(sub.subdir, outcome.digest),
        license,
        caps: { env: [], fs: 'none', network: '' },
        tail: `  skill: { skillName: ${q(outcome.skillName)} },\n`,
        extraComment: '',
        homepageSubdir: sub.subdir,
      });
      if (await writeNew(file, src)) drafted.push({ entry: e, kind: 'skill', id, file });
      else skip(`${file} already exists; not overwritten`, label);
    }
    return { drafted, skipped };
  }

  // portable-mcp: one entry per npx/uvx server; remote servers are not drafted.
  const multi = c.servers.length > 1;
  for (const s of c.servers) {
    const sname = multi ? `${e.name}/${s.name}` : e.name;
    if (s.kind === 'remote') {
      skip(`remote server ${s.url}: remote entries need a human-walked auth procedure`, sname);
      continue;
    }
    const id = `hermes-${multi ? `${e.name}-${s.name}` : e.name}`;
    if (!SLUG_RE.test(id)) {
      skip(`server name gives a non-slug id "${safe(id, 80)}"`, sname);
      continue;
    }
    const resolved =
      s.ecosystem === 'npm'
        ? await env.resolveNpm(s.pkg, s.version)
        : await env.resolvePypi(s.pkg, s.version);
    if (resolved === null) {
      skip(
        `unpinnable: ${s.pkg}${s.version ? `@${s.version}` : ' (no version)'} did not resolve to an exact ${s.ecosystem} version with integrity (offline or not found)`,
        sname,
      );
      continue;
    }
    const pin = `{
    type: ${q(s.ecosystem)},
    package: ${q(s.pkg)},
    version: ${q(resolved.version)},
    integrity: ${q(resolved.integrity)},
  }`;
    const file = join(entriesDir, 'mcp', `${id}.ts`);
    const src = entrySource({
      e,
      kind: 'mcp',
      id,
      name: multi ? `${e.name}/${s.name}` : e.name,
      description: `Imported from the Hermes plugin-catalog: ${e.name}`,
      pin,
      license,
      caps: { env: s.env, fs: 'user-path', network: q('*') },
      tail: `  mcp: { argsAfterSpec: [${s.argsAfterSpec.map(q).join(', ')}], argVars: [], envVars: [${s.env.map(q).join(', ')}] },\n`,
      extraComment: `// Hermes mcp.json named ${safe(`${s.pkg}${s.version ? `@${s.version}` : ''}`, 80)}; pinned to the resolved exact version.`,
      homepageSubdir: e.subdir,
    });
    if (await writeNew(file, src)) drafted.push({ entry: e, kind: 'mcp', id, file });
    else skip(`${file} already exists; not overwritten`, sname);
  }
  return { drafted, skipped };
}

export function draftReport(drafted: readonly Drafted[], skipped: readonly NotDrafted[]): string {
  const lines = [
    `# Hermes draft: ${drafted.length} drafted, ${skipped.length} not drafted`,
    '',
    'THIS RUN DID NOT RUN PHASE 4 ADMISSION. Drafted files are UNREVIEWED: each must pass',
    '`pnpm tsx scripts/check-catalog.ts --changed` and a human review (packages/catalog/README.md',
    'checklist) before it merges. reviewedAt is the placeholder UNREVIEWED, which check-catalog rejects.',
    '',
    '## Drafted (all tier community)',
    '',
    ...drafted.map((d) => `- ${d.id} (${d.kind}): ${d.file}`),
    '',
    '## Not drafted',
    '',
    ...skipped.map((s) => `- ${safe(s.name)}: ${safe(s.reason, 400)}`),
    '',
    '## Next steps',
    '',
    'This script never edits entries/index.ts. Add these lines yourself, to the imports and to',
    'CATALOG_ENTRIES:',
    '',
    ...drafted.flatMap((d) => [
      `    import { ${camel(d.id)} } from './${d.kind}/${d.id}';`,
      `    ${camel(d.id)},`,
    ]),
    '',
  ];
  return lines.join('\n');
}
