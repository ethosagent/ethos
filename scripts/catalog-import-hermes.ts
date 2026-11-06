// Hermes plugin-catalog importer (plan/phases/unified-catalog.md section 8, D23, D24).
// A maintainer tool, not shipped in the CLI.
//
//   Measure (default; the first deliverable). Classifies every Hermes
//   `plugin-catalog/<name>.yaml` entry and writes counts per bucket and per Hermes
//   tier as markdown. Nothing else happens.
//     pnpm tsx scripts/catalog-import-hermes.ts --hermes-commit <sha> --out plan/research/hermes-portability-<date>.md
//     pnpm tsx scripts/catalog-import-hermes.ts --source <hermes checkout> --trees <dir> --out <file>
//
//   Draft (--draft, only when asked). For each portable entry writes
//   packages/catalog/src/entries/<kind>/hermes-<name>[-<skill|server>].ts: one
//   entry per SKILL.md (git pin on that skill's own directory) and one per
//   npx/uvx server (npm/pypi pin, exact version resolved or reported
//   unpinnable). The tier is always the literal `tier: 'community'` in
//   `entrySource` (D24); the Hermes tier is never read there, and the test "the
//   Hermes tier never sets the Ethos tier" in
//   scripts/__tests__/catalog-import-hermes.test.ts pins it.
//   An entry with no recognised licence, or a red/yellow scanSkillMd finding, is
//   reported, not drafted. Licence detection is a heuristic (several markers per
//   family, ambiguity gives null); each draft says which file was read and that a
//   human must confirm it.
//
//   DRAFT DOES NOT RUN PHASE 4 ADMISSION. Drafts carry reviewedAt "UNREVIEWED"
//   (which scripts/check-catalog.ts rejects as "not a date") and must pass
//   `pnpm tsx scripts/check-catalog.ts --changed` and human review. The entries
//   barrel (entries/index.ts) is never edited: the lines to add are printed.
//
// Inputs: either `--hermes-commit <sha> [--hermes-repo owner/repo]` (GitHub API;
// optional GITHUB_TOKEN in the environment; git for the pin) or `--source <dir>`
// (a hermes-agent checkout with plugin-catalog/*.yaml) with `--trees <dir>` laid
// out `<owner>/<repo>/<sha>/<subdir>/...`, which stands in for GitHub and needs no
// network. Local mode cannot reach npm/PyPI, so every mcp.json package server is
// reported unpinnable there, unless the test seam `--fake-registry <file.json>`
// (local mode only; `{"npm:<pkg>": {"version", "integrity"}, "pypi:<pkg>": ...}`)
// supplies the resolution.
//
// Known limits: GitHub mode (rate-limit exit, truncated trees, the npm/PyPI
// resolvers and the two-step git fetch) is implemented but only exercised live by
// a maintainer; the offline tests do not cover it. Per-entry work runs 8 at a
// time with results kept in catalog order.
//
// Exit codes: 0 done (also when entries were not drafted: see the report),
// 1 a run failure (rate limit, unreadable source, write error), 2 usage error.
//
// Every outside call goes through the injected `Env`; scripts/__tests__/
// catalog-import-hermes.test.ts spawns this file against a fixture tree (it never
// imports it, which would put this script under archcheck's layer rules).
// `console` is allowed here: scripts are outside l10-silent-libraries' scope.

import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import {
  computeTreeDigest,
  fetchGitTreeDigest,
  withGitPinnedTree,
} from '@ethosagent/plugin-loader';
import { scanSkillMd } from '@ethosagent/safety-scanner';
import { parse as parseYaml } from 'yaml';
import { canParse as canParseHermes } from '../extensions/skills/src/dialects/hermes';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const BUCKETS = ['portable-mcp', 'portable-skills', 'python-only', 'other'] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface HermesEntry {
  name: string;
  owner: string;
  repo: string;
  sha: string;
  subdir: string;
  /** The Hermes tier, verbatim; only ever reported, never copied (D24). */
  hermesTier: string;
  category: string;
}

