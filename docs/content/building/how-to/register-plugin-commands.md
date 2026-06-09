---
title: "Register plugin slash commands"
description: "Register custom slash commands from a plugin so they appear in /help across CLI, web, Telegram, Discord, and Slack."
kind: how-to
audience: developer
slug: register-plugin-commands
time: "10 min"
updated: 2026-06-09
---

## Task

Register a custom slash command from a [plugin](../../getting-started/glossary.md#plugin) so it appears in `/help`, tab-complete, and `ethos skill list` across every surface.

## Result

A `/weather` command that users can invoke from CLI, web, Telegram, Discord, and Slack. The command shows in `/help` output and responds with structured text.

## Prereqs

- A working plugin with `activate()` exported (see [Create a plugin](./create-a-plugin.md)).
- `@ethosagent/plugin-sdk` installed.
- Ethos running locally (`pnpm dev` or `ethos`).

## Steps

### 1. Call `registerSlashCommand` in `activate()`

The `PluginApi` exposes `registerSlashCommand()`. Pass a name, description, usage string, and an async handler.

```typescript
export function activate(api: EthosPluginApi) {
  api.registerSlashCommand({
    name: 'weather',
    description: 'Get current weather for a city',
    usage: '/weather <city>',
    handler: async (args, ctx) => {
      const city = args.trim() || 'London';
      const data = await fetchWeather(city);
      return `${city}: ${data.temp}°C, ${data.conditions}`;
    },
  });
}
```

The `name` field is the command text users type after `/`. It must be unique across all loaded plugins.

### 2. Understand the handler signature

The handler receives two arguments:

```typescript
(args: string, ctx: SlashCommandContext) => Promise<string>
```

`args` is the raw text after the command name. For `/weather London`, `args` is `"London"`. Parse it however you need — the framework does no argument splitting.

The return value is sent as the command's reply. Return a string; the framework handles formatting per platform.

### 3. Use `SlashCommandContext`

The `ctx` object provides session state and platform utilities.

| Field | Type | Description |
|---|---|---|
| `sessionId` | `string` | Active [session](../../getting-started/glossary.md#session) key. |
| `personalityId` | `string` | Current [personality](../../getting-started/glossary.md#personality) id. |
| `platform` | `string` | `'cli'`, `'web'`, `'telegram'`, `'discord'`, or `'slack'`. |
| `send()` | `(text: string) => Promise<void>` | Send an intermediate reply before the final return. |
| `toolRegistry` | `ToolRegistry` | Access to the [tool registry](../../getting-started/glossary.md#tool-registry) for the current session. |
| `storage` | `Storage` | Scoped [storage](../../getting-started/glossary.md#storage) for persisting command state. |

### 4. Send multi-part replies with `ctx.send()`

For long-running commands, send progress updates before returning the final result. Each `ctx.send()` call delivers an intermediate message to the user immediately.

```typescript
handler: async (args, ctx) => {
  const cities = args.split(',').map((c) => c.trim());
  for (const city of cities) {
    const data = await fetchWeather(city);
    await ctx.send(`${city}: ${data.temp}°C, ${data.conditions}`);
  }
  return `Done — checked ${cities.length} cities.`;
},
```

The final `return` value is always sent as the last message. Calls to `ctx.send()` appear before it in conversation order.

### 5. Handle platform-specific behavior

Each [channel adapter](../../getting-started/glossary.md#channel-adapter) processes command registration differently.

| Platform | Behavior |
|---|---|
| **CLI / Web** | Commands register instantly. Tab-complete works immediately. |
| **Telegram** | Command names are sanitized: lowercased, spaces replaced with underscores, truncated to 32 characters. `My Command` becomes `my_command`. |
| **Discord** | Application commands are re-registered with the Discord API on plugin load. This can take up to one hour to propagate globally. |
| **Slack** | Commands are logged for manual registration. Add them to your Slack app's slash command configuration in the Slack API dashboard. |

If your command name contains uppercase letters or spaces, test on Telegram first — the sanitized name may differ from what you expect.

### 6. Build and install

```bash
pnpm build && ethos plugin install .
```

## Verify

Run these commands to confirm registration:

```bash
ethos skill list          # command appears in the skill/command list
```

Then in a chat session:

- Type `/help` — the command appears with its description and usage.
- Type `/wea` and press Tab — the command auto-completes.
- Type `/weather Paris` — the handler executes and returns a response.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| Command missing from `/help` | Plugin not loaded or `activate()` threw. | Run `ethos plugin list` and check the plugin appears. Check logs for activation errors. |
| `Duplicate command name` error | Another plugin registered the same name. | Rename the command or uninstall the conflicting plugin. |
| Tab-complete works but command returns nothing | Handler returned `undefined` or an empty string. | Ensure the handler returns a non-empty string. |
| Telegram shows wrong command name | Name was sanitized (lowercase, underscores, 32 chars). | Use a name that survives sanitization unchanged. |
| Discord command not visible | Application command propagation delay. | Wait up to one hour, or test with a guild-scoped command. |
| `ctx.send()` messages appear after the final reply | Platform does not support ordered intermediate messages. | Acceptable on some platforms — the final return value is always last. |

## See also

- [Create a plugin](./create-a-plugin.md)
- [Plugin SDK reference](../reference/plugin-sdk.md)
- [Add a skill](./add-a-skill.md)
- [Hook execution models](../explanation/hook-execution-models.md)
