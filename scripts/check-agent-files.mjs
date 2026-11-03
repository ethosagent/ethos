#!/usr/bin/env node
// Gate for the always-loaded agent context: CLAUDE.md / AGENTS.md twin and size, path-scoped
// .claude/rules/ files, and .agents/skills/ size. Usage: node scripts/check-agent-files.mjs
// [--root <dir>] [--no-allowances]. Exit 0 clean, 1 on violations (stderr, one per line).
// ALLOWANCES lists known, ceiling-pinned overages; --no-allowances reports them as violations.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { findRulesFence } from './lib/rules-fence.mjs';

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 ? (args[rootIdx + 1] ?? '.') : '.';
const noAllowances = args.includes('--no-allowances');

const MAX_SKILL_DESC = 250;
const CLAUDE = 'CLAUDE.md';
const AGENTS = 'AGENTS.md';
const RULES_DIR = '.claude/rules';
const SKILLS_DIR = '.agents/skills';

const ARCH = 'ARCHITECTURE.md';
const ADR_DIR = 'docs/decisions';
const ADR_INDEX = `${ADR_DIR}/README.md`;

// rule -> path -> { max, why }. An allowed overage prints `(allowed ...)` on stdout and does not
// fail; one past `max` fails, so an allowance only shrinks. Delete the entry when it is paid off.
const ARCH_WHY = 'frozen §I/§V/§VI plus §III enforcer lines';
const ALLOWANCES = {
  // Measured 2026-11-03 after the Clarifying pass (rationale and extension patterns moved to
  // docs/decisions/): 518 prose lines, 27,957 prose chars. §I (36 lines), §V (101) and §VI (32) are
  // frozen (Constitutional / Structural class) and the §III enforcer lines must stay (CLAUDE.md
  // rule 12), so relocation alone cannot reach 300 lines / 20,000 chars.
  // plan/architecture-structural-rfc.md proposes the Structural amendment that moves §V's per-rule
  // rationale to ADRs. Lower these ceilings as it lands; delete the entries at 300 / 20,000.
  'arch-lines': { [ARCH]: { max: 518, why: ARCH_WHY } },
  'arch-tokens': { [ARCH]: { max: 27_957, why: ARCH_WHY } },
};

const violations = [];
const allowed = [];
const cache = new Map();

function flag(rule, path, detail) {
  violations.push({ rule, path, detail });
}

function lineCount(text) {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

// Each file is read (and counted) once, however many rules look at it.
function read(rel) {
  if (!cache.has(rel)) cache.set(rel, readFileSync(join(root, rel)));
  return cache.get(rel);
}

const readText = (rel) => read(rel).toString('utf8');

function walk(rel, match) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const childRel = join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(childRel, match));
    else if (match(e.name)) out.push(childRel);
  }
  return out;
}

// Frontmatter as { data, raw, error }; no block gives empty data, invalid YAML sets `error`
// (first line of the parser message) so callers can report it instead of passing silently.
function parseFm(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { data: {}, raw: '' };
  try {
    const data = parse(m[1]);
    return { data: data && typeof data === 'object' ? data : {}, raw: m[1] };
  } catch (e) {
    return { data: {}, raw: m[1], error: String(e.message).split('\n')[0] };
  }
}

const unparseable = (fm) => `frontmatter does not parse as YAML: ${fm.error}`;

const isMd = (name) => name.endsWith('.md');
const ruleFiles = () => walk(RULES_DIR, isMd);
const skillDirs = () =>
  existsSync(join(root, SKILLS_DIR))
    ? readdirSync(join(root, SKILLS_DIR), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(SKILLS_DIR, e.name))
    : [];
const skillFiles = () =>
  skillDirs()
    .map((d) => join(d, 'SKILL.md'))
    .filter((rel) => existsSync(join(root, rel)));
const skillRefs = () => skillDirs().flatMap((d) => walk(join(d, 'references'), isMd));

const lines = (text) => lineCount(text);
const chars = (text) => text.length;

// ARCHITECTURE.md prose: the file minus the rules fence's header and body (located via the shared
// findRulesFence — the §IX parser contract, the same one scripts/check-architecture.mjs enforces;
// the ```yaml and ``` delimiter lines stay) and minus the lines between the archcheck rules-table
// markers (emitted by `archcheck emit`).
function archProse(text) {
  let body = text;
  const fence = findRulesFence(text);
  if (fence) {
    const start = fence.index + '```yaml\n'.length;
    const end = fence.index + fence[0].length - 3; // before the closing ```
    body = body.slice(0, start) + body.slice(end);
  }
  const out = [];
  let table = false; // inside the archcheck rules table
  for (const line of body.split('\n')) {
    if (table) {
      if (line.includes('<!-- archcheck:end rules-table -->')) {
        table = false;
        out.push(line);
      }
      continue;
    }
    if (line.includes('<!-- archcheck:begin rules-table -->')) table = true;
    out.push(line);
  }
  return out.join('\n');
}

// existsSync is false for a dangling symlink, so a CLAUDE.md whose target is gone counts as missing.
function checkTwin() {
  const missing = [CLAUDE, AGENTS].filter((f) => !existsSync(join(root, f)));
  for (const f of missing) {
    flag('twin', f, 'missing; CLAUDE.md and AGENTS.md must both exist and be byte-identical');
  }
  if (missing.length > 0) return;
  const claude = read(CLAUDE);
  const agents = read(AGENTS);
  if (claude.equals(agents)) return;
  const a = claude.toString('utf8').split('\n');
  const b = agents.toString('utf8').split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  flag('twin', AGENTS, `differs from CLAUDE.md at line ${i + 1}`);
}