export type McpServerPlan =
  | { kind: 'remote'; name: string; url: string }
  | {
      kind: 'package';
      name: string;
      ecosystem: 'npm' | 'pypi';
      pkg: string;
      version: string | null;
      argsAfterSpec: string[];
      env: string[];
    };

export interface Classified {
  entry: HermesEntry;
  bucket: Bucket;
  reason: string;
  servers: McpServerPlan[];
  skillPaths: string[];
  /** portable-mcp only: every server is a remote url or names an exact version. */
  pinnable: boolean;
}

export interface Resolved {
  version: string;
  integrity: string;
}

/** Reads entries and trees; local-tree mode and the GitHub API both implement it. */
export interface HermesSource {
  entryFiles(): Promise<Array<{ file: string; text: string }>>;
  /** Regular files under the entry's subdir, relative to it. */
  tree(e: HermesEntry): Promise<string[]>;
  /** A file under the subdir, or null when absent. */
  read(e: HermesEntry, rel: string): Promise<string | null>;
  /** A file at the repository root, or null when absent. */
  readRoot(e: HermesEntry, rel: string): Promise<string | null>;
  /** Regular files at the top level of the repository. */
  rootFiles(e: HermesEntry): Promise<string[]>;
}

export interface Env {
  source: HermesSource;
  /** Run `fn` over the entry's pinned directory and its contentDigest. */
  withTree<T>(e: HermesEntry, fn: (dir: string, digest: string) => Promise<T>): Promise<T>;
  /** Exact version + integrity; version null means "latest". null when unavailable. */
  resolveNpm(pkg: string, version: string | null): Promise<Resolved | null>;
  resolvePypi(pkg: string, version: string | null): Promise<Resolved | null>;
}

