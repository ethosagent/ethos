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

function run(dir: string, ...extra: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, ...extra], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

function skill(totalLines: number, description: string): string {
  const head = `---\nname: demo\ndescription: ${description}\n---\n`;
  const body = Array.from({ length: totalLines - 4 }, () => 'body').join('\n');
  return `${head}${body}\n`;
}

const rule = (n: number) => `---\npaths:\n  - 'src/**'\n---\n${lines(n - 4)}`;
const claude150 = lines(150);
const adrIndex = '# Decisions\n0001-a.md\n';
const twinned = (content: string) => ({ 'CLAUDE.md': content, 'AGENTS.md': content });

// ARCHITECTURE.md whose counted prose is exactly `counted` lines: the rules yaml body (200 lines) and
// the archcheck table interior (30 lines) sit on top and must not be counted.
function arch(counted: number, width = 10): string {
  const prose = Array.from({ length: counted - 4 }, () => 'x'.repeat(width));
  const body = Array.from({ length: 200 }, () => 'k: v'.padEnd(width, 'v'));
  const table = Array.from({ length: 30 }, () => '| row |');
  return `${[
    ...prose,
    '<!-- archcheck:begin rules-table -->',
    ...table,
    '<!-- archcheck:end rules-table -->',
    '```yaml',
    '# ARCHITECTURE-RULES v1',
    ...body,
    '```',
  ].join('\n')}\n`;
}

function clean(): Record<string, string> {
  return {
    ...twinned(claude150),
    '.claude/rules/a.md': rule(60),
    '.agents/skills/demo/SKILL.md': skill(300, 'd'.repeat(250)),
  };
}

// No rule reads ADR content; line count is all that matters.
const adrCase = (n: number): Record<string, string> => ({
  ...clean(),
  'docs/decisions/README.md': adrIndex,
  'docs/decisions/0001-a.md': lines(n),
});

function expectFail(files: Record<string, string>, rule: string, ...extra: string[]) {
  const r = run(fixture(files), ...extra);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(rule);
  return r;
}

const withArch = (md: string) => ({ ...clean(), 'ARCHITECTURE.md': md });

function expectPass(files: Record<string, string>) {
  const r = run(fixture(files));
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  return r;
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
    expectFail({ ...clean(), 'AGENTS.md': claude150.slice(0, -1) }, 'AGENT-FILES twin AGENTS.md');
  });

  it('symlinked twin passes', () => {
    const { 'CLAUDE.md': _claude, ...files } = clean();
    const dir = fixture(files);
    symlinkSync('AGENTS.md', join(dir, 'CLAUDE.md'));
    const r = run(dir);
    expect(r.stderr).not.toContain('twin');
    expect(r.status).toBe(0);
  });

  it('missing AGENTS.md fails twin', () => {
    const { 'AGENTS.md': _agents, ...files } = clean();
    expectFail(files, 'AGENT-FILES twin AGENTS.md');
  });

  it('dangling CLAUDE.md symlink fails twin', () => {
    const { 'CLAUDE.md': _claude, 'AGENTS.md': _agents, ...files } = clean();
    const dir = fixture(files);
    symlinkSync('AGENTS.md', join(dir, 'CLAUDE.md'));
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('AGENT-FILES twin CLAUDE.md');
  });

  it('151-line CLAUDE.md fails', () => {
    const c = lines(151);
    expectFail({ ...clean(), ...twinned(c) }, 'claude-lines');
  });

  it('10,001-char CLAUDE.md fails', () => {
    const c = `${'x'.repeat(10_000)}\n`;
    expectFail({ ...clean(), ...twinned(c) }, 'claude-tokens');
  });

  it('61-line rule fails', () => {
    const r = expectFail({ ...clean(), '.claude/rules/sub/x.md': rule(61) }, 'rule-lines');
    expect(r.stderr).toContain('.claude/rules/sub/x.md');
  });

  it('rule without paths fails', () => {
    expectFail({ ...clean(), '.claude/rules/nopaths.md': '# no frontmatter\n' }, 'rule-paths');
  });

  it('block-scalar description is measured folded', () => {
    const half = 'y'.repeat(129);
    const md = `---\nname: demo\ndescription: |\n  ${half}\n  ${half}\n---\nbody\n`;
    expectFail({ ...clean(), '.agents/skills/demo/SKILL.md': md }, 'skill-desc');
  });

  it('301-line SKILL.md fails', () => {
    expectFail({ ...clean(), '.agents/skills/demo/SKILL.md': skill(301, 'ok') }, 'skill-lines');
  });

  it('201-line reference fails', () => {
    expectFail(
      { ...clean(), '.agents/skills/demo/references/r.md': lines(201) },
      'skill-ref-lines',
    );
  });

  it('has no allowances: an over-limit skill fails and nothing is marked (allowed)', () => {
    const r = run(fixture({ ...clean(), '.agents/skills/demo/SKILL.md': skill(301, 'ok') }));
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain('(allowed)');
  });

  it('unparseable skill frontmatter fails', () => {
    const r = expectFail(
      { ...clean(), '.agents/skills/demo/SKILL.md': skill(10, 'Write it: then stop') },
      'skill-desc',
    );
    expect(r.stderr).toContain('frontmatter does not parse as YAML');
  });

  it('unparseable rule frontmatter fails', () => {
    const r = expectFail(
      { ...clean(), '.claude/rules/b.md': "---\npaths: 'a: b: c\n---\nbody\n" },
      'rule-paths',
    );
    expect(r.stderr).toContain('frontmatter does not parse as YAML');
  });

  it('skill without description fails', () => {
    const r = expectFail(
      { ...clean(), '.agents/skills/demo/SKILL.md': '---\nname: demo\n---\nbody\n' },
      'skill-desc',
    );
    expect(r.stderr).toContain('missing description');
  });

  describe('architecture and decision records', () => {
    const CEILING = 518; // ALLOWANCES['arch-lines'] in scripts/check-agent-files.mjs

    it('300 counted lines with a 200-line yaml body and a table passes', () => {
      expectPass(withArch(arch(300)));
    });

    it('301 counted lines fails arch-lines', () => {
      const r = expectFail(withArch(arch(301)), 'arch-lines', '--no-allowances');
      expect(r.stderr).toContain('ARCHITECTURE.md');
    });

    it('a ```yaml fence that is not the rules block is counted as prose', () => {
      const md = `${lines(2000)}\`\`\`yaml\na: 1\n${lines(2000)}\`\`\`\n`;
      expectFail(withArch(md), 'arch-lines');
    });

    it('more than 20,000 counted chars fails arch-tokens', () => {
      expectFail(withArch(arch(250, 90)), 'arch-tokens', '--no-allowances');
    });

    it('20,000 counted chars or fewer passes arch-tokens', () => {
      expectPass(withArch(arch(250, 70)));
    });

    it('--no-allowances ignores an allowance, a default run honours it', () => {
      const dir = fixture(withArch(arch(301)));
      const strict = run(dir, '--no-allowances');
      expect(strict.status).toBe(1);
      expect(strict.stderr).toContain('arch-lines');
      expect(strict.stderr).not.toContain('(allowed');
      const lax = run(dir);
      expect(lax.status).toBe(0);
      expect(lax.stdout).toContain('arch-lines ARCHITECTURE.md');
      expect(lax.stdout).toContain('(allowed');
    });

    it('growing past the allowance fails', () => {
      expectFail(withArch(arch(5000)), 'arch-lines');
    });

    it('an overage exactly at the allowance ceiling is allowed, one more line fails', () => {
      const atMax = run(fixture(withArch(arch(CEILING))));
      expect(atMax.status).toBe(0);
      expect(atMax.stdout).toContain('(allowed');
      const over = expectFail(withArch(arch(CEILING + 1)), 'arch-lines');
      expect(over.stderr).toContain('past its allowance');
    });

    it('121-line ADR fails adr-lines, 120 passes', () => {
      expectPass(adrCase(120));
      expectFail(adrCase(121), 'adr-lines');
    });

    it('151-line index fails adr-index-lines', () => {
      expectFail({ ...clean(), 'docs/decisions/README.md': lines(151) }, 'adr-index-lines');
    });

    it('an ADR missing from the index fails adr-index-missing', () => {
      const r = expectFail(
        {
          ...clean(),
          'docs/decisions/README.md': adrIndex,
          'docs/decisions/0001-a.md': lines(10),
          'docs/decisions/0002-b.md': lines(10),
        },
        'adr-index-missing',
      );
      expect(r.stderr).toContain('0002-b.md');
      expect(r.stderr).not.toContain('adr-index-missing docs/decisions/0001-a.md');
    });

    it('ADRs without any index fail adr-index-missing', () => {
      expectFail({ ...clean(), 'docs/decisions/0001-a.md': lines(10) }, 'adr-index-missing');
    });
  });

  describe('package README presence', () => {
    const pkg = (dir: string, readme = false): Record<string, string> => ({
      [`${dir}/package.json`]: '{}\n',
      ...(readme ? { [`${dir}/README.md`]: '# x\n' } : {}),
    });
    const CEILING = 102; // ALLOWANCES['readme-missing'] in scripts/check-agent-files.mjs

    it('missing README fails without allowance', () => {
      const r = expectFail(
        { ...clean(), ...pkg('packages/a') },
        'readme-missing packages/a',
        '--no-allowances',
      );
      expect(r.stderr).not.toContain('(allowed');
    });

    it('missing README is allowed under the ceiling', () => {
      const r = run(fixture({ ...clean(), ...pkg('packages/safety/a') }));
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('readme-missing packages/safety/a');
    });

    it('more missing READMEs than the ceiling fails', () => {
      const many = Array.from({ length: CEILING + 1 }, (_, i) => pkg(`extensions/e${i}`));
      const r = expectFail(Object.assign(clean(), ...many), 'readme-missing');
      expect(r.stderr).toContain(`past its allowance of ${CEILING}`);
    });

    it('a package with a README passes', () => {
      expectPass({ ...clean(), ...pkg('apps/a', true), ...pkg('packages/a', true) });
    });

    it('a dir without package.json is ignored', () => {
      expectPass({ ...clean(), 'packages/safety/README.txt': 'x\n', 'extensions/b/src/i.ts': '' });
    });
  });
});
