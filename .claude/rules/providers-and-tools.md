---
paths:
  - "extensions/llm-*/**"
  - "extensions/tools-*/**"
  - "packages/core/src/tool-registry.ts"
  - "pnpm-workspace.yaml"
---

# Providers and tools

Adding a new LLM provider
Create extensions/llm-<name>/src/index.ts — implement LLMProvider from @ethosagent/types
Create extensions/llm-<name>/package.json — depend on @ethosagent/types: workspace:*
Add path alias to root tsconfig.json → "@ethosagent/llm-<name>": ["./extensions/llm-<name>/src"]
Wire it in apps/ethos/src/wiring.ts under a new config.provider value
LLMProvider.complete() must return AsyncIterable<CompletionChunk>. Map provider-specific streaming events to the CompletionChunk discriminated union (9 variants in packages/types/src/llm.ts; the frozen list is pinned by packages/types/src/__tests__/llm-provider-drift.test.ts).

Adding a new tool
Tools live in extensions/tools-* packages and register with DefaultToolRegistry at wiring time. To add one:

Implement Tool<TArgs> from @ethosagent/types
execute(args, ctx) must return Promise<ToolResult> — { ok: true, value: string } or { ok: false, error, code }
Set toolset to group the tool (e.g. 'file', 'web', 'terminal')
Set maxResultChars to limit output — executeParallel trims and appends [truncated] if exceeded
Declare isAvailable?() if the tool requires env vars or external services
Wire it in apps/ethos/src/wiring.ts so it's registered on startup

Tool result budget
AgentLoop sets resultBudgetChars: 80_000 by default. ToolRegistry.executeParallel() splits this evenly across concurrent tool calls. Each result is post-trimmed with a [truncated — N chars total] marker if it exceeds the per-call budget.

Tools can declare a lower maxResultChars (e.g. read_file with pagination). The actual budget per call is Math.min(perCallBudget, tool.maxResultChars ?? perCallBudget).


Personality toolset is enforced — DefaultToolRegistry.toDefinitions(allowedTools) filters what the LLM sees, and executeParallel rejects calls outside the allowlist (tool-registry.ts:57). AgentLoop reads personality.toolset and passes it through (agent-loop.ts:140,265,396). Disallowed tools get a tool_result with is_error: true to keep the Anthropic message contract intact.

Anthropic SDK: cache tokens are in message_start, not message_delta
event.message.usage in the message_start event contains cache_read_input_tokens and cache_creation_input_tokens (when prompt caching is active). These fields are not in the SDK's Usage type — cast to access them: event.message.usage as Anthropic.Usage & { cache_read_input_tokens?: number; cache_creation_input_tokens?: number }.

Anthropic SDK: extended thinking needs any cast for params
The thinking and betas fields for extended thinking are not in the SDK's MessageStreamParams type yet. The // biome-ignore lint/suspicious/noExplicitAny pattern is intentional here — don't try to type it more narrowly.

OpenAI tool call streaming: index-keyed, not ID-keyed
OpenAI streams tool calls as deltas on choices[0].delta.tool_calls[index]. The first delta for a given index has the id and name; subsequent deltas only have arguments. Build a Map<number, { id, name, args }> keyed by index. Don't try to key by id — it arrives late and is sometimes empty on early deltas.

openai package has a zod v3 peer dep — intentionally ignored
openai@4.87+ lists zod@^3 as a peer dependency. Ethos uses zod@4. The zod dep is only used by openai for its structured outputs / .parse() features, which we don't use. It's suppressed via peerDependencyRules.ignoreMissing: ["zod"] in pnpm-workspace.yaml. Don't remove this or pnpm will emit peer conflict warnings on every install.
