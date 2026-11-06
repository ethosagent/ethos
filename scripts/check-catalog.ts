// Catalog admission checks (plan/phases/unified-catalog.md section 7.2).
//
//   pnpm tsx scripts/check-catalog.ts --changed   entries touched vs origin/main (or main)
//   pnpm tsx scripts/check-catalog.ts --all       every entry (the weekly drift run)
//
// Facts that can rot (digests, reachability, advisories, licences) are checked
// here, not in `pnpm test` (D20). Every external call goes through the injected
// `Runner`, so scripts/__tests__/check-catalog.test.ts stubs them all. Exit 1 on
// any failed check; a staleness warning (reviewedAt older than 365 days) and a
// skipped check never fail. This file is outside tsconfig's `include` except
// through the test that imports it, and outside archcheck's `l10-silent-libraries`
// scope (packages/** and extensions/** only), so `console` is allowed here.

import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CATALOG_ENTRIES } from '@ethosagent/catalog';
import {
  computeIntegrity,
  DEFAULT_REGISTRY,
  execNpm,
  GitPinFetchError,
  GitPinInputError,
  GitPinMismatchError,
  GitPinRefusedError,
  readPluginPermissions,
  withGitPinnedTree,
  withPackedTarball,
} from '@ethosagent/plugin-loader';
import {
  type PluginScanPermissions,
  scanPluginCode,
  scanSkillMd,
} from '@ethosagent/safety-scanner';
import { blockingAdvisories, checkOsvVulnerabilities } from '@ethosagent/tools-mcp/osv-check';
import type { CatalogEntry, CatalogPin } from '@ethosagent/types';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Runner: the only way this file touches the outside world
// ---------------------------------------------------------------------------

export interface PackedPackage {
  /** npm SRI (`sha512-...`) of the packed .tgz, computed before anything was extracted. */
  integrity: string;
  /** The parsed package.json of the packed tarball. */
  pkgJson: unknown;
  /** Every .js/.ts/.cjs/.mjs source (node_modules and .d.ts excluded), path relative to the package root. */
  sources: Array<{ path: string; content: string }>;
}

/** What fetching a git pin yielded (`Runner.gitTree`); the fetch itself is `withGitPinnedTree`. */
export interface GitTreeResult {
  /** `ok`: fetched and the digest matched. The others are `withGitPinnedTree`'s typed refusals. */
  outcome: 'ok' | 'mismatch' | 'fetch-failed' | 'refused' | 'invalid';
  detail: string;
  /** The tree's real digest, set for `mismatch`. */
  actualDigest?: string;
  /** Text of the SKILL.md nearest the root, or null when there is none. */
  skillMd: { path: string; content: string } | null;
  /** Every .js/.ts/.cjs/.mjs source (.d.ts excluded), path relative to the pinned directory. */
  sources: Array<{ path: string; content: string }>;
  /** Text of the first LICENSE* file in the pinned directory, or null. */
  license: string | null;
}

export interface Runner {
  /** stdout of `npm <args>`. Rejects on a non-zero exit. */
  npm(args: string[]): Promise<string>;
  /** stdout of `git <args>`. Rejects on a non-zero exit. */
  git(args: string[]): Promise<string>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Fetch a git pin and read what the admission checks need (never executes it). */
  gitTree(pin: Extract<CatalogPin, { type: 'git' }>): Promise<GitTreeResult>;
  osv: typeof checkOsvVulnerabilities;
  /**
   * `npm pack` the exact version, hash the .tgz, and unpack it only when the hash
   * equals `expectedIntegrity` (otherwise `pkgJson` is null and `sources` empty).
   */
  packNpm(pkg: string, version: string, expectedIntegrity: string): Promise<PackedPackage>;
  now(): Date;
}

const SOURCE_FILE = /\.[jt]sx?$|\.(?:cjs|mjs)$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const NETWORK_TIMEOUT_MS = 20_000;

async function collectSources(
  dir: string,
  root: string,
  out: Array<{ path: string; content: string }>,
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') await collectSources(full, root, out);
    } else if (SOURCE_FILE.test(entry.name) && !DECLARATION_FILE.test(entry.name)) {
      out.push({ path: relative(root, full), content: await readFile(full, 'utf8') });
    }
  }
}