class UsageError extends Error {}
class RateLimitError extends Error {}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function oneLine(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/** Untrusted text for markdown or a source comment: one line, a tame charset. */
export function safe(s: string, max = 200): string {
  return oneLine(s, max).replace(/[^\w .,:;/@()+=\-"']/g, '?');
}

/** `fn` over `items`, `limit` at a time; results keep the input order. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// Entry parsing and validation (names come from untrusted YAML)
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function safeSubdir(subdir: string): boolean {
  if (subdir === '') return true;
  return subdir
    .split('/')
    .every((s) => s !== '' && s !== '.' && s !== '..' && !s.includes('\\') && !s.includes('\0'));
}

type Parsed = { ok: true; entry: HermesEntry } | { ok: false; name: string; reason: string };

export function parseEntry(file: string, text: string): Parsed {
  const stem = file.replace(/\.ya?ml$/, '');
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    return { ok: false, name: stem, reason: `unparseable YAML: ${errMsg(err)}` };
  }
  if (!isObj(doc)) return { ok: false, name: stem, reason: 'YAML is not a mapping' };
  const d = doc;
  const str = (k: string): string => (typeof d[k] === 'string' ? (d[k] as string) : '');
  const name = str('name') || stem;
  const m = /^(?:https:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(str('repo'));
  const owner = m?.[1] ?? '';
  const repo = m?.[2] ?? '';
  if (!SLUG_RE.test(name)) return { ok: false, name, reason: `name "${name}" is not a slug` };
  if (!OWNER_REPO_RE.test(owner) || !OWNER_REPO_RE.test(repo) || owner === '..' || repo === '..') {
    return { ok: false, name, reason: `repo "${str('repo')}" is not a GitHub owner/repo` };
  }
  const sha = str('sha');
  if (!SHA_RE.test(sha)) return { ok: false, name, reason: 'sha is not a 40-hex commit' };
  const subdir = str('subdir').replace(/^\/+|\/+$/g, '');
  if (!safeSubdir(subdir)) return { ok: false, name, reason: `subdir "${subdir}" is not safe` };
  return {
    ok: true,
    entry: {
      name,
      owner,
      repo,
      sha,
      subdir,
      hermesTier: str('tier') || 'unknown',
      category: str('category'),
    },
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const EXACT_VERSION_RE = /^v?\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/;

function exactOrNull(v: string | undefined): string | null {
  return v !== undefined && EXACT_VERSION_RE.test(v) ? v.replace(/^v/, '') : null;
}

/** `pkg`, `pkg@1.2.3`, `@scope/pkg@1.2.3`, and for PyPI `pkg==1.2.3`. */
export function splitSpec(
  spec: string,
  ecosystem: 'npm' | 'pypi',
): { pkg: string; version: string | null } | null {
  let pkg = spec;
  let version: string | undefined;
  const eq = ecosystem === 'pypi' ? spec.indexOf('==') : -1;
  if (eq > 0) {
    pkg = spec.slice(0, eq);
    version = spec.slice(eq + 2);
  } else {
    const at = spec.lastIndexOf('@');
    if (at > 0) {
      pkg = spec.slice(0, at);
      version = spec.slice(at + 1);
    }
  }
  const nameRe = ecosystem === 'npm' ? /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/ : /^[A-Za-z0-9._-]+$/;
  if (!nameRe.test(pkg)) return null;
  return { pkg, version: exactOrNull(version) };
}

function planServer(name: string, raw: unknown): McpServerPlan | string {
  if (!isObj(raw)) return `server "${name}" is not an object`;
  const s = raw;
  if (typeof s.url === 'string') {
    return /^https:\/\//.test(s.url)
      ? { kind: 'remote', name, url: s.url }
      : `server "${name}" url is not https`;
  }
  const cmd = typeof s.command === 'string' ? (s.command.split('/').pop() ?? '') : '';
  if (cmd !== 'npx' && cmd !== 'uvx') return `server "${name}" runs "${cmd || '?'}", not npx/uvx`;
  const ecosystem = cmd === 'npx' ? 'npm' : 'pypi';
  const args = Array.isArray(s.args)
    ? s.args.filter((a): a is string => typeof a === 'string')
    : [];
  let i = 0;
  let from: string | null = null;
  for (; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '-y' || a === '--yes' || a === '--ignore-scripts') continue;
    if (ecosystem === 'pypi' && a === '--from' && args[i + 1] !== undefined) {
      from = args[i + 1] as string;
      i++;
      continue;
    }
    break;
  }
  const specRaw = from ?? args[i];
  if (specRaw === undefined || specRaw.startsWith('-')) {
    return `server "${name}" has no plain package argument`;
  }
  const split = splitSpec(specRaw, ecosystem);
  if (!split) return `server "${name}" package "${specRaw}" is not a plain package name`;
  const rest = from === null ? args.slice(i + 1) : args.slice(i);
  const envObj = isObj(s.env) ? s.env : {};
  return {
    kind: 'package',
    name,
    ecosystem,
    pkg: split.pkg,
    version: split.version,
    argsAfterSpec: rest,
    env: Object.keys(envObj).filter((k) => /^[A-Z_][A-Z0-9_]*$/.test(k)),
  };
}

export function parseMcpJson(text: string): { servers: McpServerPlan[]; error: string | null } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { servers: [], error: 'mcp.json is not valid JSON' };
  }
  const root = isObj(doc) ? doc : {};
  const map = root.mcpServers ?? root.servers;
  if (!isObj(map)) return { servers: [], error: 'mcp.json has no mcpServers map' };
  const servers: McpServerPlan[] = [];
  for (const [n, raw] of Object.entries(map)) {
    const p = planServer(n, raw);
    if (typeof p === 'string') return { servers: [], error: p };
    servers.push(p);
  }
  return servers.length === 0
    ? { servers: [], error: 'mcp.json declares no servers' }
    : { servers, error: null };
}

function frontmatter(text: string): Record<string, unknown> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  try {
    const d = parseYaml(m[1] as string);
    return isObj(d) ? d : null;
  } catch {
    return null;
  }
}

