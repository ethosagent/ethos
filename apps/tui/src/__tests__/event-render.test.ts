/**
 * TUI-parity slice of plan/phases/ux-feedback-and-config-clarity.md:
 * - C5: the audience gate — only `audience: 'user'` tool progress reaches the
 *   timeline; internal budget warnings stay off screen.
 * - A4: `toolName: '_loop'` progress renders as a one-line yellow notice,
 *   never a tool row.
 * - C2: a failed tool's reason comes from the bridge's trailing `error`
 *   argument, not the result text.
 * - A3: `error` events render title + action (+ trace) from surface-kit's
 *   `describeChatError`.
 * - C5: background completions render the readline branch's completion box
 *   and `bg:N` counts completions until the user next submits input.
 *
 * Driven with a real AgentBridge and a real Ink render; events are emitted on
 * the bridge exactly as `AgentBridge.pump` forwards them.
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
import type { BackgroundJob, CompletionChunk, LLMProvider } from '@ethosagent/types';
import { render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { App } from '../components/App';
import { act, enableReactActEnvironment, pressKeys } from './helpers/ink-act';

enableReactActEnvironment();

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

/** Never called — these tests emit bridge events directly. */
function idleLLM(): LLMProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function makeBridge(): AgentBridge {
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({ id: 'researcher', name: 'R', toolset: [] });
  const loop = new AgentLoop({
    llm: idleLLM(),
    tools: new DefaultToolRegistry(),
    personalities,
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
  });
  return new AgentBridge(loop);
}

function doneJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'job12345-0000-0000-0000-000000000000',
    owner: 'test',
    parentSessionKey: 'cli:parent',
    rootSessionKey: 'cli:parent',
    childSessionKey: 'cli:parent:job:x:job12345',
    depth: 1,
    status: 'done',
    prompt: 'do the thing',
    summary: 'the thing is done',
    spendUsd: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

function setup(extraProps: Record<string, unknown> = {}) {
  const bridge = makeBridge();
  const stdout = new CapturingStdout();
  const stdin = makeStdin();
  const instance = render(
    createElement(App, {
      bridge,
      model: 'stub-model',
      initialPersonality: 'researcher',
      initialSessionKey: 'cli:tui-event-render',
      readMemory: async () => null,
      ...extraProps,
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
  const allFrames = () => stdout.frames.join('\n');
  const lastFrame = () => stdout.frames.at(-1) ?? '';
  return { bridge, stdout, stdin, instance, allFrames, lastFrame };
}

/** Open the activity timeline section (hidden by default). */
async function showActivity(stdin: PassThrough): Promise<void> {
  await pressKeys(stdin, '/details activity expanded');
  await pressKeys(stdin, '\r');
}

describe('TUI event rendering', () => {
  it('gates tool progress on audience and renders _loop as a plain notice (C5, A4)', async () => {
    const { bridge, stdin, instance, allFrames } = setup();
    try {
      await showActivity(stdin);
      await act(async () => {
        bridge.emit('tool_progress', 'bash', 'internal budget warning line', undefined, 'internal');
        bridge.emit('tool_progress', 'bash', 'cloning repo', 42, 'user');
        bridge.emit(
          'tool_progress',
          '_loop',
          'context overflow — compacting and retrying',
          undefined,
          'user',
        );
      });
      const frames = allFrames();
      // C5 — internal progress never reaches the timeline.
      expect(frames).not.toContain('internal budget warning line');
      // user-audience progress renders as a tool row.
      expect(frames).toContain('bash: cloning repo (42%)');
      // A4 — the loop notice is one line, not a `_loop:` tool row.
      expect(frames).toContain('context overflow — compacting and retrying');
      expect(frames).not.toContain('_loop:');
    } finally {
      instance.unmount();
    }
  });

  it('prefers the trailing error argument for a failed tool (C2)', async () => {
    const { bridge, stdin, instance, allFrames } = setup();
    try {
      await showActivity(stdin);
      await act(async () => {
        bridge.emit('tool_start', 't1', 'bash', {}, undefined);
        bridge.emit(
          'tool_end',
          't1',
          'bash',
          false,
          5,
          'raw result text',
          undefined,
          undefined,
          'exit code 1: boom',
        );
      });
      const frames = allFrames();
      expect(frames).toContain('exit code 1: boom');
      expect(frames).not.toContain('raw result text');
    } finally {
      instance.unmount();
    }
  });

  it('renders errors through describeChatError with the run_start trace id (A3)', async () => {
    const { bridge, instance, allFrames } = setup();
    try {
      await act(async () => {
        bridge.emit('run_start', 'anthropic', 'stub-model', 'default', 'trace-abc123');
        bridge.emit('error', 'raw provider message', 'context_overflow');
      });
      const frames = allFrames();
      expect(frames).toContain('✗ conversation too large for the model');
      expect(frames).toContain('→ run /compact to shrink history, or /new to start fresh');
      expect(frames).toContain('trace trace-abc123');
      expect(frames).not.toContain('[context_overflow] raw provider message');
    } finally {
      instance.unmount();
    }
  });

  it('renders the completion box and counts bg:N until the next submit (C5)', async () => {
    let deliver: ((job: BackgroundJob) => void) | undefined;
    const { instance, stdin, allFrames, lastFrame } = setup({
      onBackgroundComplete: (cb: (job: BackgroundJob) => void) => {
        deliver = cb;
        return () => {
          deliver = undefined;
        };
      },
    });
    try {
      expect(deliver).toBeDefined();
      await act(async () => {
        deliver?.(doneJob());
      });
      const frames = allFrames();
      expect(frames).toContain('╭─ background [bg:job12345] done');
      expect(frames).toContain('│ the thing is done');
      expect(lastFrame()).toContain('bg:1');

      // A running job stays silent (only done/failed render).
      await act(async () => {
        deliver?.(doneJob({ id: 'job-running', status: 'running' }));
      });
      expect(allFrames()).not.toContain('job-runn');

      // The user acting at the prompt resets the unseen counter.
      await pressKeys(stdin, '/usage');
      await pressKeys(stdin, '\r');
      expect(lastFrame()).not.toContain('bg:1');
    } finally {
      instance.unmount();
    }
  });
});
