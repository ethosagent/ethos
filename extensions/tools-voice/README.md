# @ethosagent/tools-voice

## Purpose

Voice tools. `voice_session` is a capability tool that selects the voice toolset; `call` places an outbound phone call through an injected SIP trunk. `agent_consult` is the one door from a hosted realtime voice session back into the text `AgentLoop`, and a realtime tool host dispatches only the tools it advertised. Telephony transport is in `@ethosagent/platform-voice`.

## Public surface

Exported from `src/index.ts` (single entry, no subpaths).

| Export | Kind | One line |
|---|---|---|
| `createVoiceTools` | function | Returns `voice_session` and `call`. |
| `VoiceToolsOptions` | interface | SIP trunk and room-name derivation. |
| `createAgentConsultTool` | function | Builds `agent_consult` around an `AgentLoop`. |
| `AGENT_CONSULT_TOOL` | const | Tool name. |
| `AGENT_CONSULT_MAX_RESULT_CHARS` | const | Result cap (4,000). |
| `AgentConsultOptions` | interface | Consult options. |
| `fenceFarEndSpeech` | function | Wraps far-end speech as untrusted before the loop sees it. |
| `buildRealtimeInstructions` | function | Builds the realtime session instructions from SOUL text. |
| `deriveRealtimeToolset` | function | Chooses the tools a realtime session advertises. |
| `REALTIME_SAFE_TOOLS` | const | Allowlist of non-consult tools safe to advertise. |
| `REALTIME_BOUNDARY_POLICY` | const | Boundary text in the realtime instructions. |
| `createRealtimeToolHost` | function | Dispatches realtime tool calls. |
| `REALTIME_UNKNOWN_TOOL` | const | Error code for an unadvertised name. |

## Seam

Implements `Tool` from `@ethosagent/types`; depends on `AgentLoop` from `@ethosagent/core`, so it is registered after loop construction (see the header of `src/agent-consult.ts`). Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-voice
```

Pinning tests in `src/__tests__/`: `src/__tests__/agent-consult.test.ts` (runs on the caller's session key, forwards room audience, stamps the voice origin, fences a far-end consult prompt as untrusted), `src/__tests__/realtime-host.test.ts` (every advertised tool dispatches, a name never advertised is refused), `src/__tests__/call.test.ts` (`voice_session` availability and grouping, `call` tool behaviour).
