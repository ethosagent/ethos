/**
 * TUI `/incognito` starts a fresh incognito session (status bar label in the
 * tertiary colour, `incognito` on every send); `/new` ends it, scrubs the old
 * key through the host-injected `endIncognito`, and starts a normal session.
 * Same harness as personality-switch.test.ts. Authored as .test.ts with
 * createElement: the root vitest glob never runs .test.tsx.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AgentBridge } from '@ethosagent/agent-bridge';
import { AgentLoop, InMemorySessionStore } from '@ethosagent/core';
import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { App } from '../components/App';
import { act, enableReactActEnvironment, pressKeys } from './helpers/ink-act';

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 40;
  frames: string[] = [];
  write(chunk: string): boolean {
    this.frames.push(String(chunk));
    return true;
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

function makeStubLLM(): LLMProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

/** Poll until `predicate` holds, or fail after `timeoutMs`. */
async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// Keys and turns are driven inside React's `act` (helpers/ink-act.ts).
enableReactActEnvironment();

describe('TUI incognito', () => {
  it('/incognito labels the status bar and stamps the session; /new scrubs and clears it', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({ llm: makeStubLLM(), session, safety: createTestSafety() });
    const bridge = new AgentBridge(loop);
    const scrubbed: string[] = [];
    const stdout = new FakeStdout();
    const stdin = makeStdin();
    const initialSessionKey = 'cli:tui-incognito-test';
    await act(async () => {
      render(
        createElement(App, {
          bridge,
          model: 'stub-model',
          initialPersonality: 'researcher',
          initialSessionKey,
          readMemory: async () => null,
          endIncognito: async (key: string) => {
            scrubbed.push(key);
            return true;
          },
        }),
        {
          stdout: stdout as never,
          stdin: stdin as never,
          stderr: stdout as never,
          debug: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
    });
    const type = async (text: string) => {
      await pressKeys(stdin, text);
      await pressKeys(stdin, '\r');
    };
    const lastFrame = () => stdout.frames[stdout.frames.length - 1] ?? '';

    expect(lastFrame()).not.toContain('[incognito]');

    await type('/incognito');
    expect(lastFrame()).toContain('[incognito]');
    await type('secret');
    await act(() => bridge.whenIdle());
    await waitFor(async () => (await session.listSessions()).length === 1, 'incognito session');
    const [incognito] = await session.listSessions();
    if (!incognito) throw new Error('expected a session');
    expect(incognito.key).not.toBe(initialSessionKey);
    expect(incognito.metadata).toMatchObject({ incognito: true });

    await type('/new');
    expect(scrubbed).toEqual([incognito.key]);
    expect(lastFrame()).not.toContain('[incognito]');
    await type('plain');
    await act(() => bridge.whenIdle());
    await waitFor(async () => (await session.listSessions()).length === 2, 'normal session');
    const normal = (await session.listSessions()).find((s) => s.key !== incognito.key);
    expect(normal?.metadata?.incognito).toBeUndefined();
  });
});

describe('TUI incognito scrub is awaited and reported', () => {
  async function mount(endIncognito: (key: string) => Promise<boolean>) {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({ llm: makeStubLLM(), session, safety: createTestSafety() });
    const bridge = new AgentBridge(loop);
    const stdout = new FakeStdout();
    const stdin = makeStdin();
    await act(async () => {
      render(
        createElement(App, {
          bridge,
          model: 'stub-model',
          initialPersonality: 'researcher',
          initialSessionKey: 'cli:tui-incognito-scrub',
          readMemory: async () => null,
          endIncognito,
        }),
        {
          stdout: stdout as never,
          stdin: stdin as never,
          stderr: stdout as never,
          debug: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
    });
    const type = async (text: string) => {
      await pressKeys(stdin, text);
      await pressKeys(stdin, '\r');
    };
    const allFrames = () => stdout.frames.join('');
    return { type, allFrames, session, bridge };
  }

  it('/new says so when the scrub did not run (false)', async () => {
    const m = await mount(async () => false);
    await m.type('/incognito');
    await m.type('/new');
    expect(m.allFrames()).toContain('could not clear the incognito history now');
  });

  it('/new says so when the scrub throws, and still starts the new session', async () => {
    const m = await mount(async () => {
      throw new Error('db locked');
    });
    await m.type('/incognito');
    await m.type('/new');
    const frames = m.allFrames();
    expect(frames).toContain('could not clear the incognito history now');
    expect(frames).toContain('[new session started]');
  });

  it('/new is silent about the scrub when it ran', async () => {
    const m = await mount(async () => true);
    await m.type('/incognito');
    await m.type('/new');
    expect(m.allFrames()).not.toContain('could not clear');
  });

  it('/personality on an incognito session scrubs the session it rotates away from', async () => {
    const scrubbed: string[] = [];
    const m = await mount(async (key) => {
      scrubbed.push(key);
      return true;
    });
    await m.type('/incognito');
    await m.type('secret');
    await act(() => m.bridge.whenIdle());
    const [incognito] = await m.session.listSessions();
    if (!incognito) throw new Error('expected a session');
    await m.type('/personality engineer');
    expect(scrubbed).toEqual([incognito.key]);
  });

  it('/personality on a normal session scrubs nothing', async () => {
    const scrubbed: string[] = [];
    const m = await mount(async (key) => {
      scrubbed.push(key);
      return true;
    });
    await m.type('/personality engineer');
    expect(scrubbed).toEqual([]);
  });
});
