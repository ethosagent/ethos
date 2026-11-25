// plan laptop-tool-node T9 (brief D2): `ethos node ...` — connect: url policy, pairing, state, terminal statuses.
// Fixtures and the injected-deps setup live in ./node-command-fixtures.

import { PassThrough } from 'node:stream';
import { decodeNodeFrame, nodeKeyRef, readNodeState } from '@ethosagent/wiring/nodes';
import { describe, expect, it, vi } from 'vitest';
import { runNode } from '../commands/node';
import {
  code,
  deps,
  err,
  flush,
  net,
  out,
  resetNet,
  SERVER,
  STATE_DIR,
  secrets,
  stop,
  storage,
  text,
  until,
} from './node-command-fixtures';

describe('node connect: url policy', () => {
  it('refuses cleartext to a non-loopback host before anything is stored or dialled', async () => {
    for (const url of ['ws://example.com', 'http://10.1.2.3:3000']) {
      expect(await code(runNode(['connect', url, '--root', '/work/a'], deps()))).toBe(
        'INVALID_INPUT',
      );
    }
    expect(await secrets.list()).toEqual([]);
    expect(await readNodeState(storage, STATE_DIR)).toBeNull();
    expect(net.sockets).toEqual([]);
  });
});

describe('node connect: pairing and key', () => {
  it('pairs when no key is stored, stores it at nodeKeyRef and dials with it', async () => {
    const p = runNode(['connect', SERVER, '--root', '/work/a', '--name', 'lap'], deps());
    await until(() => net.nodeSockets().length === 1);
    expect(text(out)).toContain('ABCD2345');
    expect(text(out)).toContain('ethos node approve ABCD2345');
    expect(await secrets.get(nodeKeyRef(SERVER))).toBe('sk-ethos-PAIREDKEY');
    const sock = net.nodeSockets()[0];
    expect(sock?.url).toBe('ws://127.0.0.1:3000/node/ws');
    expect(sock?.headers).toEqual({ Authorization: 'Bearer sk-ethos-PAIREDKEY' });
    sock?.h.onOpen();
    const hello = decodeNodeFrame(sock?.sent[0] ?? '');
    expect(hello.ok && hello.frame.kind === 'hello' && hello.frame.name).toBe('lap');
    await stop?.();
    await expect(p).resolves.toBe(0);
  });

  it('reuses a stored key without pairing; --pair forces pairing again', async () => {
    await secrets.set(nodeKeyRef(SERVER), 'sk-ethos-STORED');
    const p = runNode(['connect', SERVER, '--root', '/work/a', '--name', 'lap'], deps());
    await until(() => net.nodeSockets().length === 1);
    expect(net.pairSockets()).toHaveLength(0);
    expect(net.nodeSockets()[0]?.headers).toEqual({ Authorization: 'Bearer sk-ethos-STORED' });
    await stop?.();
    await p;

    resetNet('sk-ethos-REPAIRED');
    const p2 = runNode(['connect', SERVER, '--pair'], deps());
    await until(() => net.nodeSockets().length === 1);
    expect(net.pairSockets()).toHaveLength(1);
    expect(net.nodeSockets()[0]?.headers).toEqual({ Authorization: 'Bearer sk-ethos-REPAIRED' });
    await stop?.();
    await p2;
  });
});

describe('node connect: state', () => {
  it('saves flags through writeNodeState and a bare connect reuses them', async () => {
    const p = runNode(
      [
        'connect',
        SERVER,
        '--root',
        '/work/a',
        '--root',
        '/work/b:ro',
        '--name',
        'lap',
        '--personality',
        'coder',
        '--allow-terminal',
        '--writes',
        'auto',
      ],
      deps(),
    );
    await until(() => net.nodeSockets().length === 1);
    const saved = await readNodeState(storage, STATE_DIR);
    expect(saved).toEqual({
      server: SERVER,
      name: 'lap',
      roots: [
        { path: '/work/a', readOnly: false },
        { path: '/work/b', readOnly: true },
      ],
      personalities: ['coder'],
      allowTerminal: true,
      writes: 'auto',
      allowUnattended: false,
    });
    await stop?.();
    await p;

    resetNet();
    const p2 = runNode(['connect', SERVER], deps());
    await until(() => net.nodeSockets().length === 1);
    net.nodeSockets()[0]?.h.onOpen();
    const hello = decodeNodeFrame(net.nodeSockets()[0]?.sent[0] ?? '');
    if (!hello.ok || hello.frame.kind !== 'hello') throw new Error('no hello');
    expect(hello.frame.name).toBe('lap');
    expect(hello.frame.personalities).toEqual(['coder']);
    expect(hello.frame.roots).toHaveLength(2);
    expect(hello.frame.tools).toContain('terminal');
    await stop?.();
    await p2;
  });

  // Verification m1: saved allow-* flags must be revocable, and the effective policy is shown.
  it('--no-allow-terminal and --no-allow-unattended clear saved state; the policy line says so', async () => {
    const p = runNode(
      ['connect', SERVER, '--root', '/work/a', '--root', '/work/b:ro', '--name', 'lap'].concat([
        '--allow-terminal',
        '--allow-unattended',
      ]),
      deps(),
    );
    await until(() => net.nodeSockets().length === 1);
    const first = text(out);
    expect(first).toContain('policy:');
    expect(first).toContain('/work/a');
    expect(first).toContain('/work/b (read-only)');
    expect(first).toContain('writes ask');
    expect(first).toContain('terminal ON');
    expect(first).toContain('unattended ON');
    expect(first).toContain('personalities *');
    await stop?.();
    await p;

    resetNet();
    out.length = 0;
    const p2 = runNode(['connect', SERVER, '--no-allow-terminal', '--no-allow-unattended'], deps());
    await until(() => net.nodeSockets().length === 1);
    const saved = await readNodeState(storage, STATE_DIR);
    expect(saved).toMatchObject({ allowTerminal: false, allowUnattended: false });
    expect(text(out)).toContain('terminal off');
    expect(text(out)).toContain('unattended off');
    await stop?.();
    await p2;
  });

  it('a root that does not exist is INVALID_INPUT and nothing is dialled', async () => {
    expect(await code(runNode(['connect', SERVER, '--root', '/work/missing'], deps()))).toBe(
      'INVALID_INPUT',
    );
    expect(net.sockets).toEqual([]);
  });

  it('no root and no saved state is INVALID_INPUT', async () => {
    expect(await code(runNode(['connect', SERVER], deps()))).toBe('INVALID_INPUT');
  });
});

