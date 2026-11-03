# @ethosagent/agent-bridge

## Purpose

Adapts `AgentLoop`'s async-generator event stream into an `EventEmitter` surface that every UI (TUI, web, VS Code) can subscribe to the same way. It also queues concurrent sends (FIFO, cap 10), buffers per-session stream events, and provides an in-memory steer sink.

## Public surface

| Export | Kind | One line |
|---|---|---|
| `AgentBridge` | class | Emitter wrapper around an `AgentLoop` run. |
| `BridgeOptions` | type | Options for constructing an `AgentBridge`. |
| `BridgeOpts` | type | Per-send options (`RunOptions` minus `abortSignal`). |
| `BridgeApprovalRequest` | type | Approval request shape surfaced by the bridge. |
| `BridgeApprovalSource` | type | Source of approval decisions. |
| `DEFAULT_TURN_TIMEOUT_MS` | const | Default per-turn timeout. |
| `InMemorySteerSink` | class | In-memory steer sink. |
| `InMemorySteerSinkOptions` | type | Options for `InMemorySteerSink`. |
| `SessionStreamBuffer` | class | Per-session buffer of emitted events. |
| `BufferedEvent` | type | One buffered event. |
| `SessionStreamBufferOptions` | type | Options for `SessionStreamBuffer`. |

## Seam

Wraps `AgentLoop` from `@ethosagent/core` for UI surfaces and imports only contracts, kernel, vendored, core and support layers. Archcheck layer: `core-adapters` (rule `core-adapters-wrap-core` in `architecture.config.ts`).

## Testing

```
pnpm vitest run packages/agent-bridge
```

Pinning tests:
- `src/__tests__/agent-bridge.test.ts`: event forwarding, send queueing and the busy error.
- `src/__tests__/session-stream-buffer.test.ts`: the session stream buffer.
