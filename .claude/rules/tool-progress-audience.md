---
paths:
  - "extensions/tools-*/**"
  - "extensions/platform-*/**"
  - "apps/ethos/src/commands/chat.ts"
  - "apps/web/src/lib/**"
  - "extensions/cron/src/progress.ts"
---

# Tool-progress audience boundary

Tool-progress audience boundary (Phase 30.2)
Tools call ctx.emit({ type: 'progress', toolName, message, audience? }) to surface progress. The audience field is the gate:

Default ('internal') — consumed by the framework only (logs, telemetry, dev TUI). Channel adapters (telegram, discord, slack, whatsapp, email) and apps/ethos/src/commands/chat.ts MUST NOT surface it.
'user' — explicit per-event opt-in by the tool author. Used for long-running operations where silent latency would be confusing (read_file reading >1MB, multi-step bash). The framework never opts in for the tool.
The same gate applies to the tool_progress AgentEvent. Surface code (CLI chat, channel adapters) renders only events with audience: 'user'.
