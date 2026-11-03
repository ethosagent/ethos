# @ethosagent/voice-realtime-protocol

## Purpose

The one realtime speech-to-speech wire mapping: per-provider frame codecs (OpenAI Realtime, Gemini Live), the session core that owns the event stream, and the socket seam they sit on. It is shared by the server-side providers and the browser-direct client, so it uses no `ws` and no `node:` builtin.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `createRealtimeProtocolSession` | function | Builds an unconnected realtime session from a codec and a socket factory. |
| `RealtimeProtocolSessionOptions` | type | Options for `createRealtimeProtocolSession`. |
| `UnconnectedRealtimeSession` | type | The session handed back before it connects. |
| `RealtimeSessionCore` | class | Owns the event stream for one session. |
| `MAX_PENDING_AUDIO_FRAMES` | const | Cap on audio frames buffered before the socket is open. |
| `createOpenAiRealtimeCodec` | function | Frame codec for OpenAI Realtime. |
| `openaiRealtimeBrowserSubprotocols` | function | WebSocket subprotocols for a browser-direct OpenAI connection. |
| `OPENAI_REALTIME_INPUT_SAMPLE_RATE` | const | Input PCM sample rate for OpenAI Realtime. |
| `OPENAI_REALTIME_OUTPUT_SAMPLE_RATE` | const | Output PCM sample rate for OpenAI Realtime. |
| `createGeminiLiveCodec` | function | Frame codec for Gemini Live. |
| `GEMINI_LIVE_INPUT_SAMPLE_RATE` | const | Input PCM sample rate for Gemini Live. |
| `GEMINI_LIVE_OUTPUT_SAMPLE_RATE` | const | Output PCM sample rate for Gemini Live. |
| `RealtimeProtocolCodec` | type | The codec interface each provider implements. |
| `RealtimeProtocolHandshake` | type | What a codec returns to open a connection. |
| `RealtimeDecodeResult` | type | Result of decoding one inbound frame. |
| `RealtimeSocket` | type | Minimal socket the session talks to. |
| `RealtimeSocketFactory` | type | Creates a `RealtimeSocket`. |
| `RealtimeSocketHandlers` | type | Callbacks a socket delivers into the session. |
| `RealtimeSocketInit` | type | Init arguments for a socket factory. |
| `pcmToBase64` | function | Encodes PCM audio as base64. |
| `base64ToPcm` | function | Decodes base64 to PCM audio. |

## Seam

Support-layer package (see `architecture.config.ts`). Its dependency on the contracts package is the only runtime dependency declared in `package.json`. The browser-safety rule (no `ws`, no node builtin reachable from the entry) is pinned by `src/__tests__/browser-safety.test.ts`.

## Testing

```
pnpm vitest run packages/voice-realtime-protocol
```

- `src/__tests__/browser-safety.test.ts`: no `ws` or node builtin is reachable from the entry, and no runtime dependency beyond `@ethosagent/types`.