export const realRunner: Runner = {
  async npm(args) {
    const { stdout } = await execFileAsync('npm', args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    return stdout;
  },
  async git(args) {
    const { stdout } = await execFileAsync('git', args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  },
  fetch: (url, init) =>
    fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(NETWORK_TIMEOUT_MS) }),
  async gitTree(pin) {
    const empty = { skillMd: null, sources: [], license: null };
    try {
      return await withGitPinnedTree(pin, async (dir, files) => {
        const read = (rel: string) => readFile(join(dir, rel), 'utf8');
        const skills = files
          .map((f) => f.path)
          .filter((p) => p === 'SKILL.md' || p.endsWith('/SKILL.md'))
          .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
        const sources: Array<{ path: string; content: string }> = [];
        for (const f of files) {
          if (SOURCE_FILE.test(f.path) && !DECLARATION_FILE.test(f.path)) {
            sources.push({ path: f.path, content: await read(f.path) });
          }
        }
        const licensePath = files.map((f) => f.path).find((p) => /^LICEN[CS]E(\.\w+)?$/i.test(p));
        const first = skills[0];
        return {
          outcome: 'ok' as const,
          detail: 'fetched; digest matches',
          skillMd: first === undefined ? null : { path: first, content: await read(first) },
          sources,
          license: licensePath === undefined ? null : await read(licensePath),
        };
      });
    } catch (err) {
      const detail = errMsg(err);
      if (err instanceof GitPinMismatchError)
        return { ...empty, outcome: 'mismatch', detail, actualDigest: err.actual };
      if (err instanceof GitPinFetchError) return { ...empty, outcome: 'fetch-failed', detail };
      if (err instanceof GitPinRefusedError) return { ...empty, outcome: 'refused', detail };
      if (err instanceof GitPinInputError) return { ...empty, outcome: 'invalid', detail };
      throw err;
    }
  },
  osv: (name, options) =>
    checkOsvVulnerabilities(name, { timeoutMs: NETWORK_TIMEOUT_MS, ...options }),
  // withPackedTarball validates the name and exact version, packs with
  // --ignore-scripts into an os.tmpdir() scratch dir and removes it afterwards.
  packNpm: (pkg, version, expectedIntegrity) =>
    withPackedTarball(pkg, version, DEFAULT_REGISTRY, execNpm, async (tgz) => {
      const integrity = await computeIntegrity(tgz);
      if (integrity !== expectedIntegrity) return { integrity, pkgJson: null, sources: [] };
      const unpacked = join(dirname(tgz), 'unpacked');
      await mkdir(unpacked);
      // Nothing downloaded is executed; tar only extracts into the scratch dir.
      await execFileAsync('tar', ['-xzf', tgz, '-C', unpacked]);
      const root = join(unpacked, 'package');
      const pkgJson: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      const sources: Array<{ path: string; content: string }> = [];
      await collectSources(root, root, sources);
      return { integrity, pkgJson, sources };
    }),
  now: () => new Date(),
};

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';
export interface CheckResult {
  check: string;
  status: CheckStatus;
  detail: string;
}
export interface EntryReport {
  id: string;
  kind: string;
  results: CheckResult[];
}

const ok = (check: string, detail: string): CheckResult => ({ check, status: 'pass', detail });
const bad = (check: string, detail: string): CheckResult => ({ check, status: 'fail', detail });
const warn = (check: string, detail: string): CheckResult => ({ check, status: 'warn', detail });
const skip = (check: string, detail: string): CheckResult => ({ check, status: 'skip', detail });

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Licence mechanism
// ---------------------------------------------------------------------------

/**
 * Some upstream packages publish `license: "SEE LICENSE IN LICENSE"` and ship no
 * LICENSE file in the tarball, so the registry field cannot equal an SPDX id.
 * For exactly those entries a reviewer read the licence in the upstream repo and
 * recorded it in the entry's header comment (packages/catalog/src/entries/mcp/
 * filesystem.ts and memory.ts). This map is the explicit allowance: the entry
 * passes only when the registry still reports exactly the recorded string, so a
 * changed field fails and goes back to a human. It lives here, not on the
 * entry, because CatalogEntry is a frozen contract (packages/types/src/catalog.ts).
 * Pinned by scripts/__tests__/check-catalog.test.ts ("licence").
 */
