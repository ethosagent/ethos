import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMesh } from '@ethosagent/agent-mesh';
import type { AgentEvent } from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ToolContext } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDelegateTaskTool,
  createDelegationTools,
  createDispatchTeamTool,
  createListTeamTool,
  createMixtureOfAgentsTool,
  createRouteToAgentTool,
} from '../index';

// ---------------------------------------------------------------------------
// Mock AgentLoop
// ---------------------------------------------------------------------------

function makeLoop(responses: Record<string, string> = {}) {
  const defaultResponse = 'Sub-agent completed the task.';

  return {
    run: async function* (prompt: string): AsyncGenerator<AgentEvent> {
      // Return a response keyed by a keyword in the prompt, or default
      const key = Object.keys(responses).find((k) => prompt.includes(k));
      const text = key ? responses[key] : defaultResponse;
      yield { type: 'text_delta', text };
      yield { type: 'done', text, turnCount: 1 };
    },
  } as unknown as import('@ethosagent/core').AgentLoop;
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'parent-session',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    agentId: 'depth:0',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    ...overrides,
  };
}

const storage = new FsStorage();
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeRegistryPath(): string {
  const dir = join(
    tmpdir(),
    `ethos-delegation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return join(dir, 'registry.json');
}

// ---------------------------------------------------------------------------
// delegate_task
// ---------------------------------------------------------------------------

describe('delegate_task', () => {
  it('runs a sub-agent and returns its output', async () => {
    const loop = makeLoop({ summarise: 'Here is the summary.' });
    const tool = createDelegateTaskTool(loop);

    const result = await tool.execute({ prompt: 'Please summarise this text.' }, makeCtx());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('summary');
  });

  it('includes label in output when provided', async () => {
    const loop = makeLoop();
    const tool = createDelegateTaskTool(loop);

    const result = await tool.execute(
      { prompt: 'Do something.', label: 'Research Task' },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('[Research Task]');
  });

  it('returns input_invalid when prompt is missing', async () => {
    const tool = createDelegateTaskTool(makeLoop());
    const result = await tool.execute({}, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('blocks delegation when max depth is reached', async () => {
    const tool = createDelegateTaskTool(makeLoop());
    const result = await tool.execute(
      { prompt: 'Do something.' },
      makeCtx({ agentId: 'depth:3' }), // at max depth
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Maximum spawn depth');
      expect(result.code).toBe('execution_failed');
    }
  });

  it('uses the session key from parent context', async () => {
    const sessionKeys: string[] = [];
    const loop = {
      run: async function* (
        _prompt: string,
        opts: { sessionKey?: string },
      ): AsyncGenerator<AgentEvent> {
        sessionKeys.push(opts.sessionKey ?? '');
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', text: 'done', turnCount: 1 };
      },
    } as unknown as import('@ethosagent/core').AgentLoop;

    const tool = createDelegateTaskTool(loop);
    await tool.execute({ prompt: 'task', label: 'my-task' }, makeCtx({ sessionKey: 'cli:abc' }));

    expect(sessionKeys[0]).toContain('cli:abc');
    expect(sessionKeys[0]).toContain('my-task');
  });

  it('threads spawn depth into child loops via agentId', async () => {
    const seenAgentIds: Array<string | undefined> = [];
    const loop = {
      run: async function* (
        _prompt: string,
        opts: { agentId?: string },
      ): AsyncGenerator<AgentEvent> {
        seenAgentIds.push(opts.agentId);
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', text: 'ok', turnCount: 1 };
      },
    } as unknown as import('@ethosagent/core').AgentLoop;

    const tool = createDelegateTaskTool(loop);

    // Parent at depth 0 spawns a child → child loop should run at depth:1
    await tool.execute({ prompt: 'task' }, makeCtx({ agentId: 'depth:0' }));
    expect(seenAgentIds[0]).toBe('depth:1');

    // Parent at depth 1 spawns a child → child loop should run at depth:2
    await tool.execute({ prompt: 'task' }, makeCtx({ agentId: 'depth:1' }));
    expect(seenAgentIds[1]).toBe('depth:2');
  });

  it('return_mode full (default) returns the full child output capped at 20k', async () => {
    const big = 'x'.repeat(50_000);
    const loop = makeLoop({ 'Do it.': big });
    const tool = createDelegateTaskTool(loop);

    const defaultResult = await tool.execute({ prompt: 'Do it.' }, makeCtx());
    const explicitResult = await tool.execute({ prompt: 'Do it.', return_mode: 'full' }, makeCtx());

    expect(defaultResult.ok).toBe(true);
    expect(explicitResult.ok).toBe(true);
    if (defaultResult.ok && explicitResult.ok) {
      // execute() returns the raw full output; executeParallel applies the 20k cap.
      expect(defaultResult.value).toBe(big);
      expect(defaultResult.value).toBe(explicitResult.value);
    }
  });

  it('summary-mode prompt appends the end-with-a-summary instruction; full-mode does not', async () => {
    const prompts: string[] = [];
    const loop = {
      run: async function* (prompt: string): AsyncGenerator<AgentEvent> {
        prompts.push(prompt);
        yield { type: 'text_delta', text: '## Summary\nDone.' };
        yield { type: 'done', text: '## Summary\nDone.', turnCount: 1 };
      },
    } as unknown as import('@ethosagent/core').AgentLoop;

    const tool = createDelegateTaskTool(loop);
    await tool.execute({ prompt: 'Task A.', return_mode: 'summary' }, makeCtx());
    await tool.execute({ prompt: 'Task B.', return_mode: 'full' }, makeCtx());

    expect(prompts[0]).toContain('## Summary');
    expect(prompts[0]).toContain('read ONLY this Summary section');
    expect(prompts[1]).toBe('Task B.');
    expect(prompts[1]).not.toContain('read ONLY this Summary section');
  });

  it('summary mode returns only the ## Summary section content, ≤2000 chars', async () => {
    const childText =
      '# Report\n\nLots of detailed reasoning here that should be dropped.\n\n' +
      '## Summary\nBuilt the widget and shipped it. Key result: 42.\n\n' +
      '## Appendix\nMore noise that should not be returned.';
    const loop = makeLoop({ 'Build it.': childText });
    const tool = createDelegateTaskTool(loop);

    const result = await tool.execute({ prompt: 'Build it.', return_mode: 'summary' }, makeCtx());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('Built the widget and shipped it. Key result: 42.');
      expect(result.value).not.toContain('detailed reasoning');
      expect(result.value).not.toContain('Appendix');
      expect(result.value.length).toBeLessThanOrEqual(2_000);
    }
  });

  it('summary mode falls back to truncated child text when no ## Summary present', async () => {
    const childText = 'y'.repeat(5_000); // no summary heading
    const loop = makeLoop({ 'No summary.': childText });
    const tool = createDelegateTaskTool(loop);

    const result = await tool.execute({ prompt: 'No summary.', return_mode: 'summary' }, makeCtx());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeLessThanOrEqual(2_000);
      expect(result.value.startsWith('yyy')).toBe(true);
      expect(result.value).toContain('[truncated]');
    }
  });

  it('rejects an invalid return_mode value', async () => {
    const tool = createDelegateTaskTool(makeLoop());
    const result = await tool.execute(
      { prompt: 'task', return_mode: 'digest' } as unknown as { prompt: string },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('mixture_of_agents threads depth into every spawned child', async () => {
    const seenAgentIds: Array<string | undefined> = [];
    const loop = {
      run: async function* (
        _prompt: string,
        opts: { agentId?: string },
      ): AsyncGenerator<AgentEvent> {
        seenAgentIds.push(opts.agentId);
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', text: 'ok', turnCount: 1 };
      },
    } as unknown as import('@ethosagent/core').AgentLoop;

    const tool = createMixtureOfAgentsTool(loop);
    await tool.execute(
      { agents: [{ prompt: 'a' }, { prompt: 'b' }] },
      makeCtx({ agentId: 'depth:1' }),
    );

    expect(seenAgentIds).toEqual(['depth:2', 'depth:2']);
  });
});

// ---------------------------------------------------------------------------
// mixture_of_agents
// ---------------------------------------------------------------------------

describe('mixture_of_agents', () => {
  it('runs agents in parallel and combines outputs', async () => {
    const loop = makeLoop({
      research: 'Research findings here.',
      review: 'Review notes here.',
    });
    const tool = createMixtureOfAgentsTool(loop);

    const result = await tool.execute(
      {
        agents: [
          { prompt: 'Please research this topic.', label: 'Researcher' },
          { prompt: 'Please review this code.', label: 'Reviewer' },
        ],
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('Researcher');
      expect(result.value).toContain('Reviewer');
    }
  });

  it('returns input_invalid when agents array is empty', async () => {
    const tool = createMixtureOfAgentsTool(makeLoop());
    const result = await tool.execute({ agents: [] }, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('returns input_invalid when more than 5 agents', async () => {
    const tool = createMixtureOfAgentsTool(makeLoop());
    const agents = Array.from({ length: 6 }, (_, i) => ({ prompt: `task ${i}` }));
    const result = await tool.execute({ agents }, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Maximum 5');
  });

  it('blocks at max spawn depth', async () => {
    const tool = createMixtureOfAgentsTool(makeLoop());
    const result = await tool.execute(
      { agents: [{ prompt: 'task' }] },
      makeCtx({ agentId: 'depth:3' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Maximum spawn depth');
  });

  it('synthesises results when synthesis_prompt is provided', async () => {
    const loop = {
      run: async function* (prompt: string): AsyncGenerator<AgentEvent> {
        const text = prompt.includes('Synthesise')
          ? 'Final synthesised answer.'
          : `Agent output for: ${prompt.slice(0, 20)}`;
        yield { type: 'text_delta', text };
        yield { type: 'done', text, turnCount: 1 };
      },
    } as unknown as import('@ethosagent/core').AgentLoop;

    const tool = createMixtureOfAgentsTool(loop);
    const result = await tool.execute(
      {
        agents: [{ prompt: 'Do task A.' }, { prompt: 'Do task B.' }],
        synthesis_prompt: 'Synthesise these outputs.',
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('Synthesis');
      expect(result.value).toContain('Final synthesised answer.');
    }
  });

  it('still returns partial results if some agents fail', async () => {
    let callCount = 0;
    const loop = {
      run: async function* (): AsyncGenerator<AgentEvent> {
        callCount++;
        if (callCount === 1) throw new Error('Agent 1 failed');
        yield { type: 'text_delta', text: 'Agent 2 succeeded.' };
        yield { type: 'done', text: 'done', turnCount: 1 };
      },
    } as unknown as import('@ethosagent/core').AgentLoop;

    const tool = createMixtureOfAgentsTool(loop);
    const result = await tool.execute(
      {
        agents: [
          { prompt: 'Task 1', label: 'A' },
          { prompt: 'Task 2', label: 'B' },
        ],
      },
      makeCtx(),
    );

    // One succeeded, one failed — should return the successful one
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('Agent 2 succeeded.');
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe('createDelegationTools', () => {
  it('returns both tools', () => {
    const tools = createDelegationTools(makeLoop(), storage);
    const names = tools.map((t) => t.name);
    expect(names).toContain('delegate_task');
    expect(names).toContain('mixture_of_agents');
    expect(names).toContain('list_team');
    expect(names).toContain('dispatch_team');
    expect(names).toContain('route_to_agent');
    expect(names).toContain('broadcast_to_agents');
  });

  it('both tools belong to delegation toolset', () => {
    const tools = createDelegationTools(makeLoop(), storage);
    for (const tool of tools) {
      expect(tool.toolset).toBe('delegation');
    }
  });
});

describe('mesh orchestration tools', () => {
  it('list_team excludes current process by default', async () => {
    const registryPath = makeRegistryPath();
    const mesh = new AgentMesh(registryPath, { storage });
    await mesh.register({
      agentId: `coordinator:${process.pid}:self`,
      capabilities: ['coordination'],
      model: 'm',
      pid: process.pid,
      host: '127.0.0.1',
      port: 5010,
      activeSessions: 0,
    });
    await mesh.register({
      agentId: 'researcher:999:other',
      capabilities: ['research'],
      model: 'm',
      pid: 999,
      host: '127.0.0.1',
      port: 5011,
      activeSessions: 0,
    });

    const tool = createListTeamTool(storage, registryPath);
    const result = await tool.execute({}, makeCtx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = JSON.parse(result.value) as Array<{ personality: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.personality).toBe('researcher');
  });

  it('route_to_agent retries alternate candidate on failure', async () => {
    const registryPath = makeRegistryPath();
    const mesh = new AgentMesh(registryPath, { storage });
    await mesh.register({
      agentId: 'researcher:111:first',
      capabilities: ['research'],
      model: 'm',
      pid: 111,
      host: '127.0.0.1',
      port: 6101,
      activeSessions: 0,
    });
    await mesh.register({
      agentId: 'researcher:222:second',
      capabilities: ['research'],
      model: 'm',
      pid: 222,
      host: '127.0.0.1',
      port: 6102,
      activeSessions: 1,
    });

    const mockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { method: string };
      if (payload.method === 'new_session') {
        return {
          json: async () => ({ result: { sessionKey: 'acp:test' } }),
        };
      }
      if (String(url).includes(':6101/')) {
        throw new Error('network down');
      }
      return {
        json: async () => ({ result: { text: 'fallback response' } }),
      };
    }) as unknown as (url: string | URL, init?: RequestInit) => Promise<Response>;

    const tool = createRouteToAgentTool(storage, registryPath);
    const result = await tool.execute(
      { capability: 'research', prompt: 'analyze', retries: 2, timeout_s: 5 },
      makeCtx({ scopedFetch: { fetch: mockFetch } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('researcher:222:second');
    expect(result.value).toContain('fallback response');
  });

  it('dispatch_team returns structured per-task records', async () => {
    const registryPath = makeRegistryPath();
    const mesh = new AgentMesh(registryPath, { storage });
    await mesh.register({
      agentId: 'researcher:301:r',
      capabilities: ['research'],
      model: 'm',
      pid: 301,
      host: '127.0.0.1',
      port: 6201,
      activeSessions: 0,
    });
    await mesh.register({
      agentId: 'engineer:302:e',
      capabilities: ['code'],
      model: 'm',
      pid: 302,
      host: '127.0.0.1',
      port: 6202,
      activeSessions: 0,
    });

    const mockFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as {
        method: string;
        params?: { text?: string };
      };
      if (payload.method === 'new_session') {
        return { json: async () => ({ result: { sessionKey: 'acp:test' } }) };
      }
      return { json: async () => ({ result: { text: `ok:${payload.params?.text}` } }) };
    }) as unknown as (url: string | URL, init?: RequestInit) => Promise<Response>;

    const tool = createDispatchTeamTool(storage, registryPath);
    const result = await tool.execute(
      {
        tasks: [
          { capability: 'research', prompt: 'task A' },
          { capability: 'code', prompt: 'task B' },
        ],
      },
      makeCtx({ scopedFetch: { fetch: mockFetch } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = JSON.parse(result.value) as Array<{ task: number; ok: boolean; text?: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.ok).toBe(true);
    expect(rows[1]?.ok).toBe(true);
    expect(rows[0]?.text).toContain('task A');
    expect(rows[1]?.text).toContain('task B');
  });
});
