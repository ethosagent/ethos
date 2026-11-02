#!/usr/bin/env node
// Gate for the always-loaded agent context: CLAUDE.md / AGENTS.md twin and size, path-scoped
// .claude/rules/ files, and .agents/skills/ size. Usage: node scripts/check-agent-files.mjs
// [--root <dir>] [--no-allowances]. Exit 0 clean, 1 on violations (stderr, one per line).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 ? (args[rootIdx + 1] ?? '.') : '.';
const noAllowances = args.includes('--no-allowances');

const MAX_CLAUDE_LINES = 150;
const MAX_CLAUDE_CHARS = 10_000; // 2.5K tokens at chars/4
const MAX_RULE_LINES = 60;
const MAX_SKILL_LINES = 300;
const MAX_SKILL_DESC = 250;
const MAX_SKILL_REF_LINES = 200;

// Rules downgraded to a warning until the task that fixes them lands.
const ALLOWANCES = noAllowances
  ? new Set()
  : new Set([
      'claude-lines', // removed by context-budget-1 T3
      'claude-tokens', // removed by context-budget-1 T3
      'skill-lines', // removed by context-budget-1 T7
      'skill-desc', // removed by context-budget-1 T7
    ]);

const violations = [];
let checked = 0;

function flag(rule, path, detail) {
  violations.push({ rule, path, detail });
}

function lineCount(text) {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

function read(rel) {
  checked++;
  return readFileSync(join(root, rel));
}

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

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1] : null;
}

// Twin + CLAUDE.md size. Compares bytes read through the paths, so a symlink passes.
const claudeRel = 'CLAUDE.md';
const agentsRel = 'AGENTS.md';
if (existsSync(join(root, claudeRel)) && existsSync(join(root, agentsRel))) {
  const claude = read(claudeRel);
  const agents = read(agentsRel);
  if (!claude.equals(agents)) {
    const a = claude.toString('utf8').split('\n');
    const b = agents.toString('utf8').split('\n');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    flag('twin', agentsRel, `differs from CLAUDE.md at line ${i + 1}`);
  }
  const text = claude.toString('utf8');
  const n = lineCount(text);
  if (n > MAX_CLAUDE_LINES) flag('claude-lines', claudeRel, `${n} lines (max ${MAX_CLAUDE_LINES})`);
  if (text.length > MAX_CLAUDE_CHARS) {
    flag('claude-tokens', claudeRel, `${text.length} chars (max ${MAX_CLAUDE_CHARS})`);
  }
}

// .claude/rules/**/*.md
for (const rel of walk('.claude/rules', (n) => n.endsWith('.md'))) {
  const text = read(rel).toString('utf8');
  const n = lineCount(text);
  if (n > MAX_RULE_LINES) flag('rule-lines', rel, `${n} lines (max ${MAX_RULE_LINES})`);
  const fm = frontmatter(text);
  let hasPaths = false;
  if (fm !== null) {
    try {
      const data = parse(fm);
      hasPaths = data?.paths != null;
    } catch {
      hasPaths = false;
    }
  }
  if (!hasPaths) flag('rule-paths', rel, 'no paths: frontmatter (would load on every session)');
}

// .agents/skills/*/SKILL.md and references/*.md
const skillsDir = '.agents/skills';
if (existsSync(join(root, skillsDir))) {
  for (const e of readdirSync(join(root, skillsDir), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const skillRel = join(skillsDir, e.name, 'SKILL.md');
    if (existsSync(join(root, skillRel))) {
      const text = read(skillRel).toString('utf8');
      const n = lineCount(text);
      if (n > MAX_SKILL_LINES) flag('skill-lines', skillRel, `${n} lines (max ${MAX_SKILL_LINES})`);
      const fm = frontmatter(text);
      if (fm !== null) {
        let desc;
        try {
          desc = parse(fm)?.description;
        } catch {
          desc = undefined;
        }
        if (typeof desc === 'string') {
          const rawBlock = /^description:\s*[|>]/m.test(fm);
          const trimmed = desc.trim();
          const problems = [];
          if (rawBlock || trimmed.includes('\n')) problems.push('spans more than one line');
          if (trimmed.length > MAX_SKILL_DESC) {
            problems.push(`${trimmed.length} chars (max ${MAX_SKILL_DESC})`);
          }
          if (problems.length > 0)
            flag('skill-desc', skillRel, `description ${problems.join(', ')}`);
        }
      }
    }
    for (const ref of walk(join(skillsDir, e.name, 'references'), (n) => n.endsWith('.md'))) {
      const n = lineCount(read(ref).toString('utf8'));
      if (n > MAX_SKILL_REF_LINES) {
        flag('skill-ref-lines', ref, `${n} lines (max ${MAX_SKILL_REF_LINES})`);
      }
    }
  }
}

let failed = 0;
for (const v of violations) {
  const path = v.path;
  if (ALLOWANCES.has(v.rule)) {
    console.error(`AGENT-FILES (allowed) ${v.rule} ${path}: ${v.detail}`);
  } else {
    failed++;
    console.error(`AGENT-FILES ${v.rule} ${path}: ${v.detail}`);
  }
}
if (failed > 0) process.exit(1);
console.log(`agent-files: ${checked} files checked`);
