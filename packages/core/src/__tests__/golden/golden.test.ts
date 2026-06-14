import { join } from 'node:path';
import { describe, it } from 'vitest';
import { DefaultHookRegistry } from '../../hook-registry';
import { assertGolden, runGoldenScenario } from './golden-harness';
import { makeTool, makeUntrustedTool } from './scripted-llm';

const FIXTURES = join(import.meta.dirname, 'fixtures');

describe('Golden characterization tests', () => {
  it('plain-text-turn', async () => {
    const result = await runGoldenScenario({
      name: 'plain-text-turn',
      text: 'hello',
      steps: [{ text: 'Hi there!', finishReason: 'end_turn' }],
    });
    assertGolden(result, join(FIXTURES, 'plain-text-turn.json'));
  });

  it('single-tool-call', async () => {
    const result = await runGoldenScenario({
      name: 'single-tool-call',
      text: 'use the tool',
      tools: [makeTool('greet', 'hello world')],
      steps: [
        {
          toolCalls: [{ id: 'tc1', name: 'greet', input: { name: 'Alice' } }],
          finishReason: 'tool_use',
        },
        { text: 'The tool said hello world', finishReason: 'end_turn' },
      ],
    });
    assertGolden(result, join(FIXTURES, 'single-tool-call.json'));
  });

  it('multi-tool-single-batch', async () => {
    const result = await runGoldenScenario({
      name: 'multi-tool-single-batch',
      text: 'use both tools',
      tools: [makeTool('alpha', 'a-result'), makeTool('beta', 'b-result')],
      steps: [
        {
          toolCalls: [
            { id: 'tc1', name: 'alpha', input: {} },
            { id: 'tc2', name: 'beta', input: {} },
          ],
          finishReason: 'tool_use',
        },
        { text: 'Both tools ran', finishReason: 'end_turn' },
      ],
    });
    assertGolden(result, join(FIXTURES, 'multi-tool-single-batch.json'));
  });

  it('multi-iteration-tool-chain', async () => {
    const result = await runGoldenScenario({
      name: 'multi-iteration-tool-chain',
      text: 'chain tools',
      tools: [makeTool('first', 'first-result'), makeTool('second', 'second-result')],
      steps: [
        {
          toolCalls: [{ id: 'tc1', name: 'first', input: {} }],
          finishReason: 'tool_use',
        },
        {
          toolCalls: [{ id: 'tc2', name: 'second', input: {} }],
          finishReason: 'tool_use',
        },
        { text: 'Chained both tools', finishReason: 'end_turn' },
      ],
    });
    assertGolden(result, join(FIXTURES, 'multi-iteration-tool-chain.json'));
  });

  it('hook-rejected-tool', async () => {
    const hooks = new DefaultHookRegistry();
    hooks.registerModifying('before_tool_call', async () => ({
      error: 'blocked by policy',
    }));
    const result = await runGoldenScenario({
      name: 'hook-rejected-tool',
      text: 'use the tool',
      tools: [makeTool('restricted', 'should not see this')],
      config: { hooks },
      steps: [
        {
          toolCalls: [{ id: 'tc1', name: 'restricted', input: {} }],
          finishReason: 'tool_use',
        },
        { text: 'Tool was blocked', finishReason: 'end_turn' },
      ],
    });
    assertGolden(result, join(FIXTURES, 'hook-rejected-tool.json'));
  });

  it('untrusted-tool-wrapping', async () => {
    const result = await runGoldenScenario({
      name: 'untrusted-tool-wrapping',
      text: 'read a file',
      tools: [makeUntrustedTool('read_file', 'file contents here')],
      steps: [
        {
          toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: '/etc/hosts' } }],
          finishReason: 'tool_use',
        },
        { text: 'Read the file', finishReason: 'end_turn' },
      ],
    });
    assertGolden(result, join(FIXTURES, 'untrusted-tool-wrapping.json'));
  });

  it('budget-cap-refusal', async () => {
    const result = await runGoldenScenario({
      name: 'budget-cap-refusal',
      text: 'do something',
      personality: { budgetCapUsd: 0 },
      steps: [],
    });
    assertGolden(result, join(FIXTURES, 'budget-cap-refusal.json'));
  });

  it('tool-budget-break', async () => {
    const result = await runGoldenScenario({
      name: 'tool-budget-break',
      text: 'use tools',
      tools: [makeTool('do_thing', 'done')],
      config: {
        options: { maxToolCallsPerTurn: 1 },
      },
      steps: [
        {
          toolCalls: [{ id: 'tc1', name: 'do_thing', input: {} }],
          finishReason: 'tool_use',
        },
        {
          toolCalls: [{ id: 'tc2', name: 'do_thing', input: {} }],
          finishReason: 'tool_use',
        },
        { text: 'Done', finishReason: 'end_turn' },
      ],
    });
    assertGolden(result, join(FIXTURES, 'tool-budget-break.json'));
  });

  it('llm-error', async () => {
    const result = await runGoldenScenario({
      name: 'llm-error',
      text: 'trigger error',
      steps: [{ throwError: 'API rate limit exceeded' }],
    });
    assertGolden(result, join(FIXTURES, 'llm-error.json'));
  });

  it('abort-mid-stream', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runGoldenScenario({
      name: 'abort-mid-stream',
      text: 'should abort',
      runOptions: { abortSignal: controller.signal },
      steps: [{ text: 'should not see this' }],
    });
    assertGolden(result, join(FIXTURES, 'abort-mid-stream.json'));
  });

  it('dry-run', async () => {
    const result = await runGoldenScenario({
      name: 'dry-run',
      text: 'plan the operation',
      tools: [makeTool('read_file', '[dry-run] read_file stub')],
      runOptions: { dryRun: true },
      steps: [
        {
          toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: '/tmp/x' } }],
          finishReason: 'tool_use',
        },
        { text: 'I would read the file', finishReason: 'end_turn' },
      ],
    });
    assertGolden(result, join(FIXTURES, 'dry-run.json'));
  });

  it('return-direct', async () => {
    const result = await runGoldenScenario({
      name: 'return-direct',
      text: 'use the direct tool',
      tools: [makeTool('quick', 'direct-answer', { returnDirect: true })],
      steps: [
        {
          toolCalls: [{ id: 'tc1', name: 'quick', input: {} }],
          finishReason: 'tool_use',
        },
        { text: 'should not see this', finishReason: 'end_turn' },
      ],
    });
    assertGolden(result, join(FIXTURES, 'return-direct.json'));
  });
});