export async function classify(e: HermesEntry, src: HermesSource): Promise<Classified> {
  const done = (bucket: Bucket, reason: string, extra: Partial<Classified> = {}): Classified => ({
    entry: e,
    bucket,
    reason,
    servers: [],
    skillPaths: [],
    pinnable: false,
    ...extra,
  });
  let files: string[];
  try {
    files = await src.tree(e);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    return done('other', `tree unavailable: ${errMsg(err)}`);
  }
  const has = new Set(files);

  let mcpReason = '';
  if (has.has('mcp.json')) {
    const parsed = parseMcpJson((await src.read(e, 'mcp.json')) ?? '');
    if (parsed.error === null) {
      return done('portable-mcp', `${parsed.servers.length} server(s)`, {
        servers: parsed.servers,
        pinnable: parsed.servers.every((v) => v.kind === 'remote' || v.version !== null),
      });
    }
    mcpReason = parsed.error;
  }

  const skillFiles = files.filter((f) => /^skills\/(?:.+\/)?SKILL\.md$/.test(f));
  if (skillFiles.length > 0) {
    const bad: string[] = [];
    for (const f of skillFiles) {
      const fm = frontmatter((await src.read(e, f)) ?? '');
      if (fm === null || !canParseHermes(fm)) bad.push(f);
    }
    if (bad.length === 0) {
      return done('portable-skills', `${skillFiles.length} Hermes-dialect skill(s)`, {
        skillPaths: skillFiles,
      });
    }
    mcpReason ||= `${bad.length} SKILL.md not in the Hermes dialect (${bad[0]})`;
  }

  if (!has.has('mcp.json') && has.has('__init__.py')) {
    if (/\bregister\(/.test((await src.read(e, '__init__.py')) ?? '')) {
      return done('python-only', '__init__.py registers a Python plugin and has no mcp.json');
    }
  }
  return done('other', mcpReason || 'no mcp.json, skills/ or Python register()');
}

// ---------------------------------------------------------------------------
// Measure report
// ---------------------------------------------------------------------------

export function measureReport(
  results: readonly Classified[],
  invalid: ReadonlyArray<{ name: string; reason: string }>,
  label: string,
  date: string,
): string {
  const tierOf = (r: Classified): string => safe(r.entry.hermesTier, 40);
  const tiers = [...new Set(results.map(tierOf))].sort();
  const count = (b: Bucket, t?: string): number =>
    results.filter((r) => r.bucket === b && (t === undefined || tierOf(r) === t)).length;
  const total = results.length + invalid.length;
  const mcp = results.filter((r) => r.bucket === 'portable-mcp');
  const lines: string[] = [
    `# Hermes portability survey (${date})`,
    '',
    `Source: ${safe(label, 200)}`,
    `Entries: ${total} (${results.length} classified, ${invalid.length} invalid)`,
    '',
    'Buckets come from file contents only. Whether an entry can be drafted also depends on a',
    'recognised licence, the scanSkillMd result and registry resolution, none of which this',
    'measurement runs. `portable-mcp` includes servers with no explicit version; those need',
    'npm/PyPI resolution at draft time and may turn out unpinnable (split below).',
    '',
    '## Per bucket',
    '',
    '| Bucket | Count |',
    '|---|---|',
    ...BUCKETS.map((b) => `| ${b} | ${count(b)} |`),
    `| invalid entry | ${invalid.length} |`,
    '',
    `- portable-mcp with an explicit exact version or a remote url on every server: ${mcp.filter((r) => r.pinnable).length}`,
    `- portable-mcp needing version resolution: ${mcp.filter((r) => !r.pinnable).length}`,
    '',
    '## Per Hermes tier',
    '',
    `| Hermes tier | ${BUCKETS.join(' | ')} | total |`,
    `|---|${BUCKETS.map(() => '---').join('|')}|---|`,
    ...tiers.map(
      (t) =>
        `| ${t} | ${BUCKETS.map((b) => count(b, t)).join(' | ')} | ${results.filter((r) => tierOf(r) === t).length} |`,
    ),
    '',
    '## Portable entries',
    '',
    ...results
      .filter((r) => r.bucket === 'portable-mcp' || r.bucket === 'portable-skills')
      .map(
        (r) => `- ${safe(r.entry.name)} (${r.bucket}, Hermes tier ${tierOf(r)}): ${safe(r.reason)}`,
      ),
    '',
    '## Invalid entries',
    '',
    ...invalid.map((i) => `- ${safe(i.name)}: ${safe(i.reason)}`),
    '',
    'The Hermes tier is reported only. Imported entries are always `community` (D24).',
    '',
  ];
  return lines.join('\n');
}

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

// ---------------------------------------------------------------------------
// Local-tree environment (offline)
// ---------------------------------------------------------------------------

async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(join(root, rel))) {
    if (rel === '' && name === '.git') continue;
    const r = rel === '' ? name : `${rel}/${name}`;
    const st = await lstat(join(root, r));
    if (st.isDirectory()) out.push(...(await walk(root, r)));
    else if (st.isFile()) out.push(r);
  }
  return out.sort();
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export function localEnv(
  sourceDir: string,
  treesDir: string,
  fake: Readonly<Record<string, Resolved>> = {},
): Env {
  const repoRoot = (e: HermesEntry): string => join(treesDir, e.owner, e.repo, e.sha);
  const subRoot = (e: HermesEntry): string => join(repoRoot(e), e.subdir);
  const source: HermesSource = {
    async entryFiles() {
      const dir = join(sourceDir, 'plugin-catalog');
      const names = (await readdir(dir)).filter((n) => /\.ya?ml$/.test(n)).sort();
      return Promise.all(
        names.map(async (file) => ({ file, text: await readFile(join(dir, file), 'utf8') })),
      );
    },
    tree: (e) => walk(subRoot(e)),
    read: (e, rel) => readOrNull(join(subRoot(e), rel)),
    readRoot: (e, rel) => readOrNull(join(repoRoot(e), rel)),
    async rootFiles(e) {
      const root = repoRoot(e);
      const names = await readdir(root);
      const files: string[] = [];
      for (const n of names) if ((await lstat(join(root, n))).isFile()) files.push(n);
      return files.sort();
    },
  };
  return {
    source,
    async withTree(e, fn) {
      const dir = subRoot(e);
      return fn(dir, await computeTreeDigest(dir));
    },
    // No network in local-tree mode: resolution comes only from the test seam.
    resolveNpm: async (pkg) => fake[`npm:${pkg}`] ?? null,
    resolvePypi: async (pkg) => fake[`pypi:${pkg}`] ?? null,
  };
}

