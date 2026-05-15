import {
  AgentMesh,
  appendMeshJournal,
  defaultRegistryPath,
  type MeshEntry,
} from '@ethosagent/agent-mesh';
import type { AgentLoop } from '@ethosagent/core';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Depth tracking — stored in ToolContext.agentId as "depth:<n>"
// ---------------------------------------------------------------------------

const MAX_SPAWN_DEPTH = 3;
const MAX_ROUTE_RETRIES = 2;

function getDepth(ctx: ToolContext): number {
  const raw = ctx.agentId ?? '';
  const match = raw.match(/^depth:(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function childAgentId(depth: number): string {
  return `depth:${depth}`;
}

// ---------------------------------------------------------------------------
// Run a sub-agent and collect its full text output
// ---------------------------------------------------------------------------

async function runSubAgent(
  loop: AgentLoop,
  prompt: string,
  opts: {
    personalityId?: string;
    sessionKey: string;
    depth: number;
    abortSignal?: AbortSignal;
  },
): Promise<string> {
  let output = '';

  for await (const event of loop.run(prompt, {
    sessionKey: opts.sessionKey,
    personalityId: opts.personalityId,
    abortSignal: opts.abortSignal,
    agentId: childAgentId(opts.depth),
  })) {
    if (event.type === 'text_delta') output += event.text;
    if (event.type === 'error') throw new Error(event.error);
    if (event.type === 'done') break;
  }

  return output.trim();
}

// ---------------------------------------------------------------------------
// delegate_task — spawns a single child agent
// ---------------------------------------------------------------------------

export function createDelegateTaskTool(loop: AgentLoop): Tool {
  return {
    name: 'delegate_task',
    description:
      'Spawn a sub-agent to handle a specific task and return its output. ' +
      'The sub-agent runs with its own session and optionally a different personality. ' +
      'Use when a task is clearly separable and benefits from a fresh context or specialist personality. ' +
      `Maximum spawn depth: ${MAX_SPAWN_DEPTH}.`,
    toolset: 'delegation',
    maxResultChars: 20_000,
    capabilities: {
      network: { allowedHosts: ['*'] }, // agent-supplied URL — bounded by personality.network.allow
    },
    schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The task prompt for the sub-agent to complete',
        },
        personality: {
          type: 'string',
          description:
            'Personality for the sub-agent (e.g. "researcher", "reviewer"). Defaults to current personality.',
        },
        label: {
          type: 'string',
          description: 'Optional label to identify this sub-task in the result',
        },
      },
      required: ['prompt'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { prompt, personality, label } = args as {
        prompt: string;
        personality?: string;
        label?: string;
      };

      if (!prompt) return { ok: false, error: 'prompt is required', code: 'input_invalid' };

      const depth = getDepth(ctx);
      if (depth >= MAX_SPAWN_DEPTH) {
        return {
          ok: false,
          error: `Maximum spawn depth (${MAX_SPAWN_DEPTH}) reached. Cannot delegate further.`,
          code: 'execution_failed',
        };
      }

      const sessionKey = `${ctx.sessionKey}:sub:${label ?? 'task'}:${ctx.currentTurn}`;

      try {
        const output = await runSubAgent(loop, prompt, {
          personalityId: personality,
          sessionKey,
          depth: depth + 1,
          abortSignal: ctx.abortSignal,
        });

        const header = label ? `[${label}]\n\n` : '';
        return { ok: true, value: `${header}${output}` };
      } catch (err) {
        return {
          ok: false,
          error: `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`,
          code: 'execution_failed',
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// mixture_of_agents — runs N sub-agents in parallel, synthesises results
// ---------------------------------------------------------------------------

export function createMixtureOfAgentsTool(loop: AgentLoop): Tool {
  return {
    name: 'mixture_of_agents',
    description:
      'Run multiple sub-agents in parallel, each with a different prompt or personality, ' +
      'then synthesise their outputs into a final answer. ' +
      'Use for tasks that benefit from diverse perspectives or parallel research. ' +
      `Maximum ${MAX_SPAWN_DEPTH} total spawn depth. Maximum 5 agents per call.`,
    toolset: 'delegation',
    maxResultChars: 40_000,
    capabilities: {
      network: { allowedHosts: ['*'] }, // agent-supplied URL — bounded by personality.network.allow
    },
    schema: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          description: 'List of sub-agents to run in parallel (max 5)',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Task prompt for this agent' },
              personality: { type: 'string', description: 'Personality for this agent' },
              label: { type: 'string', description: 'Label to identify this agent in the result' },
            },
            required: ['prompt'],
          },
        },
        synthesis_prompt: {
          type: 'string',
          description:
            "Optional prompt to synthesise the agents' outputs into a final answer. " +
            'If omitted, outputs are concatenated with labels.',
        },
      },
      required: ['agents'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { agents, synthesis_prompt } = args as {
        agents: Array<{ prompt: string; personality?: string; label?: string }>;
        synthesis_prompt?: string;
      };

      if (!agents?.length) {
        return {
          ok: false,
          error: 'agents array is required and must not be empty',
          code: 'input_invalid',
        };
      }

      if (agents.length > 5) {
        return {
          ok: false,
          error: 'Maximum 5 agents per mixture_of_agents call',
          code: 'input_invalid',
        };
      }

      const depth = getDepth(ctx);
      if (depth >= MAX_SPAWN_DEPTH) {
        return {
          ok: false,
          error: `Maximum spawn depth (${MAX_SPAWN_DEPTH}) reached.`,
          code: 'execution_failed',
        };
      }

      // Run all agents in parallel
      const results = await Promise.allSettled(
        agents.map(async (agent, i) => {
          const label = agent.label ?? `Agent ${i + 1}`;
          const sessionKey = `${ctx.sessionKey}:moa:${label}:${ctx.currentTurn}`;
          const output = await runSubAgent(loop, agent.prompt, {
            personalityId: agent.personality,
            sessionKey,
            depth: depth + 1,
            abortSignal: ctx.abortSignal,
          });
          return { label, output };
        }),
      );

      // Collect outputs
      const outputs: Array<{ label: string; output: string }> = [];
      const errors: string[] = [];

      for (const result of results) {
        if (result.status === 'fulfilled') {
          outputs.push(result.value);
        } else {
          errors.push(String(result.reason));
        }
      }

      if (outputs.length === 0) {
        return {
          ok: false,
          error: `All agents failed:\n${errors.join('\n')}`,
          code: 'execution_failed',
        };
      }

      // Format agent outputs
      const combined = outputs.map((o) => `## ${o.label}\n\n${o.output}`).join('\n\n---\n\n');

      // If synthesis prompt provided, run a final synthesis pass
      if (synthesis_prompt) {
        const synthesisInput =
          `${synthesis_prompt}\n\n` +
          `Here are the outputs from ${outputs.length} agents:\n\n${combined}`;

        const sessionKey = `${ctx.sessionKey}:moa:synthesis:${ctx.currentTurn}`;

        try {
          const synthesis = await runSubAgent(loop, synthesisInput, {
            sessionKey,
            depth: depth + 1,
            abortSignal: ctx.abortSignal,
          });

          return {
            ok: true,
            value: `## Agent Outputs\n\n${combined}\n\n---\n\n## Synthesis\n\n${synthesis}`,
          };
        } catch {
          // Synthesis failed — return raw outputs
          return { ok: true, value: combined };
        }
      }

      return { ok: true, value: combined };
    },
  };
}

// ---------------------------------------------------------------------------
// Mesh routing — HTTP JSON-RPC calls to registered peer agents
// ---------------------------------------------------------------------------

type FetchImpl = (url: string | URL, init?: RequestInit) => Promise<Response>;

async function callMeshAgent(
  host: string,
  port: number,
  prompt: string,
  personalityId: string | undefined,
  signal: AbortSignal | undefined,
  fetchImpl: FetchImpl,
): Promise<string> {
  const base = `http://${host}:${port}/rpc`;

  // Create a fresh session on the remote agent
  const sessionRes = await fetchImpl(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'new_session',
      params: personalityId ? { personalityId } : {},
    }),
    signal,
  });
  const sessionData = (await sessionRes.json()) as { result?: { sessionKey?: string } };
  const sessionKey = sessionData.result?.sessionKey ?? `acp:${Date.now()}`;

  // Send the prompt and wait for the full result
  const promptRes = await fetchImpl(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'prompt',
      params: personalityId
        ? { sessionKey, text: prompt, personalityId }
        : { sessionKey, text: prompt },
    }),
    signal,
  });
  const promptData = (await promptRes.json()) as {
    result?: { text?: string };
    error?: { message?: string };
  };
  if (promptData.error) throw new Error(promptData.error.message ?? 'Remote agent error');
  return promptData.result?.text ?? '';
}

