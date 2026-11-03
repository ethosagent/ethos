import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'report-function-length.mjs');
const dirs: string[] = [];

// `n` body lines in total including the opening and closing brace lines.
function block(header: string, n: number, indent = ''): string {
  const inner = Array.from({ length: n - 2 }, (_, i) => `${indent}  void ${i};`);
  return [`${indent}${header} {`, ...inner, `${indent}}`].join('\n');
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'function-length-'));
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

type Report = {
  total: number;
  over50: number;
  over100: number;
  over200: number;
  byFile: { path: string; count: number; max: number }[];
  functions: { path: string; line: number; name: string; lines: number }[];
};

function readReport(dir: string, ...extra: string[]): Report {
  return JSON.parse(run(dir, '--json', ...extra).stdout) as Report;
}

const SOURCE = [
  block('export function fifty1()', 51),
  `export ${block('const fifty = () =>', 50)};`,
  'export class Big {',
  block('run()', 120, '  '),
  '}',
  '',
].join('\n');

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('report-function-length', () => {
  it('counts body lines inclusive of both braces and reports only above --min', () => {
    const dir = fixture({ 'src/a.ts': SOURCE });
    expect(run(dir, '--json').status).toBe(0);
    const report = readReport(dir);
    expect(report.total).toBe(3);
    expect(report.over50).toBe(2);
    expect(report.over100).toBe(1);
    expect(report.over200).toBe(0);
    expect(report.functions[0]?.lines).toBe(120);
    expect(report.functions[0]?.name).toBe('Big.run');
    expect(report.functions.map((f) => f.lines)).toEqual([120, 51]);
    expect(report.byFile).toEqual([{ path: 'src/a.ts', count: 2, max: 120 }]);
  });

  it('names assigned arrows and anonymous functions', () => {
    const dir = fixture({
      'src/b.ts': `${block('export const named = () =>', 60)};\nexport default ${block('function ()', 60)};\n`,
    });
    const names = readReport(dir).functions.map((f) => f.name);
    expect(names.sort()).toEqual(['<anonymous>', 'named']);
  });

  it('skips tests, d.ts, __tests__ and node_modules, and bodiless overloads', () => {
    const big = block('export function f()', 70);
    const dir = fixture({
      'src/a.test.ts': big,
      'src/__tests__/a.ts': big,
      'src/a.d.ts': 'export declare function f(): void;\n',
      'node_modules/x/index.ts': big,
      'src/o.ts': 'export function g(a: string): void;\nexport function g(a: number): void;\n',
    });
    const report = readReport(dir);
    expect(report.total).toBe(0);
  });

  it('prints text lines sorted descending plus a totals line', () => {
    const dir = fixture({ 'src/a.ts': SOURCE });
    const r = run(dir);
    expect(r.status).toBe(0);
    const out = r.stdout.trimEnd().split('\n');
    expect(out[0]).toMatch(/^120\tsrc\/a\.ts:\d+\tBig\.run$/);
    expect(out[1]).toMatch(/^51\tsrc\/a\.ts:1\tfifty1$/);
    expect(out[2]).toBe('functions>50: 2 in 1 files; >100: 1; >200: 0');
  });

  it('honours --min and exits 2 on bad usage', () => {
    const dir = fixture({ 'src/a.ts': SOURCE });
    const report = readReport(dir, '--min', '100');
    expect(report.functions).toHaveLength(1);
    expect(report.over50).toBe(2);
    expect(run(dir, '--min', 'abc').status).toBe(2);
    expect(run(dir, '--bogus').status).toBe(2);
  });

  it('measures .tsx files, including generic arrows', () => {
    const jsx = [
      'export const View = () => {',
      '  return (',
      '    <div>',
      '      <span />',
      '    </div>',
      '  );',
      '};',
      'export const id = <T,>(x: T) => {',
      '  return x;',
      '};',
      '',
    ].join('\n');
    const dir = fixture({ 'src/v.tsx': jsx });
    const report = readReport(dir, '--min', '0');
    expect(report.functions.map((f) => [f.name, f.lines])).toEqual([
      ['View', 7],
      ['id', 3],
    ]);
  });

  it('measures constructors, accessors and class-property arrows', () => {
    const src = [
      'export class C {',
      '  handler = () => {',
      '    void 1;',
      '  };',
      '  constructor() {',
      '    void 1;',
      '  }',
      '  get value() {',
      '    return 1;',
      '  }',
      '  set value(v: number) {',
      '    void v;',
      '  }',
      '}',
      '',
    ].join('\n');
    const dir = fixture({ 'src/c.ts': src });
    const report = readReport(dir, '--min', '0');
    expect(report.total).toBe(4);
    expect(report.functions.map((f) => f.name).sort()).toEqual([
      'C.constructor',
      'C.handler',
      'C.value',
      'C.value',
    ]);
  });

  it('counts nested functions separately; inner lines stay in the parent span', () => {
    const inner = block('const inner = () =>', 60, '  ');
    const outer = [
      'export function outer() {',
      inner,
      ...Array.from({ length: 58 }, (_, i) => `  void ${i};`),
      '}',
      '',
    ].join('\n');
    const dir = fixture({ 'src/n.ts': outer });
    const report = readReport(dir);
    expect(report.total).toBe(2);
    expect(report.over50).toBe(2);
    expect(report.functions.map((f) => [f.name, f.lines])).toEqual([
      ['outer', 120],
      ['inner', 60],
    ]);
  });

  it('reports the line of the name, not the decorator above it', () => {
    const src = [
      'export class D {',
      '  @dec()',
      '  @other()',
      '  method() {',
      '    void 1;',
      '  }',
      '}',
      '',
    ].join('\n');
    const dir = fixture({ 'src/d.ts': src });
    const report = readReport(dir, '--min', '0');
    expect(report.functions[0]).toMatchObject({ name: 'D.method', line: 4, lines: 3 });
  });
});
