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

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { canParse as canParseHermes } from '../extensions/skills/src/dialects/hermes';
import { type Drafted, draftEntry, draftReport, type NotDrafted } from './hermes-import/draft';
import { githubEnv, localEnv } from './hermes-import/env';
import {
  BUCKETS,
  type Bucket,
  type Classified,
  CONCURRENCY,
  type Env,
  frontmatter,
  type HermesEntry,
  type HermesSource,
  isObj,
  type McpServerPlan,
  pool,
  RateLimitError,
  type Resolved,
  SLUG_RE,
  safe,
  UsageError,
} from './hermes-import/types';

// Public names stay importable from this module.
export * from './hermes-import/draft';
export * from './hermes-import/env';
export * from './hermes-import/types';

// ---------------------------------------------------------------------------
// Entry parsing and validation (names come from untrusted YAML)
// ---------------------------------------------------------------------------

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
