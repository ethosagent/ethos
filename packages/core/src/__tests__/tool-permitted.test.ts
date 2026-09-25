// `AgentLoop.isToolPermitted` — the personality allowlist a turn's tool calls
// are executed under (`DefaultToolRegistry.executeParallel` refuses a call
// outside it), asked BEFORE a call runs, so an approval surface can refuse a
// call that would be refused anyway instead of asking a human about it
// (`notPermittedRefusal`, packages/wiring/src/approval-seams.ts).

import type { CompletionChunk, LLMProvider, Tool } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

function tool(name: string): Tool {
  return {
    name,
    description: name,
    schema: { type: 'object' },
    capabilities: {},
    execute: async () => ({ ok: true, value: '' }),
  };
}

const llm: LLMProvider = {
  name: 'stub',
  model: 'stub',
  maxContextTokens: 1000,
  supportsCaching: false,
  supportsThinking: false,
  async *complete(): AsyncIterable<CompletionChunk> {
    yield { type: 'done', finishReason: 'end_turn' };
  },
  async countTokens() {
    return 1;
  },
};

function loop() {
  const tools = new DefaultToolRegistry();
  tools.register(tool('terminal'));
  tools.register(tool('read_file'));
  tools.register(tool('mcp__github__create_issue'));
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({
    id: 'narrow',
    name: 'Narrow',
    toolset: ['read_file'],
    mcp_servers: ['github'],
  });
  personalities.define({ id: 'open', name: 'Open' });
  return new AgentLoop({
    llm,
    tools,
    personalities,
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
  });
}

describe('AgentLoop.isToolPermitted', () => {
  it('refuses a built-in tool outside the personality toolset', () => {
    expect(loop().isToolPermitted('terminal', 'narrow')).toBe(false);
    expect(loop().isToolPermitted('read_file', 'narrow')).toBe(true);
  });

  it('permits every registered tool when the personality declares no toolset', () => {
    expect(loop().isToolPermitted('terminal', 'open')).toBe(true);
  });

  it('gates MCP tools by the personality mcp_servers, not the toolset', () => {
    expect(loop().isToolPermitted('mcp__github__create_issue', 'narrow')).toBe(true);
    expect(loop().isToolPermitted('mcp__github__create_issue', 'open')).toBe(false);
  });

  it('refuses a tool that is not registered at all', () => {
    expect(loop().isToolPermitted('no_such_tool', 'open')).toBe(false);
  });
});
