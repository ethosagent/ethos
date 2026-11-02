---
paths:
  - "extensions/gateway/**"
  - "extensions/platform-*/**"
  - "packages/core/src/agent-loop/audience.ts"
  - "packages/core/src/chat-audience.ts"
---

# Gateway audience and multi-bot

Who is listening is separate from how a message is routed. `InboundMessage.isDm` still decides admission, engagement and approval binding; whether private memory may be used is the turn's room audience, decided by `Gateway.audienceFor` (extensions/gateway/src/index.ts): private when `isDm && audienceHint !== 'shared'`, or when the chat is listed in `gateway.private_chats.<platform>` (read at construction — a change needs a restart, and a room removed from the list stays private until then). A new adapter MUST fail closed: anything that looks like a DM but may reach more than one person (an unverified email sender, a Discord group DM, a WhatsApp broadcast/newsletter JID) keeps its routing `isDm` and sets `audienceHint: 'shared'`. Every production `AgentLoop.run` call — the census finds `<receiver>.run(` whose receiver's last name ends in `loop`, the receivers in its `RECEIVER_ALIASES` table, and any `.run(` whose argument is an object literal with a `sessionKey` property — must pass `roomAudience` or carry an `// audience: private-by-design (<reason>)` marker, or `// audience: delegated (<where>)` for a wrapper whose host decides — pinned by `packages/core/src/__tests__/audience-census.test.ts`; end-to-end behaviour pinned by `extensions/gateway/src/__tests__/memory-boundary-e2e.test.ts`.

In multi-bot deployments, the gateway holds a `Map<botKey, AgentLoop>` — one loop per configured bot. The lane key is `${platform}:${botKey}:${chatId}` (not `${platform}:${chatId}` as in single-bot mode). Every adapter stamps `InboundMessage.botKey` so the gateway can route to the right loop. Adapters that do not support `botKey` (Discord, Email) fall back to the `defaultBotKey` in single-bot deployments; in multi-bot deployments their messages are dropped with an observability event. The per-bot botKey must be stable across restarts — use the optional `id:` field in config, or accept the sha256-derived default.
