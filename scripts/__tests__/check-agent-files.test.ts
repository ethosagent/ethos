import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'check-agent-files.mjs');
const dirs: string[] = [];

function lines(n: number, width = 10): string {
  return `${Array.from({ length: n }, () => 'x'.repeat(width)).join('\n')}\n`;
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-files-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function run(dir: string, allowances = false) {
  const args = [SCRIPT, '--root', dir];
  if (!allowances) args.push('--no-allowances');
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

function skill(totalLines: number, description: string): string {
  const head = `---\nname: demo\ndescription: ${description}\n---\n`;
  const body = Array.from({ length: totalLines - 4 }, () => 'body').join('\n');
  return `${head}${body}\n`;
}

const rule = (n: number) => `---\npaths:\n  - 'src/**'\n---\n${lines(n - 4)}`;
const claude150 = lines(150);

function clean(): Record<string, string> {
  return {
    'CLAUDE.md': claude150,
    'AGENTS.md': claude150,
    '.claude/rules/a.md': rule(60),
    '.agents/skills/demo/SKILL.md': skill(300, 'd'.repeat(250)),
  };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('check-agent-files', () => {
  it('clean fixture passes', () => {
    const r = run(fixture(clean()));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('agent-files:');
  });

  it('twin differs by trailing newline', () => {
    const r = run(fixture({ ...clean(), 'AGENTS.md': claude150.slice(0, -1) }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('AGENT-FILES twin AGENTS.md');
  });

  it('symlinked twin passes', () => {
    const files = clean();
    delete (files as Record<string, string>)['CLAUDE.md'];
    const dir = fixture(files);
    symlinkSync('AGENTS.md', join(dir, 'CLAUDE.md'));
    const r = run(dir);
    expect(r.stderr).not.toContain('twin');
    expect(r.status).toBe(0);
  });

  it('151-line CLAUDE.md fails', () => {
    const c = lines(151);
    const r = run(fixture({ ...clean(), 'CLAUDE.md': c, 'AGENTS.md': c }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('claude-lines');
  });

  it('10,001-char CLAUDE.md fails', () => {
    const c = `${'x'.repeat(10_000)}\n`;
    const r = run(fixture({ ...clean(), 'CLAUDE.md': c, 'AGENTS.md': c }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('claude-tokens');
  });

  it('61-line rule fails', () => {
    const r = run(fixture({ ...clean(), '.claude/rules/sub/x.md': rule(61) }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('rule-lines');
    expect(r.stderr).toContain('.claude/rules/sub/x.md');
  });

  it('rule without paths fails', () => {
    const r = run(fixture({ ...clean(), '.claude/rules/nopaths.md': '# no frontmatter\n' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('rule-paths');
  });

  it('block-scalar description is measured folded', () => {
    const half = 'y'.repeat(129);
    const md = `---\nname: demo\ndescription: |\n  ${half}\n  ${half}\n---\nbody\n`;
    const r = run(fixture({ ...clean(), '.agents/skills/demo/SKILL.md': md }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('skill-desc');
  });

  it('301-line SKILL.md fails', () => {
    const r = run(fixture({ ...clean(), '.agents/skills/demo/SKILL.md': skill(301, 'ok') }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('skill-lines');
  });

  it('201-line reference fails', () => {
    const r = run(fixture({ ...clean(), '.agents/skills/demo/references/r.md': lines(201) }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('skill-ref-lines');
  });

  it('allowances downgrade', () => {
    const c = lines(151);
    const r = run(fixture({ ...clean(), 'CLAUDE.md': c, 'AGENTS.md': c }), true);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('(allowed) claude-lines');
  });
});