export const LICENSE_FIELD_ALLOWANCES: Readonly<Record<string, string>> = {
  filesystem: 'SEE LICENSE IN LICENSE',
  memory: 'SEE LICENSE IN LICENSE',
};

/** PyPI trove classifier to SPDX, for the unambiguous ones only. */
const CLASSIFIER_SPDX: Readonly<Record<string, string>> = {
  'License :: OSI Approved :: MIT License': 'MIT',
  'License :: OSI Approved :: Apache Software License': 'Apache-2.0',
  'License :: OSI Approved :: ISC License (ISCL)': 'ISC',
  'License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)': 'MPL-2.0',
};

// ---------------------------------------------------------------------------
// Pin resolution (+ licence for the registry-backed pins)
// ---------------------------------------------------------------------------

type PinOf<T extends CatalogPin['type']> = CatalogEntry & { pin: Extract<CatalogPin, { type: T }> };
type NpmEntry = PinOf<'npm'>;
type PypiEntry = PinOf<'pypi'>;
type RemoteEntry = PinOf<'remote'>;

function hasPin<T extends CatalogPin['type']>(e: CatalogEntry, type: T): e is PinOf<T> {
  return e.pin.type === type;
}

async function checkNpmPin(e: NpmEntry, r: Runner): Promise<CheckResult[]> {
  const spec = `${e.pin.package}@${e.pin.version}`;
  let view: { integrity?: string; license?: string };
  try {
    const raw = (await r.npm(['view', spec, 'dist.integrity', 'license', '--json'])).trim();
    if (raw === '') return [bad('pin', `${spec} is not published`)];
    const parsed: unknown = JSON.parse(raw);
    // npm prints a bare string when one field is requested and an object for several.
    const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
      string,
      unknown
    >;
    view = {
      integrity: typeof o['dist.integrity'] === 'string' ? o['dist.integrity'] : undefined,
      license: typeof o.license === 'string' ? o.license : undefined,
    };
  } catch (err) {
    return [bad('pin', `npm view ${spec} failed: ${errMsg(err)}`)];
  }
  const out: CheckResult[] = [];
  if (view.integrity === undefined)
    out.push(bad('pin', `${spec} is not published (no dist.integrity)`));
  else if (view.integrity !== e.pin.integrity)
    out.push(
      bad(
        'pin',
        `integrity mismatch for ${spec}: registry ${view.integrity}, entry ${e.pin.integrity}`,
      ),
    );
  else out.push(ok('pin', `${spec} integrity matches`));

  const field = view.license;
  const allowance = LICENSE_FIELD_ALLOWANCES[e.id];
  if (e.license === null) out.push(bad('licence', 'an npm entry must have a licence (D6)'));
  else if (field === e.license) out.push(ok('licence', `registry licence ${field}`));
  else if (allowance !== undefined && field === allowance)
    out.push(
      ok('licence', `registry says "${field}"; entry ${e.license} read from upstream (allowance)`),
    );
  else
    out.push(
      bad('licence', `registry licence ${field ?? '(none)'} does not equal entry ${e.license}`),
    );
  return out;
}

interface PypiJson {
  info?: { license?: string | null; license_expression?: string | null; classifiers?: string[] };
  urls?: Array<{ digests?: { sha256?: string } }>;
}

