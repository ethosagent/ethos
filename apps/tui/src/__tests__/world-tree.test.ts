/**
 * plan world-model 7.8: `/world <slug>` draws the world's org tree in a panel. The text is the
 * shared `renderTree` (extensions/world-service/src/render-tree.ts, reached here through
 * `worldOwner` in @ethosagent/wiring), the same string `ethos world show --tree` prints, so the
 * panel never formats a tree itself. A `shared` lane lists and opens only `shareable` worlds.
 * Driven with a real Ink render and a real AgentBridge.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AgentBridge } from '@ethosagent/agent-bridge';
import {
  AgentLoop,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import type { GraphBundle, LLMProvider, WorldId } from '@ethosagent/types';
import { worldOwner } from '@ethosagent/wiring';
import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { App } from '../components/App';
import {
  visibleWorlds,
  type WorldChoice,
  WorldTreePanel,
  type WorldTreeSource,
} from '../components/WorldTreePanel';
import { act, enableReactActEnvironment, pressKeys } from './helpers/ink-act';

const world: WorldId = 'world:acme';
const base = { world, recordedAt: '2026-11-01T00:00:00Z', retiredAt: null, sourceRef: 't' };
const BUNDLE: GraphBundle = {
  schema: null,
  attributes: [],
  entities: [
    {
      ...base,
      id: 'c',
      type: 'Company',
      name: 'Acme',
      aliases: [],
      author: 'user',
      mergedInto: null,
    },
    {
      ...base,
      id: 't',
      type: 'Team',
      name: 'Platform',
      aliases: [],
      author: 'user',
      mergedInto: null,
    },
    {
      ...base,
      id: 'p',
      type: 'Person',
      name: 'Mei',
      aliases: [],
      author: 'user',
      mergedInto: null,
    },
  ],
  edges: [
    {
      ...base,
      id: 'e1',
      type: 'part_of',
      fromId: 't',
      toId: 'c',
      attrs: {},
      validFrom: null,
      validTo: null,
      author: 'user',
      confidence: 1,
    },
    {
      ...base,
      id: 'e2',
      type: 'member_of',
      fromId: 'p',
      toId: 't',
      attrs: { role: 'lead' },
      validFrom: null,
      validTo: null,
      author: 'user',
      confidence: 1,
    },
  ],
};
const TREE = worldOwner.renderTree(BUNDLE);

const WORLDS: WorldChoice[] = [
  { slug: 'acme', title: 'Acme company', audience: 'owner_only' },
  { slug: 'stocks', title: 'Watchlist', audience: 'shareable' },
];

class CapturingStdout extends EventEmitter {
  columns = 240;
  rows = 40;
  frames: string[] = [];
  write(chunk: string): boolean {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
    this.frames.push(String(chunk).replace(/\x1b\[[0-9;]*m/g, ''));
    return true;
  }
  get last(): string {
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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) u();
});
enableReactActEnvironment();

function renderOptions(stdout: CapturingStdout, stdin: ReturnType<typeof makeStdin>) {
  return {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: stdout as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  };
}

function mountApp(lane: WorldTreeSource['lane']) {
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({ id: 'researcher', name: 'R', toolset: [] });
  const loop = new AgentLoop({
    llm: { name: 'stub', model: 'stub-model' } as LLMProvider,
    tools: new DefaultToolRegistry(),
    personalities,
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
  });
  const opened: string[] = [];
  const worlds: WorldTreeSource = {
    lane,
    list: async () => WORLDS,
    tree: async (slug) => {
      opened.push(slug);
      return TREE;
    },
  };
  const stdout = new CapturingStdout();
  const stdin = makeStdin();
  const instance = render(
    createElement(App, {
      bridge: new AgentBridge(loop),
      model: 'stub-model',
      initialPersonality: 'researcher',
      initialSessionKey: 'cli:tui-world',
      readMemory: async () => null,
      worlds,
    }),
    renderOptions(stdout, stdin),
  );
  unmounts.push(() => instance.unmount());
  return { stdout, stdin, opened };
}

async function typeCommand(stdin: ReturnType<typeof makeStdin>, text: string): Promise<void> {
  await pressKeys(stdin, text);
  await pressKeys(stdin, '\r');
}

describe('TUI world tree', () => {
  it('panel renders renderTree output', async () => {
    const stdout = new CapturingStdout();
    const instance = render(
      createElement(WorldTreePanel, { slug: 'acme', title: 'Acme company', text: TREE }),
      renderOptions(stdout, makeStdin()),
    );
    unmounts.push(() => instance.unmount());
    await waitFor(() => stdout.last.includes('Acme (Company)'), 'the tree');
    for (const line of TREE.split('\n')) expect(stdout.last).toContain(line);
    expect(stdout.last).toContain('world acme - Acme company');
  });

  it('/world <slug> opens the panel with the host tree text', async () => {
    let m: ReturnType<typeof mountApp> | undefined;
    await act(async () => {
      m = mountApp('owner');
    });
    if (!m) throw new Error('mount did not run');
    await typeCommand(m.stdin, '/world acme');
    await waitFor(() => m?.stdout.last.includes('Mei (Person) - lead') === true, 'the panel');
    expect(m.opened).toEqual(['acme']);
    expect(m.stdout.last).toContain('world acme - Acme company');
  });

  it('shared lane shows only shareable worlds', async () => {
    expect(visibleWorlds(WORLDS, 'owner').map((w) => w.slug)).toEqual(['acme', 'stocks']);
    expect(visibleWorlds(WORLDS, 'shared').map((w) => w.slug)).toEqual(['stocks']);

    let m: ReturnType<typeof mountApp> | undefined;
    await act(async () => {
      m = mountApp('shared');
    });
    if (!m) throw new Error('mount did not run');
    await typeCommand(m.stdin, '/world acme');
    await waitFor(() => m?.stdout.last.includes('[no world acme here]') === true, 'the refusal');
    expect(m.opened).toEqual([]);
    expect(m.stdout.last).not.toContain('Mei (Person)');
  });
});
