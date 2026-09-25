// M-D10 — approval fails closed over the MCP export.
//
// There is no human at an MCP transport to answer an approval prompt, so a
// dangerous tool call inside an exported turn must be REJECTED: not queued
// (which hangs the caller forever), and not waved through (which hands an
// external client exactly the tools the operator asked to be consulted about).
//
// This drives a real `AgentLoop` rather than the hook handler alone, because
// "rejected" and "not run" are two different claims and only the loop can
// settle the second: `stages/per-call-enforcement.ts` is what must keep a
// refused call out of `executeParallel`.

import { AgentLoop, DefaultToolRegistry } from '@ethosagent/core';
import type {
  AgentSafety,
  CompletionChunk,
  LLMProvider,
  PersonalityRegistry,
  Storage,
} from '@ethosagent/types';
import { APPROVAL_SURFACE_ALWAYS_ASK, createApprovalDangerPredicate } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { createExportApprovalGate, exportApprovalRejection } from '../mcp-export';

/**
 * The safety bundle a loop needs, stubbed down to identity functions. Nothing
 * under test here reads the injection or redaction kits; the field that matters
 * is `approvalPosture: 'gated'`, which is what every wiring-built loop declares
 * and what makes core verify a `before_tool_call` handler exists at all.
 */
function gatedSafety(): AgentSafety {
  return {
    injection: {
      prelude: '',
      downgradeRejectionMessage: 'refused',
      sanitize: (content) => content,
      wrapUntrusted: (input) => ({ content: input.content, strippedTokens: 0 }),
      shortPatternCheck: () => ({ containsInstructions: false, hits: [] }),
      c2PatternCheck: () => ({ containsInstructions: false }),
      resolveDowngradedTools: () => new Set<string>(),
    },
    redaction: {
      redactPii: (text) => text,
      redactString: (text) => text,
      detectSecrets: () => [],
    },
    scopedStorageFactory: (base: Storage) => base,
    approvalPosture: { kind: 'gated', policy: 'danger-predicate' },
  };
}

/** One tool call on the first pass, plain text on the second. */
function llmCalling(toolName: string, args: unknown): LLMProvider {
  let round = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      round += 1;
      if (round === 1) {
        yield { type: 'tool_use_start', toolCallId: 't1', toolName };
        yield { type: 'tool_use_end', toolCallId: 't1', inputJson: JSON.stringify(args) };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'I cannot do that over this connection.' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 10;
    },
  };
}

async function runExportedTurn(toolName: string): Promise<{
  ran: boolean;
  toolEndErrors: string[];
}> {
  let ran = false;
  const tools = new DefaultToolRegistry();
  tools.register({
    name: toolName,
    description: 'a tool the operator wants to be asked about',
    schema: { type: 'object' },
    capabilities: {},
    async execute() {
      ran = true;
      return { ok: true as const, value: 'did the thing' };
    },
  });

  const loop = new AgentLoop({
    llm: llmCalling(toolName, { to: 'someone' }),
    safety: gatedSafety(),
    tools,
  });

  // Exactly what `runServeExport` wires (apps/ethos/src/commands/mcp.ts).
  const danger = createApprovalDangerPredicate({
    executionPostureFor: () => undefined,
    hooks: [loop.hooks],
    personalities: { get: () => undefined } as unknown as PersonalityRegistry,
    getProvider: async () => {
      throw new Error('the smart reviewer must not be constructed');
    },
    model: 'mock-model',
    alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK,
  });
  loop.hooks.registerModifying('before_tool_call', createExportApprovalGate(danger));

  const toolEndErrors: string[] = [];
  for await (const event of loop.run('please do the thing')) {
    if (event.type === 'tool_end' && event.error) toolEndErrors.push(event.error);
  }
  return { ran, toolEndErrors };
}

describe('MCP export — a dangerous tool is rejected, not run (M-D10)', () => {
  it('refuses a tool on APPROVAL_SURFACE_ALWAYS_ASK and never executes it', async () => {
    const { ran, toolEndErrors } = await runExportedTurn('call');
    expect(ran).toBe(false);
    expect(toolEndErrors.join('\n')).toContain('requires approval; unavailable over MCP export');
  });

  it('lets an unflagged tool through — the gate refuses danger, not everything', async () => {
    const { ran, toolEndErrors } = await runExportedTurn('read_file');
    expect(ran).toBe(true);
    expect(toolEndErrors).toEqual([]);
  });

  it('names the tool and the reason, so the agent can tell its caller why', () => {
    expect(exportApprovalRejection('call', 'call requires explicit approval')).toBe(
      'call requires approval; unavailable over MCP export (call requires explicit approval)',
    );
  });
});