async function checkPypiPin(e: PypiEntry, r: Runner): Promise<CheckResult[]> {
  const url = `https://pypi.org/pypi/${encodeURIComponent(e.pin.package)}/${encodeURIComponent(e.pin.version)}/json`;
  let body: PypiJson;
  try {
    const res = await r.fetch(url);
    if (!res.ok)
      return [bad('pin', `PyPI answered HTTP ${res.status} for ${e.pin.package}@${e.pin.version}`)];
    body = (await res.json()) as PypiJson; // narrowed field by field below; no API type to import
  } catch (err) {
    return [bad('pin', `PyPI lookup failed: ${errMsg(err)}`)];
  }
  const out: CheckResult[] = [];
  const want = e.pin.integrity.replace(/^sha256-/, '');
  const digests = (body.urls ?? []).map((u) => u.digests?.sha256);
  out.push(
    digests.includes(want)
      ? ok(
          'pin',
          `${e.pin.package}@${e.pin.version} has a file with sha256 ${want.slice(0, 12)}...`,
        )
      : bad('pin', `no file of ${e.pin.package}@${e.pin.version} has sha256 ${want}`),
  );
  const info = body.info ?? {};
  const seen = new Set<string>();
  if (info.license_expression) seen.add(info.license_expression);
  if (info.license) seen.add(info.license);
  for (const c of info.classifiers ?? []) {
    const spdx = CLASSIFIER_SPDX[c];
    if (spdx) seen.add(spdx);
  }
  if (e.license === null) out.push(bad('licence', 'a pypi entry must have a licence (D6)'));
  else if (seen.has(e.license)) out.push(ok('licence', `PyPI metadata names ${e.license}`));
  else
    out.push(
      bad(
        'licence',
        `PyPI metadata ${[...seen].join(', ') || '(none)'} does not name ${e.license}`,
      ),
    );
  return out;
}

// ---------------------------------------------------------------------------
// Remote pin
// ---------------------------------------------------------------------------

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'ethos-catalog-admission', version: '0.0.0' },
  },
};
const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

/** Parse a JSON-RPC reply that is either plain JSON or an SSE stream of `data:` lines. */
async function readRpc(res: Response): Promise<unknown> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload) return JSON.parse(payload);
      }
    }
    throw new Error('SSE reply carried no data line');
  }
  return JSON.parse(text);
}

async function checkRemote(e: RemoteEntry, r: Runner): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { url } = e.pin;
  const host = new URL(url).hostname;
  const net = e.capabilities.network;
  out.push(
    net.includes('*') || net.includes(host)
      ? ok('declared-vs-actual', `host ${host} is declared in capabilities.network`)
      : bad(
          'declared-vs-actual',
          `host ${host} of the url is not in capabilities.network [${net.join(', ')}]`,
        ),
  );
  if (e.license !== null) out.push(bad('licence', 'a remote entry must have license null (D6)'));

  let res: Response;
  try {
    res = await r.fetch(url, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify(INIT_BODY),
    });
  } catch (err) {
    out.push(bad('pin', `initialize POST to ${url} failed: ${errMsg(err)}`));
    return out;
  }
  const auth = e.capabilities.auth;
  if (res.status === 200) {
    if (auth === 'none') out.push(ok('pin', 'unauthenticated initialize returned 200 (auth none)'));
    else
      out.push(
        bad('pin', `unauthenticated initialize returned 200 but capabilities.auth is ${auth}`),
      );
  } else if (res.status === 401) {
    if (!res.headers.get('www-authenticate'))
      out.push(bad('pin', '401 without a WWW-Authenticate header'));
    else if (auth === 'none') out.push(bad('pin', '401 but capabilities.auth is none'));
    else out.push(ok('pin', `401 with WWW-Authenticate (auth ${auth})`));
  } else {
    out.push(bad('pin', `initialize returned HTTP ${res.status}, expected 200 or 401`));
  }

  if (res.status === 200 && auth === 'none' && e.capabilities.toolCount !== undefined) {
    out.push(await checkToolCount(e, res, r));
  } else if (e.capabilities.toolCount !== undefined) {
    out.push(skip('tool-count', 'tools/list needs a token, so toolCount cannot be re-checked'));
  }
  return out;
}