// ---------------------------------------------------------------------------
// GitHub environment (maintainer-run; exercised live, not by the offline tests)
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';

export function githubEnv(
  hermesRepo: string,
  hermesCommit: string,
  token: string | undefined,
): Env {
  const headers = (raw: boolean): Record<string, string> => ({
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'User-Agent': 'ethos-catalog-import-hermes',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  const get = async (url: string, raw: boolean): Promise<string | null> => {
    const res = await fetch(url, { headers: headers(raw), signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 429) {
      throw new RateLimitError(
        `GitHub refused ${url} (${res.status}); set GITHUB_TOKEN or wait for the rate limit to reset`,
      );
    }
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
    return res.text();
  };
  const trees = new Map<string, Promise<string[]>>();
  const repoTree = (e: HermesEntry): Promise<string[]> => {
    const key = `${e.owner}/${e.repo}@${e.sha}`;
    let p = trees.get(key);
    if (!p) {
      p = (async () => {
        const body = await get(
          `${GITHUB_API}/repos/${e.owner}/${e.repo}/git/trees/${e.sha}?recursive=1`,
          false,
        );
        if (body === null) throw new Error(`${key} not found`);
        const j: unknown = JSON.parse(body);
        if (!isObj(j) || !Array.isArray(j.tree))
          throw new Error(`${key} tree has an unexpected shape`);
        if (j.truncated === true) throw new Error(`${key} tree is truncated by the API`);
        return j.tree.flatMap((t: unknown) =>
          isObj(t) && t.type === 'blob' && typeof t.path === 'string' ? [t.path] : [],
        );
      })();
      trees.set(key, p);
    }
    return p;
  };
  const readPath = (e: HermesEntry, path: string): Promise<string | null> =>
    get(
      `${GITHUB_API}/repos/${e.owner}/${e.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${e.sha}`,
      true,
    );
  const source: HermesSource = {
    async entryFiles() {
      const listing = await get(
        `${GITHUB_API}/repos/${hermesRepo}/contents/plugin-catalog?ref=${hermesCommit}`,
        false,
      );
      if (listing === null)
        throw new Error(`plugin-catalog/ not found in ${hermesRepo}@${hermesCommit}`);
      const parsed: unknown = JSON.parse(listing);
      if (!Array.isArray(parsed))
        throw new Error('plugin-catalog/ listing has an unexpected shape');
      const names = parsed
        .flatMap((f: unknown) =>
          isObj(f) && f.type === 'file' && typeof f.name === 'string' && /\.ya?ml$/.test(f.name)
            ? [f.name]
            : [],
        )
        .sort();
      const texts = await pool(names, CONCURRENCY, async (file) => ({
        file,
        text: await get(
          `${GITHUB_API}/repos/${hermesRepo}/contents/plugin-catalog/${encodeURIComponent(file)}?ref=${hermesCommit}`,
          true,
        ),
      }));
      return texts.flatMap((t) => (t.text === null ? [] : [{ file: t.file, text: t.text }]));
    },
    async tree(e) {
      const prefix = e.subdir === '' ? '' : `${e.subdir}/`;
      return (await repoTree(e))
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length));
    },
    read: (e, rel) => readPath(e, e.subdir === '' ? rel : `${e.subdir}/${rel}`),
    readRoot: (e, rel) => readPath(e, rel),
    async rootFiles(e) {
      return (await repoTree(e)).filter((p) => !p.includes('/'));
    },
  };
  const input = (e: HermesEntry) => ({
    repo: `https://github.com/${e.owner}/${e.repo}`,
    commit: e.sha,
    ...(e.subdir ? { subdir: e.subdir } : {}),
  });
  return {
    source,
    async withTree(e, fn) {
      const contentDigest = await fetchGitTreeDigest(input(e));
      return withGitPinnedTree({ ...input(e), contentDigest }, (dir) => fn(dir, contentDigest));
    },
    resolveNpm: resolveNpmReal,
    resolvePypi: resolvePypiReal,
  };
}

async function resolveNpmReal(pkg: string, version: string | null): Promise<Resolved | null> {
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['view', version ? `${pkg}@${version}` : pkg, 'version', 'dist.integrity', '--json'],
      { timeout: 60_000 },
    );
    const j: unknown = JSON.parse(stdout);
    const o: unknown = Array.isArray(j) ? j[j.length - 1] : j; // a range can match several versions
    return isObj(o) && typeof o.version === 'string' && typeof o['dist.integrity'] === 'string'
      ? { version: o.version, integrity: o['dist.integrity'] }
      : null;
  } catch {
    return null;
  }
}

