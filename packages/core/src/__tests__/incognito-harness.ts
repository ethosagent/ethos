import type {
  CompletionChunk,
  LLMProvider,
  MemoryEntry,
  MemoryProvider,
  MemorySnapshot,
  Message,
  PersonalityConfig,
  Tool,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

export async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

export interface Call {
  tools: string[];
}

/** Records each call's tool names; when `attempt` is set the first call asks for that tool. */
export function recordingLLM(calls: Call[], attempt?: string): LLMProvider {
  let n = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_m: Message[], tools: ToolDefinitionLite[]): AsyncIterable<CompletionChunk> {
      calls.push({ tools: tools.map((t) => t.name) });
      if (attempt && n++ === 0) {
        yield { type: 'tool_use_start', toolCallId: 'c1', toolName: attempt };
        yield { type: 'tool_use_end', toolCallId: 'c1', inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

export function spyMemory(): MemoryProvider & {
  calls: { prefetch: number; read: number; search: number; sync: number };
} {
  const calls = { prefetch: 0, read: 0, search: 0, sync: 0 };
  return {
    calls,
    async prefetch(): Promise<MemorySnapshot | null> {
      calls.prefetch++;
      return { entries: [{ key: 'MEMORY.md', content: 'canary: interview at ACME' }] };
    },
    async read(key: string): Promise<MemoryEntry | null> {
      calls.read++;
      return { key, content: 'The user prefers terse answers.' };
    },
    async search() {
      calls.search++;
      return [{ key: 'NOTE.md', content: 'hit' }];
    },
    async sync() {
      calls.sync++;
    },
    async list() {
      return [];
    },
  };
}

export function personalities(toolset: string[], extra: Partial<PersonalityConfig> = {}) {
  const reg = new DefaultPersonalityRegistry();
  vi.spyOn(reg, 'getDefault').mockReturnValue({ id: 'lean', name: 'Lean', toolset, ...extra });
  return reg;
}

export const WATCHED = [
  'memory_read',
  'memory_write',
  'session_list_by_date',
  'dashboard_add_panel',
  'terminal',
  'run_code',
  'process_start',
  'session_search',
];

export function registry(runs: string[]): DefaultToolRegistry {
  const tools = new DefaultToolRegistry();
  for (const name of WATCHED) {
    const t: Tool = {
      name,
      description: name,
      toolset: 'test',
      capabilities: {},
      schema: { type: 'object', properties: {} },
      async execute() {
        runs.push(name);
        return { ok: true, value: 'ok' };
      },
    };
    tools.register(t);
  }
  return tools;
}

export function build(opts: { attempt?: string; observability?: AgentLoopObservability } = {}) {
  const memory = spyMemory();
  const calls: Call[] = [];
  const runs: string[] = [];
  const session = new InMemorySessionStore();
  const loop = new AgentLoop({
    llm: recordingLLM(calls, opts.attempt),
    personalities: personalities(WATCHED),
    tools: registry(runs),
    session,
    safety: createTestSafety(),
    memory,
    memoryConsolidation: { enabled: true, flushThreshold: 0.0001, minMessagesSinceFlush: 1 },
    ...(opts.observability ? { observability: opts.observability } : {}),
  });
  return { loop, memory, calls, runs, session };
}

export const METADATA_INCOGNITO = { roomAudience: 'shared', incognito: true };
