// `safety.observability.storeToolBodies` is parsed and validated
// (`buildSafetyConfig`, extensions/personalities/src/index.ts) but RESERVED:
// no write path stores a tool's result body. The tool_call span is opened with
// the (redaction-governed) args and closed with `result_size_bytes` and
// `durationMs` only (`processTools`,
// packages/core/src/agent-loop/stages/tool-processing.ts). This test pins that
// fact, so the "reserved" wording on `PersonalityObservabilityConfig` and in
// the character sheet stays true — and so wiring the knob later is a
// deliberate change that has to update this test.

import type {
  AgentEvent,
  CompletionChunk,
  LLMProvider,
  PersonalityObservabilityConfig,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

const BODY = 'TOOL-RESULT-BODY-7f3a9c';

function toolThenTextLLM(): LLMProvider {
  let round = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      round++;
      if (round === 1) {
        yield { type: 'tool_use_start', toolCallId: 't1', toolName: 'echo_body' };
        yield { type: 'tool_use_end', toolCallId: 't1', inputJson: '{}' };
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

describe('storeToolBodies is reserved — no tool result body reaches observability', () => {
  it.each<PersonalityObservabilityConfig['storeToolBodies']>(['full', 'redacted', 'none'])(
    'storeToolBodies: %s writes no result body into the tool span',
    async (level) => {
      const written: unknown[] = [];
      const observability: AgentLoopObservability = {
        startTurnTrace: () => 'trace-1',
        endTrace: () => {},
        startSpan: (opts) => {
          written.push(opts.attrs);
          return 'span-1';
        },
        endSpan: (_id, _status, attrs) => {
          written.push(attrs);
        },
        recordSafetyBlock: () => {},
        recordCompaction: () => {},
        recordTierEscalation: () => {},
        recordTierOverride: () => {},
        flush: () => {},
      };

      const tools = new DefaultToolRegistry();
      tools.register({
        name: 'echo_body',
        description: 'returns a recognisable body',
        schema: { type: 'object' },
        capabilities: {},
        async execute(): Promise<ToolResult> {
          return { ok: true, value: BODY };
        },
      });
      const personalities = new DefaultPersonalityRegistry();
      personalities.define({
        id: 'default',
        name: 'Default',
        safety: { observability: { storeToolArgs: 'full', storeToolBodies: level } },
      });
      personalities.setDefault('default');

      const loop = new AgentLoop({
        llm: toolThenTextLLM(),
        tools,
        personalities,
        session: new InMemorySessionStore(),
        safety: createTestSafety(),
        observability,
      });
      const events: AgentEvent[] = [];
      for await (const e of loop.run('go', { sessionKey: 'cli:bodies' })) events.push(e);

      // The tool really ran and returned the body, so absence below is meaningful.
      expect(events.some((e) => e.type === 'tool_end' && e.ok)).toBe(true);
      expect(written.length).toBeGreaterThan(0);
      expect(JSON.stringify(written)).not.toContain(BODY);
    },
  );
});