describe('node connect: terminal statuses and backoff', () => {
  it('unauthorized prints the re-pair line, deletes the key and exits 1', async () => {
    await secrets.set(nodeKeyRef(SERVER), 'sk-ethos-REVOKED');
    const p = runNode(['connect', SERVER, '--root', '/work/a', '--name', 'lap'], deps());
    await until(() => net.nodeSockets().length === 1);
    net.nodeSockets()[0]?.h.onUnexpectedResponse(401);
    await expect(p).resolves.toBe(1);
    expect(text(err)).toContain(
      `key revoked or unknown — re-pair with \`ethos node connect ${SERVER} --pair\``,
    );
    expect(await secrets.get(nodeKeyRef(SERVER))).toBeNull();
  });

  it('a 4401 close (key revoked while connected) deletes the key and exits 1, no redial', async () => {
    await secrets.set(nodeKeyRef(SERVER), 'sk-ethos-REVOKED');
    const p = runNode(['connect', SERVER, '--root', '/work/a', '--name', 'lap'], deps());
    await until(() => net.nodeSockets().length === 1);
    const s = net.nodeSockets()[0];
    s?.h.onOpen();
    s?.h.onClose(4401, 'key revoked');
    await expect(p).resolves.toBe(1);
    expect(text(err)).toContain('key revoked or unknown');
    expect(net.nodeSockets()).toHaveLength(1);
    expect(await secrets.get(nodeKeyRef(SERVER))).toBeNull();
  });

  // Live smoke 2026-11-24: the approval reader resumes stdin for the whole session and nothing
  // paused it again, so a revoked node printed its message and then the process hung.
  it('releases stdin when connect ends so the process can exit', async () => {
    await secrets.set(nodeKeyRef(SERVER), 'sk-ethos-REVOKED');
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const p = runNode(['connect', SERVER, '--root', '/work/a', '--name', 'lap'], deps({ stdin }));
    await until(() => net.nodeSockets().length === 1);
    expect(stdin.isPaused()).toBe(false);
    net.nodeSockets()[0]?.h.onUnexpectedResponse(401);
    await expect(p).resolves.toBe(1);
    expect(stdin.isPaused()).toBe(true);
  });

  it('replaced prints the D-REPLACED sentence and exits 1', async () => {
    await secrets.set(nodeKeyRef(SERVER), 'sk-ethos-K');
    const p = runNode(['connect', SERVER, '--root', '/work/a', '--name', 'lap'], deps());
    await until(() => net.nodeSockets().length === 1);
    const s = net.nodeSockets()[0];
    s?.h.onOpen();
    s?.h.onClose(4000, 'replaced');
    await expect(p).resolves.toBe(1);
    expect(text(err)).toContain('replaced by another connection using this key');
    expect(text(err)).toContain('ethos node revoke');
    expect(await secrets.get(nodeKeyRef(SERVER))).toBe('sk-ethos-K');
  });

  it('prints "retrying in 1s" then "retrying in 2s" after two drops', async () => {
    await secrets.set(nodeKeyRef(SERVER), 'sk-ethos-K');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = runNode(['connect', SERVER, '--root', '/work/a', '--name', 'lap'], deps());
    await vi.waitFor(() => expect(net.nodeSockets()).toHaveLength(1));
    const first = net.nodeSockets()[0];
    first?.h.onOpen();
    first?.h.onClose(1006, '');
    expect(text(out)).toContain('retrying in 1s');
    await vi.advanceTimersByTimeAsync(1000);
    expect(net.nodeSockets()).toHaveLength(2);
    net.nodeSockets()[1]?.h.onClose(1006, '');
    expect(text(out)).toContain('retrying in 2s');
    await stop?.();
    await flush();
    await expect(p).resolves.toBe(0);
  });
});
