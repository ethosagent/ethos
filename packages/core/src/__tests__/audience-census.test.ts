// plan personality-memory-boundary-and-self-amendment, G1-9 — the audience
// census. Absent `RunOptions.roomAudience` means private (D3), which is only
// safe if no production caller omits it BY ACCIDENT. This test finds every
// production `AgentLoop.run(` call site and fails unless each one either
//
//   (a) passes `roomAudience` in its call (anywhere between `run(` and the
//       matching `)`, so multi-line option objects count), or
//   (b) carries the marker `// audience: private-by-design (<reason>)` on the
//       call's first line or on the line directly above it, with a non-empty
//       reason, or
//   (c) is still listed in PENDING_WIRING below — a caller a later plan step
//       wires. The list may only shrink: an entry whose file has FEWER
//       unwired sites than it claims fails too, so the step that wires a
//       caller must also delete (or decrement) its entry.
//
// HOW A CALL SITE IS FOUND. Every `.ts`/`.tsx` file under `apps/`,
// `extensions/` and `packages/` except tests (`__tests__/`, `*.test.ts(x)`),
// fixtures, `dist/` and `node_modules/` is scanned for `<receiver>.run(` where
// the receiver's LAST property name ends in `loop` (case-insensitive:
// `loop.run`, `this.loop.run`, `bot.loop.run`, `systemLoop.run`,
// `forkLoop.run`, `deps.agentLoop.run`, `runtime.loop.run` …), plus the
// receivers in RECEIVER_ALIASES — AgentLoops held under another name. A match
// on a comment line is ignored. The call's text is taken by balancing
// parentheses from `run(` forward, skipping string and template literals.
//
// The self-test block at the bottom pins the scanner itself (multi-line
// options, markers, comments), so a scanner that silently finds nothing
// cannot pass: the census also requires a minimum number of sites.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SCAN_ROOTS = ['apps', 'extensions', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', '__fixtures__', 'build', '.turbo']);

/** AgentLoops held under a name that does not end in `loop`. File → receivers. */
const RECEIVER_ALIASES: Record<string, readonly string[]> = {
  // ACP's structural `AgentRunner` is the AgentLoop in production.
  'apps/acp-server/src/index.ts': ['this.runner'],
};

/**
 * Callers a later plan step wires, with the number of unwired sites each file
 * still holds. Remove (or decrement) an entry in the same change that wires it
 * — the census fails on a stale count in either direction.
 */
const PENDING_WIRING: ReadonlyArray<{ file: string; count: number; step: number; what: string }> = [
  {
    file: 'extensions/skill-evolver/src/improvement-fork.ts',
    count: 1,
    step: 6,
    what: 'improvement fork (shouldFork refuses shared sources)',
  },
];

/** Packages that must never drive an AgentLoop (they never load Ethos memory). */
const NO_LOOP_PACKAGES = ['extensions/execution-pi/', 'extensions/execution-coding-agents/'];

