/**
 * buildNodeExecutor — the laptop half of the node tools (plan laptop-tool-node T3).
 * Real temp dirs; HOME is stubbed so `sensitiveDenyPaths()` names the temp home
 * (verification E7: the deny floor is absolute-path based, not name based).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ToolExecuteRequest } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNodeExecutor, nodePersonalityFsReach } from '../node-executor';

let tmpHome: string;
let proj: string;
const signal = new AbortController().signal;
const emit = () => {};
let seq = 0;

function req(
  name: string,
  args: unknown,
  over: Partial<ToolExecuteRequest> = {},
): ToolExecuteRequest {
  seq += 1;
  return {
    toolCallId: `tc-${seq}`,
    name,
    args,
    sessionId: 's',
    sessionKey: 'k',
    platform: 'cli',
    workingDir: '/srv/whatever',
    personalityId: 'coder',
    currentTurn: 1,
    messageCount: 1,
    resultBudgetChars: 100_000,
    ...over,
  };
}

beforeEach(() => {
  tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'node-exec-')));
  vi.stubEnv('HOME', tmpHome);
  proj = join(tmpHome, 'proj');
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(tmpHome, '.ssh'), { recursive: true });
  mkdirSync(join(tmpHome, 'outside'), { recursive: true });
  writeFileSync(join(proj, 'a.txt'), 'hello\n');
  writeFileSync(join(tmpHome, '.ssh', 'id_rsa'), 'PRIVATE');
  writeFileSync(join(tmpHome, 'outside', 'secret.txt'), 'secret');
  symlinkSync('../outside/secret.txt', join(proj, 'link'));
  symlinkSync('../.ssh', join(proj, 'keys'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmpHome, { recursive: true, force: true });
});

function build(roots: { path: string; readOnly: boolean }[], allowTerminal = false) {
  return buildNodeExecutor({
    roots,
    allowTerminal,
    storage: new FsStorage(),
    stateDir: join(tmpHome, '.ethos-node'),
  });
}

describe('buildNodeExecutor', () => {
  it('reads a file inside the root', async () => {
    const ex = build([{ path: proj, readOnly: false }]);
    const r = await ex.execute(req('read_file', { path: join(proj, 'a.txt') }), signal, emit);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toContain('hello');
  });

  it('rewrites workingDir to the primary root so relative paths resolve there', async () => {
    const ex = build([{ path: proj, readOnly: false }]);
    const r = await ex.execute(req('read_file', { path: 'a.txt' }), signal, emit);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toContain('hello');
  });

  it('refuses a symlink that leaves the root', async () => {
    const ex = build([{ path: proj, readOnly: false }]);
    const r = await ex.execute(req('read_file', { path: join(proj, 'link') }), signal, emit);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Filesystem boundary|PATH_NOT_REACHABLE/);
  });

  it('refuses the sensitive deny floor when the root contains HOME, and via a symlink', async () => {
    const wide = build([{ path: tmpHome, readOnly: false }]);
    const direct = await wide.execute(
      req('read_file', { path: join(tmpHome, '.ssh', 'id_rsa') }),
      signal,
      emit,
    );
    expect(direct.ok).toBe(false);

    const narrow = build([{ path: proj, readOnly: false }]);
    const viaLink = await narrow.execute(
      req('read_file', { path: join(proj, 'keys', 'id_rsa') }),
      signal,
      emit,
    );
    expect(viaLink.ok).toBe(false);
  });

  // Pin for plan D8: the server's personalityId / fs_reach is never consulted
  // (NodeExecutor's personalityFsReach ignores its argument).
  it('ignores the server personalityId: inside roots works, outside is refused', async () => {
    const ex = build([{ path: proj, readOnly: false }]);
    const inside = await ex.execute(
      req('read_file', { path: join(proj, 'a.txt') }, { personalityId: 'wide' }),
      signal,
      emit,
    );
    expect(inside.ok).toBe(true);
    const outside = await ex.execute(
      req('read_file', { path: join(tmpHome, 'outside', 'secret.txt') }, { personalityId: 'wide' }),
      signal,
      emit,
    );
    expect(outside.ok).toBe(false);
    const wideWrite = await ex.execute(
      req(
        'write_file',
        { path: join(tmpHome, 'outside', 'w.txt'), content: 'x' },
        { personalityId: 'wide' },
      ),
      signal,
      emit,
    );
    expect(wideWrite.ok).toBe(false);
    expect(existsSync(join(tmpHome, 'outside', 'w.txt'))).toBe(false);
  });

  it('personalityFsReach returns the node roots for arbitrary ids', () => {
    const reach = nodePersonalityFsReach([
      { path: proj, readOnly: false },
      { path: join(tmpHome, 'outside'), readOnly: true },
    ]);
    for (const id of ['wide', 'coder', undefined, '*', '../etc']) {
      expect(reach(id)).toEqual({ read: [proj, join(tmpHome, 'outside')], write: [proj] });
    }
  });

  it('M1: refuses a write into a nested read-only root, including case-variant spellings', async () => {
    mkdirSync(join(proj, 'secrets'));
    const ex = build([
      { path: proj, readOnly: false },
      { path: join(proj, 'secrets'), readOnly: true },
    ]);
    for (const dir of ['secrets', 'SECRETS', 'Secrets']) {
      const target = join(proj, dir, 'x.txt');
      const w = await ex.execute(req('write_file', { path: target, content: 'x' }), signal, emit);
      expect(w.ok).toBe(false);
      const p = await ex.execute(
        req('patch_file', { path: target, old_text: 'a', new_text: 'b' }),
        signal,
        emit,
      );
      expect(p.ok).toBe(false);
    }
    expect(existsSync(join(proj, 'secrets', 'x.txt'))).toBe(false);
    const fine = await ex.execute(
      req('write_file', { path: join(proj, 'fine.txt'), content: 'x' }),
      signal,
      emit,
    );
    expect(fine.ok).toBe(true);
  });

  it('refuses a write to a read-only root', async () => {
    const ex = build([{ path: proj, readOnly: true }]);
    const r = await ex.execute(
      req('write_file', { path: join(proj, 'n.txt'), content: 'x' }),
      signal,
      emit,
    );
    expect(r.ok).toBe(false);
  });

  it('exposes terminal only when allowed', async () => {
    const off = build([{ path: proj, readOnly: false }], false);
    expect(off.toolNames).toEqual(['read_file', 'write_file', 'patch_file', 'search_files']);
    const refused = await off.execute(req('terminal', { command: 'echo hi' }), signal, emit);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('not_available');

    const on = build([{ path: proj, readOnly: false }], true);
    expect(on.toolNames).toEqual([
      'read_file',
      'write_file',
      'patch_file',
      'search_files',
      'terminal',
    ]);
    const ran = await on.execute(req('terminal', { command: 'echo hi', cwd: proj }), signal, emit);
    expect(ran.ok).toBe(true);
    if (ran.ok) expect(ran.value).toContain('hi');
  });

  it('write_file then patch_file round-trips (per-executor readMtimes)', async () => {
    const ex = build([{ path: proj, readOnly: false }]);
    const p = join(proj, 'rt.txt');
    const w = await ex.execute(req('write_file', { path: p, content: 'one two\n' }), signal, emit);
    expect(w.ok).toBe(true);
    const rd = await ex.execute(req('read_file', { path: p }), signal, emit);
    expect(rd.ok).toBe(true);
    const pt = await ex.execute(
      req('patch_file', { path: p, old_text: 'one', new_text: 'uno' }),
      signal,
      emit,
    );
    expect(pt.ok).toBe(true);
    const after = await ex.execute(req('read_file', { path: p }), signal, emit);
    if (after.ok) expect(after.value).toContain('uno two');
  });

  it('keeps stale-write bookkeeping per session: one session read never guards another', async () => {
    const ex = build([{ path: proj, readOnly: false }]);
    const p = join(proj, 'sess.txt');
    writeFileSync(p, 'v1\n');
    const read = await ex.execute(req('read_file', { path: p }, { sessionKey: 'A' }), signal, emit);
    expect(read.ok).toBe(true);
    writeFileSync(p, 'v2\n');
    utimesSync(p, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const a = await ex.execute(
      req('write_file', { path: p, content: 'from A' }, { sessionKey: 'A' }),
      signal,
      emit,
    );
    expect(a).toMatchObject({ ok: false, code: 'STALE_WRITE' });
    const b = await ex.execute(
      req('write_file', { path: p, content: 'from B' }, { sessionKey: 'B' }),
      signal,
      emit,
    );
    expect(b.ok).toBe(true);
  });
});
