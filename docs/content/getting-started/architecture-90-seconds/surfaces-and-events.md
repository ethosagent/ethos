---
title: "Why do all surfaces share one AgentEvent stream?"
description: "The surface architecture and the AgentEvent streaming contract."
kind: explanation
audience: shared
updated: 2026-11-03
---

## Context

This page covers how every surface consumes the same event stream.

## The surface architecture

`AgentLoop` is a library. It does not know what is consuming its events. Nine surfaces ship today — all of them thin wrappers that feed user input into the loop and render whichever `AgentEvent` subset matters for their medium.

<figure class="ethos-figure"><div class="ethos-figure-pad"><svg viewBox="0 0 680 448" role="img" aria-label="Surface architecture diagram. AgentLoop, an AsyncGenerator of AgentEvent, feeds web-api (Hono plus oRPC, HTTP plus SSE for browser clients), which feeds two apps: Web (React, ethos serve) and Desktop (Electron, native tray and global shortcuts). A separate group of direct consumers holds CLI (readline REPL), TUI in Ink (React-Ink terminal dashboard), VS Code extension (sidebar panel in editor), MCP server (serves Ethos as MCP tools), and ACP server (Agent Communication Protocol). A second group holds the channel adapters reached via the gateway: Telegram, Discord, Slack, WhatsApp, and Email." font-family="Geist Mono,monospace">
<defs><marker id="arch90-surface-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#70706B"/></marker></defs>
<rect x="140" y="10" width="400" height="52" rx="10" fill="#9BDDB4" fill-opacity="0.08" stroke="#9BDDB4"/>
<line x1="340" y1="62" x2="340" y2="86" stroke="#70706B" marker-end="url(#arch90-surface-arrow)"/>
<rect x="140" y="90" width="400" height="52" rx="10" fill="#9CC5F2" fill-opacity="0.08" stroke="#9CC5F2"/>
<line x1="215" y1="142" x2="215" y2="166" stroke="#70706B" marker-end="url(#arch90-surface-arrow)"/>
<line x1="465" y1="142" x2="465" y2="166" stroke="#70706B" marker-end="url(#arch90-surface-arrow)"/>
<rect x="110" y="170" width="210" height="56" rx="10" fill="#D8A5E8" fill-opacity="0.08" stroke="#D8A5E8"/>
<rect x="360" y="170" width="210" height="56" rx="10" fill="#D8A5E8" fill-opacity="0.08" stroke="#D8A5E8"/>
<rect x="30" y="256" width="620" height="104" rx="10" fill="#EAC98F" fill-opacity="0.08" stroke="#EAC98F"/>
<rect x="30" y="380" width="620" height="56" rx="10" fill="#9BDDB4" fill-opacity="0.08" stroke="#9BDDB4"/>
<g font-size="13" fill="var(--ethos-text-primary)">
<text x="340" y="32" text-anchor="middle">AgentLoop</text>
<text x="340" y="112" text-anchor="middle">web-api (Hono + oRPC)</text>
<text x="215" y="192" text-anchor="middle">Web (React)</text>
<text x="465" y="192" text-anchor="middle">Desktop (Electron)</text>
<text x="50" y="278">Direct consumers</text>
<text x="92" y="306" text-anchor="middle">CLI</text>
<text x="216" y="306" text-anchor="middle">TUI (Ink)</text>
<text x="340" y="306" text-anchor="middle">VS Code ext.</text>
<text x="464" y="306" text-anchor="middle">MCP server</text>
<text x="588" y="306" text-anchor="middle">ACP server</text>
<text x="50" y="402">Channel adapters (via gateway)</text>
<text x="92" y="424" text-anchor="middle">Telegram</text>
<text x="216" y="424" text-anchor="middle">Discord</text>
<text x="340" y="424" text-anchor="middle">Slack</text>
<text x="464" y="424" text-anchor="middle">WhatsApp</text>
<text x="588" y="424" text-anchor="middle">Email</text>
</g>
<g font-size="11" fill="var(--ethos-text-secondary)">
<text x="340" y="50" text-anchor="middle">AsyncGenerator&lt;AgentEvent&gt;</text>
<text x="340" y="130" text-anchor="middle">HTTP + SSE for browser clients</text>
<text x="215" y="210" text-anchor="middle">ethos serve</text>
<text x="465" y="210" text-anchor="middle">native tray, global shortcuts</text>
<text x="92" y="326" text-anchor="middle">readline</text>
<text x="92" y="342" text-anchor="middle">REPL</text>
<text x="216" y="326" text-anchor="middle">React-Ink</text>
<text x="216" y="342" text-anchor="middle">terminal dashboard</text>
<text x="340" y="326" text-anchor="middle">sidebar panel</text>
<text x="340" y="342" text-anchor="middle">in editor</text>
<text x="464" y="326" text-anchor="middle">serves Ethos</text>
<text x="464" y="342" text-anchor="middle">as MCP tools</text>
<text x="588" y="326" text-anchor="middle">Agent Comm.</text>
<text x="588" y="342" text-anchor="middle">Protocol</text>
</g>
</svg></div><figcaption>Nine surfaces consume the same AgentLoop event stream: web and desktop through web-api, five direct consumers in-process, and five channel adapters via the gateway.</figcaption></figure>

The web and desktop apps connect through the same `web-api` layer — a Hono HTTP server with oRPC-typed endpoints that streams `AgentEvent` over SSE. This is the only API surface; there is no separate REST API. Both apps talk to the same `AgentLoop` instance the CLI uses.

Direct consumers embed the loop in-process. The CLI, TUI, and VS Code extension each construct an `AgentLoop` and consume its generator directly. The MCP server and ACP server wrap the loop behind their respective protocols, letting external agents call Ethos tools or delegate tasks to Ethos personalities.

Channel adapters are the thinnest layer. Each adapter translates platform-specific webhook payloads into `InboundMessage` and renders `AgentEvent` back into platform-specific API calls. The gateway handles dedup, routing, and per-bot loop isolation.

## AgentEvent — the streaming contract

Everything the agent does is one of these eight event types:

```typescript
type AgentEvent =
  | { type: 'text_delta';     text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_start';     toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_progress';  toolName: string; message: string; percent?: number }
  | { type: 'tool_end';       toolCallId: string; toolName: string; ok: boolean; durationMs: number }
  | { type: 'usage';          inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'error';          error: string; code: string }
  | { type: 'done';           text: string; turnCount: number }
```

Consuming the generator:

```typescript
for await (const event of agentLoop.run('explain this codebase')) {
  if (event.type === 'text_delta') process.stdout.write(event.text)
  if (event.type === 'tool_start') console.log(`\n[${event.toolName}]`)
  if (event.type === 'done') console.log(`\nTurns: ${event.turnCount}`)
}
```

A surface (CLI, channel adapter, web UI) renders whichever subset of events it cares about. The contract is the same everywhere — same event types, same fields, same semantics.

## See also

- [What does Ethos look like in 90 seconds?](../architecture-90-seconds.md) — the parent page.
