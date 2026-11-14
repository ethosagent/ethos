/**
 * TUI /rewind and Esc Esc backtrack, driven the way a user drives it: real Ink
 * over a fake stdin/stdout, real AgentBridge over a real AgentLoop with an
 * in-memory session store and a stub LLM.
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
import { App, type AppProps } from '../components/App';
import { act, enableReactActEnvironment, pressKeys } from './helpers/ink-act';

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 40;
  frames: string[] = [];
  write(chunk: string): boolean {
    this.frames.push(String(chunk));
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

enableReactActEnvironment();

const POINTS = [
  { turnsBack: 1, messageId: 'm2', text: 'second', hadAttachments: false },
  { turnsBack: 2, messageId: 'm1', text: 'first', hadAttachments: false },
];

async function setup(withRewind: boolean, branches?: AppProps['branches']) {
  const session = new InMemorySessionStore();
  const loop = new AgentLoop({ llm: makeStubLLM(), session, safety: createTestSafety() });
  const bridge = new AgentBridge(loop);
  const sentWith: Array<{ text: string; sessionKey: string }> = [];
  const realSend = bridge.send.bind(bridge);
  bridge.send = ((text: string, opts: { sessionKey: string }) => {
    sentWith.push({ text, sessionKey: opts.sessionKey });
    return realSend(text, opts as never);
  }) as typeof bridge.send;
  const commitCalls: Array<[string, string]> = [];
  const rewind: AppProps['rewind'] = {
    points: async () => POINTS,
    commit: async (key, id) => {
      commitCalls.push([key, id]);
      return { message: 'Rewound', switchTo: { sessionKey: 'cli:proj:fork:x' } };
    },
  };
  const stdout = new FakeStdout();
  const stdin = makeStdin();
  let instance: ReturnType<typeof render> | undefined;
  await act(async () => {
    instance = render(
      createElement(App, {
        bridge,
        model: 'stub-model',
        initialPersonality: 'researcher',
        initialSessionKey: 'cli:proj',
        readMemory: async () => null,
        ...(withRewind ? { rewind } : {}),
        ...(branches ? { branches } : {}),
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
  return { bridge, stdin, stdout, sentWith, commitCalls, unmount: () => instance?.unmount() };
}

const ESC = '\u001B';

describe('TUI rewind', () => {
  it('Esc Esc opens backtrack, Esc steps older, Enter prefills; submit commits then sends on the new key', async () => {
    const { bridge, stdin, stdout, sentWith, commitCalls, unmount } = await setup(true);
    try {
      await pressKeys(stdin, ESC);
      await pressKeys(stdin, ESC);
      expect(stdout.last).toContain('1 back');
      expect(stdout.last).toContain('second');
      await pressKeys(stdin, ESC);
      expect(stdout.last).toContain('2 back');
      await pressKeys(stdin, '\r');
      expect(stdout.last).toContain('first');
      await pressKeys(stdin, ' edited');
      await pressKeys(stdin, '\r');
      await act(() => bridge.whenIdle());
      expect(commitCalls).toEqual([['cli:proj', 'm1']]);
      expect(sentWith.at(-1)).toMatchObject({
        sessionKey: 'cli:proj:fork:x',
        text: 'first edited',
      });
    } finally {
      unmount();
    }
  });

  it('/rewind with no host says rewind is unavailable', async () => {
    const { stdin, stdout, unmount } = await setup(false);
    try {
      await pressKeys(stdin, '/rewind');
      await pressKeys(stdin, '\r');
      expect(stdout.last).toContain('[rewind is not available here]');
    } finally {
      unmount();
    }
  });

  it('/rewind 2 prefills the second-latest prompt', async () => {
    const { stdin, stdout, commitCalls, unmount } = await setup(true);
    try {
      await pressKeys(stdin, '/rewind 2');
      await pressKeys(stdin, '\r');
      expect(stdout.last).toContain('first');
      expect(commitCalls).toEqual([]);
    } finally {
      unmount();
    }
  });

  it('Esc in an empty pending edit cancels the rewind and sends on the old key', async () => {
    const { bridge, stdin, sentWith, commitCalls, unmount } = await setup(true);
    try {
      await pressKeys(stdin, '/rewind');
      await pressKeys(stdin, '\r');
      await pressKeys(stdin, '\u0015'); // Ctrl+U clears the prefill
      await pressKeys(stdin, ESC); // cancels the pending rewind
      await pressKeys(stdin, 'plain');
      await pressKeys(stdin, '\r');
      await act(() => bridge.whenIdle());
      expect(commitCalls).toEqual([]);
      expect(sentWith.at(-1)).toMatchObject({ sessionKey: 'cli:proj', text: 'plain' });
    } finally {
      unmount();
    }
  });

  it('a session switch drops the pending rewind: the next line sends on the new key, no commit', async () => {
    const { bridge, stdin, sentWith, commitCalls, unmount } = await setup(true, async () => ({
      message: 'switched',
      switchTo: { sessionKey: 'cli:proj:fork:other' },
    }));
    try {
      await pressKeys(stdin, '/rewind');
      await pressKeys(stdin, '\r'); // prefills the latest prompt, rewind pending
      await pressKeys(stdin, '\u0015'); // clear the prefill so the next input is ours
      await pressKeys(stdin, '/branch 1');
      await pressKeys(stdin, '\r');
      await pressKeys(stdin, 'plain');
      await pressKeys(stdin, '\r');
      await act(() => bridge.whenIdle());
      expect(commitCalls).toEqual([]);
      expect(sentWith.at(-1)).toMatchObject({ sessionKey: 'cli:proj:fork:other', text: 'plain' });
    } finally {
      unmount();
    }
  });
});
