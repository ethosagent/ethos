/**
 * Plan openclaw-2026.9.6-gaps S4/U1 — a budget `halt` reaches the TUI as a line
 * naming the cap and the reset command (`haltNotice`, @ethosagent/core).
 *
 * Driven end to end: real AgentLoop whose tool reports a cost over the
 * personality's `budgetCapUsd`, real AgentBridge, real Ink render.
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
import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { App } from '../components/App';

class CapturingStdout extends EventEmitter {
  columns = 240;
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

/** Always calls the paid tool; the cap stops the loop after the first batch. */
function toolCallingLLM(): LLMProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'tool_use_start', toolCallId: 't1', toolName: 'paid' };
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

describe('TUI — budget halt', () => {
  it('renders the cap and /budget reset when the session cap stops the turn', async () => {
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'paid',
      description: 'costs money',
      schema: { type: 'object' },
      capabilities: {},
      execute: async () => ({ ok: true, value: 'done', cost_usd: 5 }),
    });
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({ id: 'researcher', name: 'R', toolset: ['paid'], budgetCapUsd: 1 });
    const loop = new AgentLoop({
      llm: toolCallingLLM(),
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
        initialSessionKey: 'cli:tui-budget-halt',
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
      stdin.write('spend');
      await new Promise((r) => setTimeout(r, 30));
      stdin.write('\r');
      await waitFor(
        () => stdout.frames.some((f) => f.includes('/budget reset')),
        'the halt notice rendered',
      );
      const frame = stdout.frames.filter((f) => f.includes('/budget reset')).at(-1) ?? '';
      expect(frame).toContain('$1.00 budget cap');
    } finally {
      instance.unmount();
    }
  });
});
