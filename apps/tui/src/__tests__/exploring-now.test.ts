/**
 * Plan initiative-engine Task 6.4: the TUI "exploring now" strip shows the current
 * window, cost so far and a read-only label. The TUI has no RPC path to the
 * initiative store, so the data comes from a host-injected source
 * (`setExploringNowSource`); with none set the strip renders nothing.
 * Authored as .test.ts with createElement: the root vitest glob never runs .test.tsx.
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { FsStorage } from '@ethosagent/storage-fs';
import { initiativesDbPath, SQLiteInitiativeStore } from '@ethosagent/wiring';
import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ExploringNowLine, ExploringNowStrip } from '../components/ExploringNowStrip';
import {
  type ExploringNowSnapshot,
  readExploringNow,
  setExploringNowSource,
} from '../exploring-now';
import { startExploringNowFeed } from '../exploring-now-host';
import { act, enableReactActEnvironment } from './helpers/ink-act';

enableReactActEnvironment();

class FakeStdout extends EventEmitter {
  columns = 120;
  rows = 20;
  frames: string[] = [];
  write(chunk: string): boolean {
    this.frames.push(String(chunk));
    return true;
  }
  last(): string {
    return this.frames.at(-1) ?? '';
  }
}

function makeStdin() {
  const s = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  s.isTTY = true;
  s.setRawMode = () => {};
  s.ref = () => {};
  s.unref = () => {};
  return s;
}

const SNAPSHOT: ExploringNowSnapshot = {
  windowId: 'W-7',
  initiativeId: 'INI-2',
  initiativeTitle: 'Docs gaps',
  question: 'Which pages are thin?',
  started: '2026-12-01T09:00:00Z',
  costSoFarUsd: 0.12,
  readOnly: true,
};

function mount(node: ReturnType<typeof createElement>) {
  const stdout = new FakeStdout();
  const app = render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: makeStdin() as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
  });
  return { stdout, app };
}

afterEach(() => setExploringNowSource(null));

describe('exploring-now strip', () => {
  it('strip shows the current window, cost so far and read-only', async () => {
    const { stdout, app } = mount(createElement(ExploringNowStrip, { snapshot: SNAPSHOT }));
    await act(async () => {});
    const frame = stdout.last();
    expect(frame).toContain('Docs gaps');
    expect(frame).toContain('W-7');
    expect(frame).toContain('$0.12 so far');
    expect(frame).toContain('read-only');
    app.unmount();
  });

  it('renders nothing without a snapshot', async () => {
    const { stdout, app } = mount(createElement(ExploringNowStrip, { snapshot: null }));
    await act(async () => {});
    expect(stdout.last().trim()).toBe('');
    app.unmount();
  });

  it('reads the host-injected source', async () => {
    setExploringNowSource(() => SNAPSHOT);
    const { stdout, app } = mount(createElement(ExploringNowLine));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(stdout.last()).toContain('Docs gaps');
    app.unmount();
  });
});

describe('exploring-now host feed', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'ethos-tui-explore-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 50)));

  it('a missing initiatives.db gives a blank strip and is never created', async () => {
    const dir = tmp();
    const stop = startExploringNowFeed({
      storage: new FsStorage(),
      dataDir: dir,
      personalityId: 'pm',
    });
    await settle();
    expect(readExploringNow()).toBeNull();
    expect(existsSync(initiativesDbPath(dir))).toBe(false);
    const { stdout, app } = mount(createElement(ExploringNowLine));
    await act(async () => {});
    expect(stdout.last().trim()).toBe('');
    app.unmount();
    stop();
  });

  it('the host registers a source that reads the open window from the store', async () => {
    const dir = tmp();
    const store = new SQLiteInitiativeStore(initiativesDbPath(dir));
    store.upsertInitiative({
      id: 'grow',
      personalityId: 'pm',
      origin: 'human',
      parentId: null,
      state: 'active',
      configPath: join(dir, 'none.yaml'),
      configHash: 'h',
      version: 1,
    });
    const windowId = store.openWindow({
      initiativeId: 'grow',
      explorationId: null,
      kind: 'survey',
    });
    store.close();
    const stop = startExploringNowFeed({
      storage: new FsStorage(),
      dataDir: dir,
      personalityId: 'pm',
    });
    await settle();
    expect(readExploringNow()).toMatchObject({
      windowId,
      initiativeId: 'grow',
      readOnly: true,
    });
    stop();
    expect(readExploringNow()).toBeNull();
  });
});