function checkRulePaths() {
  for (const rel of ruleFiles()) {
    const fm = parseFm(readText(rel));
    if (fm.error) flag('rule-paths', rel, unparseable(fm));
    else if (fm.data.paths == null) {
      flag('rule-paths', rel, 'no paths: frontmatter (would load on every session)');
    }
  }
}

function checkSkillDesc(fm, rel) {
  if (fm.error) return flag('skill-desc', rel, unparseable(fm));
  const desc = fm.data.description;
  if (typeof desc !== 'string' || desc.trim() === '')
    return flag('skill-desc', rel, 'missing description');
  const trimmed = desc.trim();
  const problems = [];
  if (/^description:\s*[|>]/m.test(fm.raw) || trimmed.includes('\n')) {
    problems.push('spans more than one line');
  }
  if (trimmed.length > MAX_SKILL_DESC) {
    problems.push(`${trimmed.length} chars (max ${MAX_SKILL_DESC})`);
  }
  if (problems.length > 0) flag('skill-desc', rel, `description ${problems.join(', ')}`);
}

const ifExists = (rel) => (existsSync(join(root, rel)) ? [rel] : []);
const archFiles = () => ifExists(ARCH);
const adrFiles = () => walk(ADR_DIR, (name) => isMd(name) && name !== 'README.md');
const adrIndexFiles = () => ifExists(ADR_INDEX);
const claudeFiles = () => ifExists(CLAUDE);

// Size rules as data: add a row to add a rule. `files` finds paths, `measure` sizes the text.
const LIMITS = {
  'claude-lines': {
    files: claudeFiles,
    measure: lines,
    max: 150,
    unit: 'lines',
  },
  // 2.5K tokens at chars/4
  'claude-tokens': {
    files: claudeFiles,
    measure: chars,
    max: 10_000,
    unit: 'chars',
  },
  'rule-lines': { files: ruleFiles, measure: lines, max: 60, unit: 'lines' },
  'skill-lines': { files: skillFiles, measure: lines, max: 300, unit: 'lines' },
  'skill-ref-lines': { files: skillRefs, measure: lines, max: 200, unit: 'lines' },
  'arch-lines': {
    files: archFiles,
    measure: (text) => lines(archProse(text)),
    max: 300,
    unit: 'prose lines',
  },
  // 5K tokens at chars/4
  'arch-tokens': {
    files: archFiles,
    measure: (text) => chars(archProse(text)),
    max: 20_000,
    unit: 'prose chars',
  },
  'adr-lines': { files: adrFiles, measure: lines, max: 120, unit: 'lines' },
  'adr-index-lines': { files: adrIndexFiles, measure: lines, max: 150, unit: 'lines' },
};

function checkLimit(id) {
  const { files, measure, max, unit } = LIMITS[id];
  for (const rel of files()) {
    const n = measure(readText(rel));
    if (n <= max) continue;
    const detail = `${n} ${unit} (max ${max})`;
    const allowance = noAllowances ? undefined : ALLOWANCES[id]?.[rel];
    if (allowance && n <= allowance.max) {
      allowed.push({
        rule: id,
        path: rel,
        detail: `${detail} (allowed up to ${allowance.max}: ${allowance.why})`,
      });
    } else {
      flag(id, rel, allowance ? `${detail}, past its allowance of ${allowance.max}` : detail);
    }
  }
}

// Every ADR must be named in the index; a missing index fails once for the first ADR.
function checkAdrIndex() {
  const adrs = adrFiles();
  if (adrs.length === 0) return;
  if (adrIndexFiles().length === 0) {
    return flag(
      'adr-index-missing',
      ADR_INDEX,
      `missing; ${adrs.length} ADR file(s) are unindexed`,
    );
  }
  const index = readText(ADR_INDEX);
  for (const rel of adrs) {
    const name = rel.slice(ADR_DIR.length + 1);
    if (!index.includes(name)) flag('adr-index-missing', rel, `not listed in ${ADR_INDEX}`);
  }
}

const checkSkillDescs = () => {
  for (const rel of skillFiles()) checkSkillDesc(parseFm(readText(rel)), rel);
};

// Run in this order; output is then grouped by file area (see `area`), stable within it.
const CHECKS = [
  checkTwin,
  () => checkLimit('claude-lines'),
  () => checkLimit('claude-tokens'),
  () => checkLimit('rule-lines'),
  checkRulePaths,
  () => checkLimit('skill-lines'),
  checkSkillDescs,
  () => checkLimit('skill-ref-lines'),
  () => checkLimit('arch-lines'),
  () => checkLimit('arch-tokens'),
  () => checkLimit('adr-lines'),
  () => checkLimit('adr-index-lines'),
  checkAdrIndex,
];
for (const check of CHECKS) check();

// findIndex is -1 → area 0 (everything else); prefixes are disjoint, so 0/1/2/3 is unambiguous.
const AREAS = [RULES_DIR, SKILLS_DIR, ADR_DIR];
const area = (path) => AREAS.findIndex((d) => path.startsWith(d)) + 1;
violations.sort(
  (a, b) => area(a.path) - area(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
);

for (const v of violations) console.error(`AGENT-FILES ${v.rule} ${v.path}: ${v.detail}`);
for (const v of allowed) console.log(`AGENT-FILES ${v.rule} ${v.path}: ${v.detail}`);
if (violations.length > 0) process.exit(1);
console.log(`agent-files: ${cache.size} files checked`);
