/**
 * B2 (plan ux-feedback-and-config-clarity §4) — config parse warnings reach
 * the TUI. The host passes `TUIOptions.startupNotices` (the same lines the
 * readline branch prints) and the App renders each once on mount as a dim
 * system line, plus a 'warning' timeline entry.
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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function makeApp(startupNotices?: string[]) {
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({ id: 'researcher', name: 'R', toolset: [] });
  const loop = new AgentLoop({
    llm: makeStubLLM(),
    tools: new DefaultToolRegistry(),
    personalities,
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
  });
  const bridge = new AgentBridge(loop);
  const stdout = new CapturingStdout();
  const instance = render(
    createElement(App, {
      bridge,
      model: 'stub-model',
      initialPersonality: 'researcher',
      initialSessionKey: 'cli:tui-startup-notices',
      readMemory: async () => null,
      ...(startupNotices ? { startupNotices } : {}),
    }),
    {
      stdout: stdout as never,
      stdin: makeStdin() as never,
      stderr: stdout as never,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  return { instance, stdout };
}

describe('TUI — startup notices (B2)', () => {
  it('renders each startupNotices line on mount', async () => {
    const lines = [
      "config.yaml:5 unknown key 'personalty' — did you mean 'personality'?",
      "config.yaml:6 'telegramBotToken' is deprecated",
    ];
    const { instance, stdout } = makeApp(lines);
    try {
      await waitFor(
        () => stdout.frames.some((f) => f.includes("unknown key 'personalty'")),
        'the first warning line rendered',
      );
      const frame =
        stdout.frames.filter((f) => f.includes("unknown key 'personalty'")).at(-1) ?? '';
      for (const line of lines) expect(frame).toContain(line);
    } finally {
      instance.unmount();
    }
  });

  it('renders nothing extra when no notices are passed', async () => {
    const { instance, stdout } = makeApp();
    try {
      await waitFor(() => stdout.frames.length > 0, 'first frame rendered');
      // Give mount effects a beat, then check no warning-looking line appeared.
      await new Promise((r) => setTimeout(r, 50));
      expect(stdout.frames.join('\n')).not.toContain('unknown key');
    } finally {
      instance.unmount();
    }
  });
});