async function checkToolCount(e: RemoteEntry, initRes: Response, r: Runner): Promise<CheckResult> {
  const expected = e.capabilities.toolCount;
  try {
    await readRpc(initRes);
    const session = initRes.headers.get('mcp-session-id');
    const headers: Record<string, string> = { ...MCP_HEADERS };
    if (session) headers['Mcp-Session-Id'] = session;
    await r.fetch(e.pin.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    const res = await r.fetch(e.pin.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const reply = (await readRpc(res)) as { result?: { tools?: unknown[] } };
    const n = reply.result?.tools?.length;
    if (n === undefined) return bad('tool-count', 'tools/list reply had no result.tools');
    return n === expected
      ? ok('tool-count', `tools/list returned ${n} tools`)
      : bad('tool-count', `tools/list returned ${n} tools, entry says toolCount ${expected}`);
  } catch (err) {
    return bad('tool-count', `tools/list failed: ${errMsg(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Code scan and declared-vs-actual (npm)
// ---------------------------------------------------------------------------

/** The permissions the scan runs under: the plugin's own manifest, or the entry's capabilities for an MCP server. */
export function scanPermissions(e: CatalogEntry, pkgJson: unknown): PluginScanPermissions {
  if (e.kind === 'plugin') return readPluginPermissions(pkgJson);
  const perms: PluginScanPermissions = {};
  if (e.capabilities.shell) perms.shell = true;
  // The scanner reads `network: []` as "unrestricted" and `undefined` as "none
  // declared, flag every call", so ['*'] -> [] and [] -> left undefined.
  // Pinned by scripts/__tests__/check-catalog.test.ts ("scanPermissions").
  if (e.capabilities.network.includes('*')) perms.network = [];
  else if (e.capabilities.network.length > 0) perms.network = e.capabilities.network;
  return perms;
}

function permissionsMatchCapabilities(e: CatalogEntry, perms: PluginScanPermissions): CheckResult {
  const declared = e.capabilities;
  const problems: string[] = [];
  if (perms.network !== undefined) {
    if (perms.network.length === 0 && !declared.network.includes('*'))
      problems.push(
        'ethos.permissions.network is unrestricted but capabilities.network is not ["*"]',
      );
    else if (!declared.network.includes('*')) {
      const missing = perms.network.filter((h) => !declared.network.includes(h));
      if (missing.length > 0)
        problems.push(
          `ethos.permissions.network hosts missing from capabilities.network: ${missing.join(', ')}`,
        );
    }
  }
  if ((perms.shell === true) !== declared.shell)
    problems.push(
      `ethos.permissions.shell is ${perms.shell === true} but capabilities.shell is ${declared.shell}`,
    );
  return problems.length === 0
    ? ok(
        'declared-vs-actual',
        'ethos.permissions within capabilities (network subset, shell equal)',
      )
    : bad('declared-vs-actual', problems.join('; '));
}

async function checkNpmCode(e: NpmEntry, r: Runner): Promise<CheckResult[]> {
  const spec = `${e.pin.package}@${e.pin.version}`;
  let packed: PackedPackage;
  try {
    packed = await r.packNpm(e.pin.package, e.pin.version, e.pin.integrity);
  } catch (err) {
    return [bad('code-scan', `could not pack ${spec}: ${errMsg(err)}`)];
  }
  if (packed.integrity !== e.pin.integrity)
    return [
      bad(
        'code-scan',
        `the packed tarball of ${spec} has integrity ${packed.integrity}, not the pinned ${e.pin.integrity}; it was not scanned`,
      ),
    ];
  const out: CheckResult[] = [];
  const perms = scanPermissions(e, packed.pkgJson);
  const red: string[] = [];
  let yellow = 0;
  for (const src of packed.sources) {
    for (const f of scanPluginCode(src.content, perms).findings) {
      if (f.severity === 'red') red.push(`${src.path}:${f.line ?? 0} ${f.rule}`);
      else yellow++;
    }
  }
  out.push(
    red.length > 0
      ? bad(
          'code-scan',
          `${red.length} red finding(s): ${red.slice(0, 5).join('; ')}${red.length > 5 ? '; ...' : ''}`,
        )
      : ok(
          'code-scan',
          `${packed.sources.length} files scanned, no red findings (${yellow} yellow)`,
        ),
  );
  if (e.kind === 'plugin') out.push(permissionsMatchCapabilities(e, perms));
  else
    out.push(
      skip(
        'declared-vs-actual',
        'an MCP server real reach is not observable without a sandbox (plan section 7.4); the reviewer checklist covers it',
      ),
    );
  return out;
}

// ---------------------------------------------------------------------------
// git pins (skills): digest, scan, licence
// ---------------------------------------------------------------------------

/** True when `text` is recognisably the licence `spdx` names; only the unambiguous ones are recognised. */
function licenseTextMatches(text: string, spdx: string): boolean | null {
  if (spdx === 'MIT') return /Permission is hereby granted, free of charge/i.test(text);
  if (spdx === 'Apache-2.0') return /Apache License/i.test(text) && /Version 2\.0/i.test(text);
  return null;
}

async function checkGit(e: PinOf<'git'>, r: Runner): Promise<CheckResult[]> {
  const where = `${e.pin.repo}@${e.pin.commit.slice(0, 12)}${e.pin.subdir ? ` (${e.pin.subdir})` : ''}`;
  let tree: GitTreeResult;
  try {
    tree = await r.gitTree(e.pin);
  } catch (err) {
    return [bad('pin', `could not fetch ${where}: ${errMsg(err)}`)];
  }
  if (tree.outcome === 'mismatch')
    return [
      bad(
        'pin',
        `contentDigest mismatch for ${where}: tree ${tree.actualDigest ?? '(unknown)'}, entry ${e.pin.contentDigest}`,
      ),
    ];
  if (tree.outcome !== 'ok') return [bad('pin', `${where}: ${tree.detail}`)];

  const out: CheckResult[] = [ok('pin', `${where} fetched and contentDigest matches`)];
  // D16: a catalog skill must scan with no red and no yellow finding, the same
  // rule `installCatalogSkill` enforces at install time.
  if (tree.skillMd === null) {
    out.push(bad('code-scan', 'the pinned tree has no SKILL.md'));
  } else {
    const found = [
      ...scanSkillMd(tree.skillMd.content, tree.skillMd.path).findings.map((f) => ({
        ...f,
        file: tree.skillMd?.path ?? 'SKILL.md',
      })),
      ...tree.sources.flatMap((s) =>
        scanPluginCode(s.content).findings.map((f) => ({ ...f, file: s.path })),
      ),
    ];
    out.push(
      found.length > 0
        ? bad(
            'code-scan',
            `${found.length} finding(s), a catalog skill allows none: ${found
              .slice(0, 5)
              .map((f) => `${f.file}:${f.line ?? 0} ${f.severity}:${f.rule}`)
              .join('; ')}${found.length > 5 ? '; ...' : ''}`,
          )
        : ok('code-scan', `SKILL.md and ${tree.sources.length} source file(s): no findings`),
    );
  }
  if (e.license === null) out.push(bad('licence', 'a git entry must have a licence (D6)'));
  else if (tree.license === null)
    out.push(warn('licence', 'no LICENSE file in the pinned directory; the repo root is not read'));
  else {
    const match = licenseTextMatches(tree.license, e.license);
    out.push(
      match === true
        ? ok('licence', `LICENSE text matches ${e.license}`)
        : match === false
          ? bad('licence', `the LICENSE text does not look like ${e.license}`)
          : warn(
              'licence',
              `cannot match ${e.license} against the LICENSE text; reviewer confirms`,
            ),
    );
  }
  out.push(
    skip(
      'osv',
      'OSV coverage for an arbitrary git commit is unverified (plan section 7.2); the reviewer checks the repo advisories',
    ),
  );
  out.push(
    skip(
      'declared-vs-actual',
      'skill frontmatter required_tools and env names are not compared with capabilities yet; the reviewer checklist covers it',
    ),
  );
  return out;
}

// ---------------------------------------------------------------------------
// OSV
// ---------------------------------------------------------------------------

async function checkOsv(
  name: string,
  version: string,
  ecosystem: 'npm' | 'PyPI',
  r: Runner,
): Promise<CheckResult> {
  const res = await r.osv(name, { version, ecosystem, failClosed: true });
  if (res.error !== undefined) return bad('osv', `OSV lookup failed (fail-closed): ${res.error}`);
  const blocking = blockingAdvisories(res.advisories, { failClosed: true });
  if (!res.safe)
    return bad(
      'osv',
      `${name}@${version}: ${blocking.map((a) => `${a.id} (${a.severity})`).join(', ')}`,
    );
  return ok(
    'osv',
    `${res.advisories.length} advisory(ies) for ${name}@${version}, none HIGH/CRITICAL`,
  );
}

// ---------------------------------------------------------------------------
// Per entry
// ---------------------------------------------------------------------------

const STALE_DAYS = 365;

export async function checkEntry(e: CatalogEntry, r: Runner): Promise<EntryReport> {
  const results: CheckResult[] = [];
  if (hasPin(e, 'npm')) {
    results.push(...(await checkNpmPin(e, r)));
    results.push(...(await checkNpmCode(e, r)));
    results.push(await checkOsv(e.pin.package, e.pin.version, 'npm', r));
  } else if (hasPin(e, 'pypi')) {
    results.push(...(await checkPypiPin(e, r)));
    results.push(
      skip('code-scan', 'Python has no code scanner (D21); the reviewer reads the source'),
    );
    results.push(await checkOsv(e.pin.package, e.pin.version, 'PyPI', r));
  } else if (hasPin(e, 'remote')) {
    results.push(...(await checkRemote(e, r)));
  } else if (hasPin(e, 'git')) {
    results.push(...(await checkGit(e, r)));
  }

  const age = (r.now().getTime() - Date.parse(e.reviewedAt)) / 86_400_000;
  if (Number.isNaN(age)) results.push(bad('staleness', `reviewedAt ${e.reviewedAt} is not a date`));
  else if (age > STALE_DAYS)
    results.push(
      warn('staleness', `reviewed ${Math.floor(age)} days ago (${e.reviewedAt}); re-review`),
    );
  return { id: e.id, kind: e.kind, results };
}

// ---------------------------------------------------------------------------
// Selecting entries
// ---------------------------------------------------------------------------

export const ENTRIES_PATH = 'packages/catalog/src/entries';

/** The merge base to diff against: origin/main, or main when origin/main is absent. */
export async function resolveBase(r: Runner): Promise<string> {
  try {
    await r.git(['rev-parse', '--verify', '--quiet', 'origin/main']);
    return 'origin/main';
  } catch {
    return 'main';
  }
}

/** Entries whose file under packages/catalog/src/entries/<kind>/<id>.ts changed vs the base. */
export async function selectChanged(
  r: Runner,
  entries: readonly CatalogEntry[] = CATALOG_ENTRIES,
): Promise<CatalogEntry[]> {
  const base = await resolveBase(r);
  const names = (await r.git(['diff', '--name-only', base, '--', ENTRIES_PATH]))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const touched = new Set(names);
  return entries.filter((e) => touched.has(`${ENTRIES_PATH}/${e.kind}/${e.id}.ts`));
}

const CONCURRENCY = 4;

export async function runChecks(
  entries: readonly CatalogEntry[],
  r: Runner,
): Promise<EntryReport[]> {
  // At most CONCURRENCY entries in flight; the report is sorted by id so the
  // output does not depend on which finished first.
  const reports: EntryReport[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < entries.length) {
      const e = entries[next++];
      if (e !== undefined) reports.push(await checkEntry(e, r));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  return reports.sort((a, b) => a.id.localeCompare(b.id));
}

export function formatReport(reports: readonly EntryReport[]): string {
  const lines: string[] = [];
  for (const rep of reports) {
    lines.push(`${rep.kind}/${rep.id}`);
    for (const c of rep.results)
      lines.push(`  ${c.status.toUpperCase().padEnd(4)} ${c.check}: ${c.detail}`);
  }
  const all = reports.flatMap((r) => r.results);
  const count = (s: CheckStatus) => all.filter((c) => c.status === s).length;
  lines.push(
    `${reports.length} entries: ${count('pass')} passed, ${count('fail')} failed, ${count('warn')} warnings, ${count('skip')} skipped`,
  );
  return lines.join('\n');
}

export function hasFailure(reports: readonly EntryReport[]): boolean {
  return reports.some((r) => r.results.some((c) => c.status === 'fail'));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(
  argv: readonly string[],
  r: Runner = realRunner,
  catalog: readonly CatalogEntry[] = CATALOG_ENTRIES,
): Promise<number> {
  const all = argv.includes('--all');
  const changed = argv.includes('--changed');
  if (all === changed) {
    console.error('usage: pnpm tsx scripts/check-catalog.ts --changed | --all');
    return 2;
  }
  const entries = all ? catalog : await selectChanged(r, catalog);
  if (entries.length === 0) {
    console.log('No catalog entries changed; nothing to check.');
    return 0;
  }
  const reports = await runChecks(entries, r);
  console.log(formatReport(reports));
  return hasFailure(reports) ? 1 : 0;
}

const invoked =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(errMsg(err));
      process.exit(2);
    },
  );
}
