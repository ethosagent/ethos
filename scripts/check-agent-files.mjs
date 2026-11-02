#!/usr/bin/env node
// Gate for the always-loaded agent context: CLAUDE.md / AGENTS.md twin and size, path-scoped
// .claude/rules/ files, and .agents/skills/ size. Usage: node scripts/check-agent-files.mjs
// [--root <dir>]. Exit 0 clean, 1 on violations (stderr, one per line).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 ? (args[rootIdx + 1] ?? '.') : '.';

const MAX_SKILL_DESC = 250;
const CLAUDE = 'CLAUDE.md';
const AGENTS = 'AGENTS.md';
const RULES_DIR = '.claude/rules';
const SKILLS_DIR = '.agents/skills';

const violations = [];
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

// Frontmatter as { data, raw }; no block or invalid YAML gives { data: {}, raw: '' }.
function parseFm(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { data: {}, raw: '' };
  try {
    const data = parse(m[1]);
    return { data: data && typeof data === 'object' ? data : {}, raw: m[1] };
  } catch {
    return { data: {}, raw: '' };
  }
}

const isMd = (name) => name.endsWith('.md');
const hasTwin = () => existsSync(join(root, CLAUDE)) && existsSync(join(root, AGENTS));
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

function checkTwin() {
  if (!hasTwin()) return;
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
    if (parseFm(readText(rel)).data.paths == null) {
      flag('rule-paths', rel, 'no paths: frontmatter (would load on every session)');
    }
  }
}

function checkSkillDesc(fm, rel) {
  const desc = fm.data.description;
  if (typeof desc !== 'string') return;
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

// Size rules as data: add a row to add a rule. `files` finds paths, `measure` sizes the text.
const LIMITS = {
  'claude-lines': {
    files: () => (hasTwin() ? [CLAUDE] : []),
    measure: lines,
    max: 150,
    unit: 'lines',
  },
  // 2.5K tokens at chars/4
  'claude-tokens': {
    files: () => (hasTwin() ? [CLAUDE] : []),
    measure: chars,
    max: 10_000,
    unit: 'chars',
  },
  'rule-lines': { files: ruleFiles, measure: lines, max: 60, unit: 'lines' },
  'skill-lines': { files: skillFiles, measure: lines, max: 300, unit: 'lines' },
  'skill-ref-lines': { files: skillRefs, measure: lines, max: 200, unit: 'lines' },
};

function checkLimit(id) {
  const { files, measure, max, unit } = LIMITS[id];
  for (const rel of files()) {
    const n = measure(readText(rel));
    if (n > max) flag(id, rel, `${n} ${unit} (max ${max})`);
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
];
for (const check of CHECKS) check();

const area = (path) => (path.startsWith(RULES_DIR) ? 1 : path.startsWith(SKILLS_DIR) ? 2 : 0);
violations.sort(
  (a, b) => area(a.path) - area(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
);

for (const v of violations) console.error(`AGENT-FILES ${v.rule} ${v.path}: ${v.detail}`);
if (violations.length > 0) process.exit(1);
console.log(`agent-files: ${cache.size} files checked`);