const MARKER = /\/\/ audience: private-by-design \(([^)]*\S[^)]*)\)/;
const CALL = /([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\??\.run\(/g;

interface CallSite {
  file: string;
  line: number;
  receiver: string;
  text: string;
  status: 'wired' | 'marked' | 'unwired';
}

/**
 * The text from `(` at `open` to its matching `)`, skipping string and
 * template literals. Unbalanced input returns the rest of the source.
 */
function callText(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function isLoopReceiver(file: string, receiver: string): boolean {
  const last = receiver.split(/\??\./).at(-1) ?? '';
  if (/loop$/i.test(last)) return true;
  return (RECEIVER_ALIASES[file] ?? []).includes(receiver);
}

/** Every AgentLoop `.run(` call site in `source`, classified. */
function scanSource(file: string, source: string): CallSite[] {
  const lines = source.split('\n');
  const sites: CallSite[] = [];
  for (const match of source.matchAll(CALL)) {
    const receiver = match[1] ?? '';
    if (!isLoopReceiver(file, receiver)) continue;
    const index = match.index ?? 0;
    const lineIdx = source.slice(0, index).split('\n').length - 1;
    const lineText = lines[lineIdx] ?? '';
    const column = index - source.lastIndexOf('\n', index - 1) - 1;
    const before = lineText.slice(0, column);
    const trimmed = lineText.trimStart();
    if (before.includes('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    const text = callText(source, index + match[0].length - 1);
    let status: CallSite['status'] = 'unwired';
    if (/\broomAudience\b/.test(text)) status = 'wired';
    else if (MARKER.test(lineText) || MARKER.test(lines[lineIdx - 1] ?? '')) status = 'marked';
    sites.push({ file, line: lineIdx + 1, receiver, text, status });
  }
  return sites;
}

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      out.push(...productionFiles(join(dir, entry.name)));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function census(): CallSite[] {
  const sites: CallSite[] = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of productionFiles(join(REPO_ROOT, root))) {
      const file = relative(REPO_ROOT, abs).split(sep).join('/');
      sites.push(...scanSource(file, readFileSync(abs, 'utf-8')));
    }
  }
  return sites;
}

describe('audience census — every production AgentLoop.run caller declares its audience', () => {
  const sites = census();
  const unwiredByFile = new Map<string, CallSite[]>();
  for (const site of sites) {
    if (site.status !== 'unwired') continue;
    unwiredByFile.set(site.file, [...(unwiredByFile.get(site.file) ?? []), site]);
  }

  it('finds the known population of call sites (the scanner is not silently blind)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(35);
  });

  it('every call site passes roomAudience, carries the marker, or is pending wiring', () => {
    const pending = new Set(PENDING_WIRING.map((p) => p.file));
    const strays = [...unwiredByFile.entries()]
      .filter(([file]) => !pending.has(file))
      .flatMap(([, list]) => list.map((s) => `${s.file}:${s.line} (${s.receiver}.run)`));
    expect(
      strays,
      'pass `roomAudience` or add `// audience: private-by-design (<reason>)` on or above the call',
    ).toEqual([]);
  });

  it('PENDING_WIRING counts match exactly — wiring a caller must shrink the list', () => {
    const mismatches = PENDING_WIRING.flatMap((entry) => {
      const actual = unwiredByFile.get(entry.file)?.length ?? 0;
      return actual === entry.count
        ? []
        : [
            `${entry.file}: PENDING_WIRING says ${entry.count} (step ${entry.step}), found ${actual}`,
          ];
    });
    expect(mismatches).toEqual([]);
  });

  it('PENDING_WIRING names each file once', () => {
    const files = PENDING_WIRING.map((p) => p.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it('execution-pi and execution-coding-agents drive no AgentLoop', () => {
    const offenders = sites.filter((s) => NO_LOOP_PACKAGES.some((p) => s.file.startsWith(p)));
    expect(offenders.map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });
});

describe('audience census — scanner self-test', () => {
  const scan = (src: string, file = 'x.ts') => scanSource(file, src);

  it('reads roomAudience from a multi-line options object', () => {
    const [site] = scan(
      [
        'for await (const e of this.loop.run(text, {',
        '  sessionKey,',
        "  roomAudience: shared ? 'shared' : 'private',",
        '})) {}',
      ].join('\n'),
    );
    expect(site?.status).toBe('wired');
  });

  it('does not borrow roomAudience from a LATER statement', () => {
    const [site] = scan("loop.run(text, { sessionKey });\nconst roomAudience = 'shared';");
    expect(site?.status).toBe('unwired');
  });

  it('skips parentheses inside strings and templates', () => {
    // A template literal with a `)` and a placeholder in it, built without one here.
    const tpl = `\`a ) $${'{x}'}\``;
    const [site] = scan(`loop.run(${tpl}, { note: ')', roomAudience: 'shared' });`);
    expect(site?.status).toBe('wired');
  });

  it('accepts the marker on the line above or the same line, and requires a reason', () => {
    expect(
      scan('// audience: private-by-design (owner terminal)\nloop.run(t, {});')[0]?.status,
    ).toBe('marked');
    expect(scan('loop.run(t, {}); // audience: private-by-design (synthetic)')[0]?.status).toBe(
      'marked',
    );
    expect(scan('// audience: private-by-design ()\nloop.run(t, {});')[0]?.status).toBe('unwired');
  });

  it('finds every loop-named receiver and ignores other .run( calls and comments', () => {
    const found = scan(
      [
        'bot.loop.run(a, {});',
        'systemLoop.run(a, {});',
        'deps.agentLoop?.run(a, {});',
        'stmt.run(1, 2);',
        'runner.run(tasks);',
        '// loop.run(a) in a comment',
        ' * loop.run(a) in a doc comment',
      ].join('\n'),
    );
    expect(found.map((s) => s.receiver)).toEqual(['bot.loop', 'systemLoop', 'deps.agentLoop']);
  });

  it('honours RECEIVER_ALIASES only in the file they name', () => {
    expect(scan('this.runner.run(t, {});', 'apps/acp-server/src/index.ts')).toHaveLength(1);
    expect(scan('this.runner.run(t, {});', 'apps/other.ts')).toHaveLength(0);
  });
});
