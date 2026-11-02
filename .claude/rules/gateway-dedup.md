---
paths:
  - "extensions/gateway/**"
  - "extensions/platform-*/**"
---

# Gateway dedup

Channel adapter contract
Every outbound channel message — including streaming finals and edits — flows through a single dedup path in the gateway: MessageDedupCache keyed by (sessionId, sha256(content)) with a 30s TTL. On the reply paths (a turn's final, its error note, a hook-claimed reply, the streamed final) the key also includes the inbound message the reply answers — its spool row id when spooled, else the platform message id, else an id the gateway assigns the message object (`Gateway.localInboundId`) (`replyDedupScope` in extensions/gateway/src/index.ts, `DedupScope` in extensions/gateway/src/dedup.ts; ARCHITECTURE.md §V S3 as amended 2026-09-28) — so an identical answer to a DIFFERENT message ("Done.", "OK") still sends, while a second send of one reply is dropped (pinned by `extensions/gateway/src/__tests__/dedup-reply-scope.test.ts`). Every reply path is pinned there, as is the scoped re-arm in `Gateway.recordRedelivered`; notices and agent-initiated sends stay content-only. Adapters call adapter.send(); the gateway gates the call with cache.shouldSend(sessionId, content, scope?) and silently drops duplicates. `shouldSend` records at the check, which is right only where the delivery ledger owns a failed send; a send with no ledger behind it (`Gateway.sendTo` / `sendAsBot` → `sendThrough`, i.e. `send_message`) treats `shouldSend` as a reservation — `record` commits it once the platform confirmed, `release` un-arms it on failure — so a failed send retried inside the TTL goes out instead of being reported sent (UBP-003), and a second identical send while the first is still in flight is not a second platform call: it shares the first one's outcome (V-GC-1, `Gateway.inFlightSends`; both pinned by `extensions/gateway/src/__tests__/dedup-send-retry.test.ts`).

Adapters do NOT roll their own dedup. A new adapter does not need an idempotency layer. If you find adapter-local dedup logic, it's a bug. A new adapter MUST populate `InboundMessage.botKey` from the token/credentials it was constructed with. Use `deriveBotKey()` from `packages/core/src/bot-key.ts` (re-exported by `@ethosagent/core`, with a config-shaped wrapper in `packages/config/src/index.ts`) to derive a stable default when no explicit `id` is configured.
Configuration: GatewayConfig.outboundDedupTtlMs (default 30_000). Set to 0 to disable, or set the env var ETHOS_DEDUP_LEGACY=1 for the hard-off rollback hatch (one-release escape valve; remove in next minor).
Session boundaries: /new and /personality clear the previous session's dedup keys so the same response text can be sent again under the fresh session key.
See extensions/gateway/src/dedup.ts and the tests in extensions/gateway/src/__tests__/dedup.test.ts.
