# Plugin examples: what a plugin can register

[Back to the plugin examples](../README.md)

## What a plugin can register

### 1. Tool

```typescript
import { defineTool, ok, err } from '@ethosagent/plugin-sdk/tool-helpers';

api.registerTool(
  defineTool<{ query: string; limit?: number }>({
    name: 'my_search',
    description: 'Search my data source',
    toolset: 'my-plugin',
    maxResultChars: 10_000,
    isAvailable: () => Boolean(process.env.MY_API_KEY),
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    async execute({ query, limit = 5 }, ctx) {
      try {
        const results = await fetchMyApi(query, limit, ctx.abortSignal);
        return ok(JSON.stringify(results, null, 2));
      } catch (e) {
        return err(`API error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  }),
);
```

**Tool result must be `{ ok: true, value: string }` or `{ ok: false, error, code }`.**
Error codes: `'input_invalid'` | `'not_available'` | `'execution_failed'`

See [`example-timestamp/`](../timestamp/) for a complete tool example.

### 2. Void hook (persistence, analytics, logging)

```typescript
api.registerVoidHook('agent_done', async ({ sessionId, text, turnCount }) => {
  await myDb.insert({ sessionId, chars: text.length, turns: turnCount });
});
```

Fire-and-forget. All void handlers run in parallel. Failures are swallowed (fail-open).

Available: `session_start`, `before_llm_call`, `after_llm_call`, `after_tool_call`, `agent_done`, `message_received`, `message_sent`, `subagent_spawned`, `subagent_ended`

See [`example-memory-logger/`](../memory-logger/) for the persistence pattern.

### 3. Modifying hook (safety, compliance, access control)

```typescript
// Block or alter tool calls
api.registerModifyingHook('before_tool_call', async ({ toolName, args }) => {
  if (toolName === 'terminal') {
    const cmd = (args as { command?: string })?.command ?? '';
    if (isDangerous(cmd)) return { error: 'Blocked by safety plugin' };
  }
  return null; // no change
});

// Add to system prompt
api.registerModifyingHook('before_prompt_build', async () => {
  return { prependSystem: '## Safety Rules\n\nNever delete system files.' };
});
```

Run sequentially. First non-null value per key wins. Return `null` for no change.

Available: `before_prompt_build`, `before_tool_call`, `message_sending`, `personality_switched`, `subagent_spawning`

See [`example-safety-adapter/`](../safety-adapter/) for the adapter pattern.

### 4. Context injector (dynamic system prompt sections)

```typescript
api.registerInjector({
  id: 'my-plugin-context',
  priority: 70,                    // lower than built-ins (80–100)
  shouldInject: (ctx) => ctx.platform === 'telegram',
  async inject(ctx) {
    return { content: `## Telegram Context\n\nUser timezone: UTC+5`, position: 'append' };
  },
});
```

Priority order: `110+ (personality identity)` → `100 (SkillsInjector)` → `90 (FileContextInjector)` → `80 (MemoryGuidanceInjector)` → `70+ (your plugin)`

### 5. Personality

```typescript
api.registerPersonality({
  id: 'strategist',
  name: 'Strategist',
  description: 'Thinks in frameworks, presents options with tradeoffs',
  provider: 'anthropic',
  model: 'deep', // a role or a modelRegistry alias, never a vendor id
  toolset: ['web_search', 'read_file', 'memory_read'],
});

// Bundle an identity injector alongside the personality
api.registerInjector({
  id: 'strategist-identity',
  priority: 110,
  shouldInject: (ctx) => ctx.personalityId === 'strategist',
  async inject() {
    return { content: STRATEGIST_ETHOS_MD, position: 'prepend' };
  },
});
```

See [`example-personality/`](../personality/) for the complete pattern.
