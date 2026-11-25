// plan channel-prompts D1 / L4 — the room-policy census. Resolving the room in
// the gateway, once, is what keeps a platform from being forgotten (Hermes's
// Matrix gap). Two halves:
//
//  (a) every AgentLoop `.run(` call site in extensions/gateway/src passes
//      `roomPrompt` or carries `// room: none (<reason>)` on its first line or
//      in the comment block directly above it. Scanner approach copied from
//      packages/core/src/__tests__/audience-census.test.ts.
//  (b) driven: one envelope per platform id (and a plugin id) with a `*` entry
//      reaches loop.run with the block.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { AgentLoop } from '@ethosagent/core';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';
import type { RoomPolicyTable } from '../room-policy';

const GATEWAY_SRC = join(import.meta.dirname, '..');
const REPO_ROOT = join(GATEWAY_SRC, '..', '..', '..');
const MARKER = /\/\/ room: none \(([^)]*\S[^)]*)\)/;
const CALL = /([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\??\.run\(/g;
const RUN_OPTIONS_SHAPED = /[{,]\s*sessionKey\s*[:,}]/;

interface CallSite {
  file: string;
  line: number;
  receiver: string;
  status: 'wired' | 'marked' | 'unwired';
}

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

/** The call's own line plus the contiguous `//` comment block directly above it. */
function markerContext(lines: string[], lineIdx: number): string {
  const out = [lines[lineIdx] ?? ''];
  for (let i = lineIdx - 1; i >= 0 && (lines[i] ?? '').trimStart().startsWith('//'); i--) {
    out.push(lines[i] ?? '');
  }
  return out.join('\n');
}

function scanSource(file: string, source: string): CallSite[] {
  const lines = source.split('\n');
  const sites: CallSite[] = [];
  for (const match of source.matchAll(CALL)) {
    const receiver = match[1] ?? '';
    const index = match.index ?? 0;
    const lineIdx = source.slice(0, index).split('\n').length - 1;
    const lineText = lines[lineIdx] ?? '';
    const column = index - source.lastIndexOf('\n', index - 1) - 1;
    const trimmed = lineText.trimStart();
    if (lineText.slice(0, column).includes('//') || trimmed.startsWith('*')) continue;
    const text = callText(source, index + match[0].length - 1);
    const last = receiver.split(/\??\./).at(-1) ?? '';
    if (!/loop$/i.test(last) && !RUN_OPTIONS_SHAPED.test(text)) continue;
    let status: CallSite['status'] = 'unwired';
    if (/\broomPrompt\b/.test(text)) status = 'wired';
    else if (MARKER.test(markerContext(lines, lineIdx))) status = 'marked';
    sites.push({ file, line: lineIdx + 1, receiver, status });
  }
  return sites;
}

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...productionFiles(join(dir, entry.name)));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const sites = productionFiles(GATEWAY_SRC).flatMap((abs) =>
  scanSource(relative(REPO_ROOT, abs).split(sep).join('/'), readFileSync(abs, 'utf-8')),
);

describe('room census — every gateway AgentLoop.run caller declares its room', () => {
  it('finds the known call sites (the scanner is not silently blind)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(2);
    expect(sites.some((s) => s.file.endsWith('gateway/src/index.ts') && s.status === 'wired')).toBe(
      true,
    );
  });

  it('every call site passes roomPrompt or carries // room: none (<reason>)', () => {
    const strays = sites
      .filter((s) => s.status === 'unwired')
      .map((s) => `${s.file}:${s.line} (${s.receiver}.run)`);
    expect(
      strays,
      'pass `roomPrompt` (resolve in Gateway.runTurn) or add `// room: none (<reason>)` on or above the call',
    ).toEqual([]);
  });
});

describe('room census — scanner self-test', () => {
  const scan = (src: string) => scanSource('x.ts', src);

  it('reads roomPrompt from a multi-line options object, not from a later statement', () => {
    expect(scan('loop.run(t, {\n  sessionKey,\n  roomPrompt: p,\n});')[0]?.status).toBe('wired');
    expect(scan("loop.run(t, { sessionKey });\nconst roomPrompt = 'x';")[0]?.status).toBe(
      'unwired',
    );
  });

  it('accepts the marker on the line, or in the comment block above, and requires a reason', () => {
    expect(scan('// room: none (maintenance)\nloop.run(t, {});')[0]?.status).toBe('marked');
    expect(scan('// room: none (maintenance)\n// audience: x\nloop.run(t, {});')[0]?.status).toBe(
      'marked',
    );
    expect(scan('loop.run(t, {}); // room: none (maintenance)')[0]?.status).toBe('marked');
    expect(scan('// room: none ()\nloop.run(t, {});')[0]?.status).toBe('unwired');
    expect(scan('// room: none (x)\n\nloop.run(t, {});')[0]?.status).toBe('unwired');
  });

  it('ignores comments and non-loop receivers, finds RunOptions-shaped calls anywhere', () => {
    expect(scan('// loop.run(a, {})\n * loop.run(a)\nstmt.run(1, 2);')).toHaveLength(0);
    expect(scan('this.runner.run(t, { sessionKey });')[0]?.status).toBe('unwired');
  });
});

describe('room census — one envelope per platform reaches loop.run with the block', () => {
  function adapterFor(platform: string): PlatformAdapter {
    return {
      id: `${platform}:bot-a`,
      displayName: platform,
      capabilities: { platform },
      canSendTyping: false,
      canEditMessage: false,
      canReact: false,
      canSendFiles: false,
      maxMessageLength: 4096,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue({ ok: true, messageId: '1' }),
      onMessage: vi.fn(),
      health: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as PlatformAdapter;
  }

  const cases: Array<{ platform: string; wildcard: '*' | '*dm'; isDm: boolean }> = [
    { platform: 'slack', wildcard: '*', isDm: false },
    { platform: 'discord', wildcard: '*', isDm: false },
    { platform: 'telegram', wildcard: '*', isDm: false },
    { platform: 'whatsapp', wildcard: '*', isDm: false },
    { platform: 'email', wildcard: '*dm', isDm: true },
    // A plugin platform the gateway has never heard of: the resolver is gateway-side.
    { platform: 'matrix', wildcard: '*', isDm: false },
  ];

  for (const c of cases) {
    it(`${c.platform} (${c.wildcard})`, async () => {
      const calls: Array<Record<string, unknown>> = [];
      const loop = {
        run: vi.fn((_t: string, opts: Record<string, unknown>) => {
          calls.push(opts);
          return (async function* () {
            yield { type: 'done', text: 'ok', turnCount: 1 };
          })();
        }),
        hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
      };
      const table: RoomPolicyTable = {
        [c.platform]: { entries: { [c.wildcard]: { prompt: `block-${c.platform}` } } },
      };
      const gw = new Gateway({
        bots: [
          {
            botKey: 'bot-a',
            loop: loop as unknown as AgentLoop,
            binding: { type: 'personality', name: 'default' },
          },
        ],
        clarifySweepIntervalMs: 0,
        roomPolicies: table,
      });
      const message: InboundMessage = {
        platform: c.platform,
        chatId: 'room-1',
        userId: 'u1',
        text: 'hi',
        isDm: c.isDm,
        isGroupMention: !c.isDm,
        messageId: 'm1',
        botKey: 'bot-a',
        raw: {},
      };
      await gw.handleMessage(message, adapterFor(c.platform));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.roomPrompt).toBe(`block-${c.platform}`);
    });
  }
});
