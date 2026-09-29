/**
 * plan personality-presence-and-initiative §2 — `display.emoji` beside the
 * name wherever the TUI shows the personality's name: the live StatusBar (via
 * `AppProps.emojiFor`), the HUD's ConsoleHeader and IdentityPanel, and the
 * Splash. The generated mark stays; an unset emoji changes nothing.
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
import { ConsoleHeader } from '../components/ConsoleHeader';
import { IdentityPanel } from '../components/IdentityPanel';
import { Splash } from '../components/Splash';

class CapturingStdout extends EventEmitter {
  columns = 240;
  rows = 40;
  frames: string[] = [];
  write(chunk: string): boolean {
    // Plain text: the header's `role` label is dim, so ANSI codes sit between
    // it and the name.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
    this.frames.push(String(chunk).replace(/\x1b\[[0-9;]*m/g, ''));
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

function makeApp(emojiFor?: (id: string) => string | undefined) {
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
      initialSessionKey: 'cli:tui-identity-emoji',
      readMemory: async () => null,
      ...(emojiFor ? { emojiFor } : {}),
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

/** Render one element and return its last plain-text frame. */
async function frameOf(element: ReturnType<typeof createElement>): Promise<string> {
  const stdout = new CapturingStdout();
  const instance = render(element, {
    stdout: stdout as never,
    stdin: makeStdin() as never,
    stderr: stdout as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await waitFor(() => stdout.frames.length > 0, 'first frame rendered');
    return stdout.frames.at(-1) ?? '';
  } finally {
    instance.unmount();
  }
}

const ACCENT = '#4A9EFF';

describe('TUI — personality emoji', () => {
  it('the live status bar shows the emoji beside the name', async () => {
    const { instance, stdout } = makeApp((id) => (id === 'researcher' ? '🦉' : undefined));
    try {
      await waitFor(
        () => stdout.frames.some((f) => f.includes('stub-model · 🦉 researcher')),
        'the status bar rendered with the emoji',
      );
    } finally {
      instance.unmount();
    }
  });

  it('the status bar is the bare name when no emoji is set', async () => {
    const { instance, stdout } = makeApp(() => undefined);
    try {
      await waitFor(
        () => stdout.frames.some((f) => f.includes('stub-model · researcher')),
        'the status bar rendered',
      );
      expect(stdout.frames.join('\n')).not.toContain('🦉');
    } finally {
      instance.unmount();
    }
  });

  it('ConsoleHeader shows the emoji beside the role, and nothing extra without one', async () => {
    const props = {
      model: 'm',
      personality: 'researcher',
      sessionKey: 'cli:x',
      accentColor: ACCENT,
    };
    expect(await frameOf(createElement(ConsoleHeader, { ...props, emoji: '🦉' }))).toContain(
      'role 🦉 researcher',
    );
    expect(await frameOf(createElement(ConsoleHeader, props))).toContain('role researcher');
  });

  it('IdentityPanel shows the emoji beside the name and still draws the generated mark', async () => {
    const props = {
      personality: 'researcher',
      status: 'idle' as const,
      delegationCount: 0,
      accentColor: ACCENT,
    };
    const frame = await frameOf(createElement(IdentityPanel, { ...props, emoji: '🦉' }));
    expect(frame).toContain('🦉 researcher');
    expect(frame).toMatch(/[▓▒░]/);
    expect(await frameOf(createElement(IdentityPanel, props))).not.toContain('🦉');
  });

  it('Splash shows the emoji beside the name', async () => {
    const inventory = { tools: [], totalTools: 0, personalities: [], skills: [], mcpServers: [] };
    const props = {
      model: 'm',
      personality: 'researcher',
      sessionKey: 'cli:x',
      accentColor: ACCENT,
      inventory,
    };
    expect(await frameOf(createElement(Splash, { ...props, emoji: '🦉' }))).toContain(
      '🦉 researcher',
    );
  });
});
