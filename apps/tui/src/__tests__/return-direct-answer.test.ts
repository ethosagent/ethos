/**
 * A `returnDirect` tool's answer reaches a turn only as `done.text`, after any
 * preamble the model streamed before calling the tool. The TUI committed the raw
 * `done.text` and dropped the streamed preamble; every other surface composes
 * the whole reply with `answerSuffix` (@ethosagent/types).
 *
 * Driven the way a user drives it: real Ink render over a fake stdin/stdout,
 * real AgentBridge over a real AgentLoop with a returnDirect tool.
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
import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { App } from '../components/App';

class CapturingStdout extends EventEmitter {
  columns = 120;
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

/** Streams a preamble, then calls the returnDirect tool. */
function preambleThenToolLLM(): LLMProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      const last = messages.at(-1);
      const seen = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
      if (seen.includes('tool_result')) {
        yield { type: 'text_delta', text: 'never reached' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      yield { type: 'text_delta', text: 'Let me look that up. ' };
      yield { type: 'tool_use_start', toolCallId: 't1', toolName: 'lookup' };
      yield { type: 'tool_use_end', toolCallId: 't1', inputJson: '{}' };
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe('TUI — a returnDirect answer after a streamed preamble', () => {
  it('commits both the preamble and the answer', async () => {
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'lookup',
      description: 'answers directly',
      schema: { type: 'object' },
      capabilities: {},
      returnDirect: true,
      execute: async () => ({ ok: true, value: 'DIRECT ANSWER' }),
    });
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({ id: 'researcher', name: 'R', toolset: ['lookup'] });
    const loop = new AgentLoop({
      llm: preambleThenToolLLM(),
      tools,
      personalities,
      session: new InMemorySessionStore(),
      safety: createTestSafety(),
    });
    const bridge = new AgentBridge(loop);

    const stdout = new CapturingStdout();
    const stdin = makeStdin();
    const instance = render(
      createElement(App, {
        bridge,
        model: 'stub-model',
        initialPersonality: 'researcher',
        initialSessionKey: 'cli:tui-return-direct',
        readMemory: async () => null,
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

    try {
      stdin.write('look it up');
      await new Promise((r) => setTimeout(r, 30));
      stdin.write('\r');
      await waitFor(
        () => stdout.frames.some((f) => f.includes('DIRECT ANSWER')),
        'the answer rendered',
      );
      const withAnswer = stdout.frames.filter((f) => f.includes('DIRECT ANSWER')).at(-1) ?? '';
      // The preamble the user already watched stream is still there.
      expect(withAnswer).toContain('Let me look that up.');
    } finally {
      instance.unmount();
    }
  });
});