async function resolvePypiReal(pkg: string, version: string | null): Promise<Resolved | null> {
  try {
    const url = version
      ? `https://pypi.org/pypi/${encodeURIComponent(pkg)}/${encodeURIComponent(version)}/json`
      : `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const j: unknown = await res.json();
    if (
      !isObj(j) ||
      !isObj(j.info) ||
      typeof j.info.version !== 'string' ||
      !Array.isArray(j.urls)
    ) {
      return null;
    }
    for (const u of j.urls as unknown[]) {
      if (
        isObj(u) &&
        typeof u.filename === 'string' &&
        u.filename.endsWith('py3-none-any.whl') &&
        isObj(u.digests) &&
        typeof u.digests.sha256 === 'string'
      ) {
        return { version: j.info.version, integrity: `sha256-${u.digests.sha256}` };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseFakeRegistry(text: string): Record<string, Resolved> {
  const j: unknown = JSON.parse(text);
  if (!isObj(j)) throw new UsageError('--fake-registry must be a JSON object');
  const out: Record<string, Resolved> = {};
  for (const [k, v] of Object.entries(j)) {
    if (!isObj(v) || typeof v.version !== 'string' || typeof v.integrity !== 'string') {
      throw new UsageError(`--fake-registry entry "${k}" needs string version and integrity`);
    }
    out[k] = { version: v.version, integrity: v.integrity };
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function main(argv: string[], envOverride?: Env): Promise<number> {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    values = parseArgs({
      args: argv,
      options: {
        source: { type: 'string' },
        trees: { type: 'string' },
        'hermes-commit': { type: 'string' },
        'hermes-repo': { type: 'string', default: 'NousResearch/hermes-agent' },
        out: { type: 'string' },
        draft: { type: 'boolean', default: false },
        'entries-dir': { type: 'string' },
        date: { type: 'string' },
        'fake-registry': { type: 'string' },
      },
      strict: true,
    }).values;
  } catch (err) {
    console.error(`usage error: ${errMsg(err)}`);
    return 2;
  }
  const str = (k: string): string | undefined =>
    typeof values[k] === 'string' ? (values[k] as string) : undefined;
  const date = str('date') ?? new Date().toISOString().slice(0, 10);
  const local = str('source') !== undefined || str('trees') !== undefined;
  const commit = str('hermes-commit');
  let env: Env;
  let label: string;
  try {
    if (envOverride) {
      env = envOverride;
      label = 'injected';
    } else if (local) {
      const s = str('source');
      const t = str('trees');
      if (!s || !t || commit !== undefined) {
        throw new UsageError('local mode needs --source and --trees, and not --hermes-commit');
      }
      const reg = str('fake-registry');
      env = localEnv(s, t, reg ? parseFakeRegistry(await readFile(reg, 'utf8')) : {});
      label = `local checkout ${s} with trees ${t}`;
    } else {
      if (!commit || !SHA_RE.test(commit)) {
        throw new UsageError('pass --hermes-commit <40-hex sha>, or --source <dir> --trees <dir>');
      }
      const repo = str('hermes-repo') as string;
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
        throw new UsageError(`--hermes-repo "${repo}" is not owner/repo`);
      if (str('fake-registry') !== undefined)
        throw new UsageError('--fake-registry is local mode only');
      env = githubEnv(repo, commit, process.env.GITHUB_TOKEN);
      label = `${repo}@${commit} (GitHub contents API)`;
    }
    const out = str('out');
    const draft = values.draft === true;
    if (!draft && !out) throw new UsageError('measure mode needs --out <file>');

    const parsed: Parsed[] = (await env.source.entryFiles()).map((f) => parseEntry(f.file, f.text));
    const invalid = parsed.flatMap((p) => (p.ok ? [] : [{ name: p.name, reason: p.reason }]));
    const results: Classified[] = [];
    const entries = parsed.flatMap((p) => (p.ok ? [p.entry] : []));
    results.push(...(await pool(entries, CONCURRENCY, (en) => classify(en, env.source))));

    if (!draft) {
      await mkdir(dirname(out as string), { recursive: true });
      await writeFile(out as string, measureReport(results, invalid, label, date));
      console.log(
        `measured ${results.length + invalid.length} entries: ${BUCKETS.map((b) => `${b}=${results.filter((r) => r.bucket === b).length}`).join(' ')} invalid=${invalid.length}; wrote ${out}`,
      );
      return 0;
    }

    const entriesDir =
      str('entries-dir') ??
      join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'catalog', 'src', 'entries');
    await stat(dirname(entriesDir));
    const drafted: Drafted[] = [];
    const skipped: NotDrafted[] = invalid.map((i) => ({ name: i.name, reason: i.reason }));
    const outcomes = await pool(results, CONCURRENCY, async (c) => {
      if (c.bucket !== 'portable-mcp' && c.bucket !== 'portable-skills') {
        return {
          drafted: [],
          skipped: [{ name: c.entry.name, reason: `${c.bucket}: ${c.reason}` }],
        };
      }
      try {
        return await draftEntry(c, env, entriesDir);
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        return {
          drafted: [],
          skipped: [{ name: c.entry.name, reason: `pin failed: ${errMsg(err)}` }],
        };
      }
    });
    for (const o of outcomes) {
      drafted.push(...o.drafted);
      skipped.push(...o.skipped);
    }
    const report = draftReport(drafted, skipped);
    if (out) {
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, report);
    }
    console.log(report);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`usage error: ${err.message}`);
      return 2;
    }
    console.error(errMsg(err));
    return 1;
  }
}

const invoked =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(errMsg(err));
      process.exit(1);
    },
  );
}