function personalityFromAgentId(agentId: string): string {
  const idx = agentId.indexOf(':');
  return idx > 0 ? agentId.slice(0, idx) : agentId;
}

function selectCandidates(entries: MeshEntry[], capability: string): MeshEntry[] {
  return entries
    .filter((e) => e.capabilities.includes(capability))
    .sort((a, b) =>
      a.activeSessions !== b.activeSessions
        ? a.activeSessions - b.activeSessions
        : a.registeredAt - b.registeredAt,
    );
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface RoutedCall {
  ok: boolean;
  agent?: MeshEntry;
  text?: string;
  attempts: number;
  errors: string[];
}

async function routeWithFailover(params: {
  entries: MeshEntry[];
  capability: string;
  prompt: string;
  retries?: number;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  personalityId?: string;
  fetchImpl: FetchImpl;
}): Promise<RoutedCall> {
  const candidates = selectCandidates(params.entries, params.capability);
  if (candidates.length === 0)
    return { ok: false, attempts: 0, errors: ['no matching candidates'] };

  const maxAttempts = Math.min(candidates.length, (params.retries ?? MAX_ROUTE_RETRIES) + 1);
  const errors: string[] = [];

  for (let i = 0; i < maxAttempts; i++) {
    const agent = candidates[i];
    if (!agent) break;
    try {
      const signal = withTimeout(params.abortSignal, params.timeoutMs);
      const text = await callMeshAgent(
        agent.host,
        agent.port,
        params.prompt,
        params.personalityId,
        signal,
        params.fetchImpl,
      );
      return { ok: true, agent, text, attempts: i + 1, errors };
    } catch (err) {
      errors.push(`${agent.agentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ok: false, attempts: maxAttempts, errors };
}

export function createListTeamTool(registryPath = defaultRegistryPath()): Tool {
  return {
    name: 'list_team',
    description:
      'List live mesh peers with personality, capabilities, and load. ' +
      'Use before dispatch planning to decide which specialist should handle each task.',
    toolset: 'delegation',
    maxResultChars: 20_000,
    capabilities: {
      network: { allowedHosts: ['*'] }, // agent-supplied URL — bounded by personality.network.allow
    },
    schema: {
      type: 'object',
      properties: {
        include_self: {
          type: 'boolean',
          description: 'Include current process in output (default false).',
        },
      },
    },
    async execute(args): Promise<ToolResult> {
      const { include_self = false } = (args ?? {}) as { include_self?: boolean };
      const mesh = new AgentMesh(registryPath);
      const peers = await mesh.list();

      const filtered = include_self ? peers : peers.filter((p) => p.pid !== process.pid);
      const roster = filtered.map((p) => ({
        agentId: p.agentId,
        personality: personalityFromAgentId(p.agentId),
        capabilities: p.capabilities,
        host: p.host,
        port: p.port,
        activeSessions: p.activeSessions,
        model: p.model,
      }));

      return { ok: true, value: JSON.stringify(roster, null, 2) };
    },
  };
}

export function createRouteToAgentTool(registryPath = defaultRegistryPath()): Tool {
  return {
    name: 'route_to_agent',
    description:
      'Route a task to the best available mesh agent advertising a given capability. ' +
      "Agents register via `ethos serve`; routing is scoped to the caller's mesh. " +
      "Returns the remote agent's full response. " +
      'Does not fall back to local execution if no matching agent is found.',
    toolset: 'delegation',
    maxResultChars: 20_000,
    capabilities: {
      network: { allowedHosts: ['*'] }, // agent-supplied URL — bounded by personality.network.allow
    },
    schema: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description: 'Capability label to match (e.g. "code", "review", "research")',
        },
        prompt: {
          type: 'string',
          description: 'Task prompt for the remote agent',
        },
        timeout_s: {
          type: 'number',
          description: 'Per-attempt timeout in seconds (default: 60)',
        },
        retries: {
          type: 'number',
          description: 'Retry count across alternate peers (default: 2, max: 5)',
        },
      },
      required: ['capability', 'prompt'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { capability, prompt, timeout_s, retries } = args as {
        capability: string;
        prompt: string;
        timeout_s?: number;
        retries?: number;
      };
      if (!capability) return { ok: false, error: 'capability is required', code: 'input_invalid' };
      if (!prompt) return { ok: false, error: 'prompt is required', code: 'input_invalid' };

      const fetchFn = ctx.scopedFetch?.fetch.bind(ctx.scopedFetch);
      if (!fetchFn)
        return {
          ok: false,
          error: 'Network capability not configured',
          code: 'not_available' as const,
        };

      const mesh = new AgentMesh(registryPath);
      const peers = await mesh.list();
      const timeoutMs = Math.max(1, timeout_s ?? 60) * 1000;
      const retryCount = Math.min(Math.max(0, retries ?? MAX_ROUTE_RETRIES), 5);

      const routed = await routeWithFailover({
        entries: peers,
        capability,
        prompt,
        retries: retryCount,
        timeoutMs,
        abortSignal: ctx.abortSignal,
        fetchImpl: fetchFn,
      });

      if (!routed.ok || !routed.agent || routed.text === undefined) {
        appendMeshJournal({
          ts: new Date().toISOString(),
          event: 'route_to_agent_failed',
          capability,
          attempts: routed.attempts,
          errors: routed.errors,
        });
        return {
          ok: false,
          error:
            routed.errors.length > 0
              ? `no successful agent for capability: ${capability}; attempts=${routed.attempts}; ${routed.errors.join('; ')}`
              : `no agent available for capability: ${capability}`,
          code: 'execution_failed',
        };
      }

      appendMeshJournal({
        ts: new Date().toISOString(),
        event: 'route_to_agent',
        capability,
        callee: routed.agent.agentId,
        attempts: routed.attempts,
      });

      return { ok: true, value: `[${routed.agent.agentId}]\n\n${routed.text}` };
    },
  };
}

export function createDispatchTeamTool(registryPath = defaultRegistryPath()): Tool {
  return {
    name: 'dispatch_team',
    description:
      'Dispatch multiple capability-scoped tasks across mesh peers in parallel. ' +
      'Each task picks the best available specialist and retries alternate peers on failure.',
    toolset: 'delegation',
    maxResultChars: 60_000,
    capabilities: {
      network: { allowedHosts: ['*'] }, // agent-supplied URL — bounded by personality.network.allow
    },
    schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Parallel tasks to dispatch',
          items: {
            type: 'object',
            properties: {
              capability: { type: 'string' },
              prompt: { type: 'string' },
              timeout_s: { type: 'number' },
              retries: { type: 'number' },
            },
            required: ['capability', 'prompt'],
          },
        },
      },
      required: ['tasks'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { tasks } = args as {
        tasks: Array<{ capability: string; prompt: string; timeout_s?: number; retries?: number }>;
      };
      if (!tasks || tasks.length === 0) {
        return {
          ok: false,
          error: 'tasks is required and must not be empty',
          code: 'input_invalid',
        };
      }
      if (tasks.length > 12) {
        return {
          ok: false,
          error: 'Maximum 12 tasks per dispatch_team call',
          code: 'input_invalid',
        };
      }

      const fetchFn = ctx.scopedFetch?.fetch.bind(ctx.scopedFetch);
      if (!fetchFn)
        return {
          ok: false,
          error: 'Network capability not configured',
          code: 'not_available' as const,
        };

      const mesh = new AgentMesh(registryPath);
      const peers = await mesh.list();

      const results = await Promise.all(
        tasks.map(async (task, i) => {
          const timeoutMs = Math.max(1, task.timeout_s ?? 60) * 1000;
          const retryCount = Math.min(Math.max(0, task.retries ?? MAX_ROUTE_RETRIES), 5);
          const routed = await routeWithFailover({
            entries: peers,
            capability: task.capability,
            prompt: task.prompt,
            retries: retryCount,
            timeoutMs,
            abortSignal: ctx.abortSignal,
            fetchImpl: fetchFn,
          });

          if (!routed.ok || !routed.agent || routed.text === undefined) {
            return {
              task: i,
              capability: task.capability,
              ok: false,
              attempts: routed.attempts,
              error:
                routed.errors.length > 0
                  ? routed.errors.join('; ')
                  : `no agent available for capability: ${task.capability}`,
            };
          }
          return {
            task: i,
            capability: task.capability,
            ok: true,
            attempts: routed.attempts,
            agentId: routed.agent.agentId,
            text: routed.text,
          };
        }),
      );

      appendMeshJournal({
        ts: new Date().toISOString(),
        event: 'dispatch_team',
        taskCount: tasks.length,
        okCount: results.filter((r) => r.ok).length,
        failCount: results.filter((r) => !r.ok).length,
      });

      return { ok: true, value: JSON.stringify(results, null, 2) };
    },
  };
}

export function createBroadcastToAgentsTool(registryPath = defaultRegistryPath()): Tool {
  return {
    name: 'broadcast_to_agents',
    description:
      'Send a prompt to all live agents in the mesh and return their combined responses. ' +
      'Useful for getting multiple perspectives or running parallel reviews.',
    toolset: 'delegation',
    maxResultChars: 60_000,
    capabilities: {
      network: { allowedHosts: ['*'] }, // agent-supplied URL — bounded by personality.network.allow
    },
    schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Prompt to send to every live mesh agent',
        },
      },
      required: ['prompt'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { prompt } = args as { prompt: string };
      if (!prompt) return { ok: false, error: 'prompt is required', code: 'input_invalid' };

      const fetchFn = ctx.scopedFetch?.fetch.bind(ctx.scopedFetch);
      if (!fetchFn)
        return {
          ok: false,
          error: 'Network capability not configured',
          code: 'not_available' as const,
        };

      const mesh = new AgentMesh(registryPath);
      const agents = await mesh.list();
      if (agents.length === 0) {
        return { ok: false, error: 'no live agents in mesh', code: 'execution_failed' };
      }

      const results = await Promise.allSettled(
        agents.map(async (agent) => {
          const text = await callMeshAgent(
            agent.host,
            agent.port,
            prompt,
            undefined,
            ctx.abortSignal,
            fetchFn,
          );
          return { agentId: agent.agentId, text };
        }),
      );

      const outputs: string[] = [];
      const errors: string[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') {
          outputs.push(`## ${r.value.agentId}\n\n${r.value.text}`);
        } else {
          errors.push(String(r.reason));
        }
      }

      if (outputs.length === 0) {
        return {
          ok: false,
          error: `All agents failed:\n${errors.join('\n')}`,
          code: 'execution_failed',
        };
      }

      const combined = outputs.join('\n\n---\n\n');
      const suffix =
        errors.length > 0
          ? `\n\n---\n\n*${errors.length} agent(s) failed: ${errors.join('; ')}*`
          : '';
      return { ok: true, value: combined + suffix };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDelegationTools(loop: AgentLoop, registryPath?: string): Tool[] {
  return [
    createDelegateTaskTool(loop),
    createMixtureOfAgentsTool(loop),
    createListTeamTool(registryPath),
    createDispatchTeamTool(registryPath),
    createRouteToAgentTool(registryPath),
    createBroadcastToAgentsTool(registryPath),
  ];
}
