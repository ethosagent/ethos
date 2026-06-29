# Web/Desktop Voice Recording — Design Spec

**Date:** 2026-06-29
**Status:** Approved
**Scope:** Push-to-talk voice recording in the web/desktop chat UI with server-side STT

## Overview

A push-to-talk mic button in `Composer.tsx` that records audio via MediaRecorder, sends it to a new web-api `voice.transcribe` RPC endpoint, and auto-sends the transcript as a normal text message. Works on both web and desktop (same React codebase — desktop embeds `apps/web` via Electron).

## User Flow

1. User **holds** the mic button (appears in place of the send button when the text area is empty)
2. Recording indicator appears (pulsing red dot + elapsed time counter)
3. User **releases** — audio blob sent to server for STT transcription
4. Brief transcribing spinner shown in the composer area
5. Transcript inserted into composer and **auto-sent** as a text message
6. If STT fails, returns empty, or is filtered as hallucination — toast error, nothing sent

## Architecture

### Frontend (`apps/web`)

#### New: `useVoiceRecorder` hook (`apps/web/src/hooks/useVoiceRecorder.ts`)

Manages the MediaRecorder lifecycle:
- `startRecording()` — requests microphone permission, creates MediaRecorder (format: `audio/webm;codecs=opus` with fallback to `audio/webm`), starts collecting chunks
- `stopRecording()` — stops recorder, assembles Blob from chunks, returns it
- `cancelRecording()` — stops without returning data
- State: `{ isRecording: boolean, elapsedMs: number, error: string | null }`
- Cleanup: releases MediaStream tracks on unmount or cancel
- Permission: uses `navigator.mediaDevices.getUserMedia({ audio: true })` — Electron surfaces the OS permission dialog automatically

#### New: `VoiceButton` component (`apps/web/src/components/chat/VoiceButton.tsx`)

Push-to-talk button rendered in Composer when text input is empty:
- `pointerdown` → starts recording, button turns red with pulsing animation
- `pointerup` / `pointerleave` → stops recording, calls `onRecorded(blob: Blob)`
- Shows elapsed time (mm:ss) while recording
- Icon: microphone SVG, 16px, `strokeWidth="1.5"`, `fill="none"`, `stroke="currentColor"`
- Button: 32px circle, `background: var(--accent)` at rest, `background: var(--error)` when recording
- Pulsing animation on the recording state (CSS keyframe, ~1s period)
- Timer text: 12px/400 small style, `color: var(--text-secondary)`

#### Modified: `Composer.tsx` (`apps/web/src/components/chat/Composer.tsx`)

- When text input is empty AND no pending attachments: show `VoiceButton` instead of `SendButton`
- When text input has content: show `SendButton` as before (voice button hidden)
- On `onRecorded(blob)`:
  1. Show transcribing state (spinner in button area or small indicator)
  2. Call `rpc.voice.transcribe({ audio: base64(blob), mimeType: blob.type })`
  3. On success: call `onSend(transcript)` to auto-send as text message
  4. On error/empty: show toast notification, reset state
- The voice button and send button occupy the same position — they swap based on input emptiness

#### New: `transcribeAudio` function (`apps/web/src/lib/voice.ts`)

Utility that:
- Converts Blob to base64 string
- Calls `rpc.voice.transcribe({ audio, mimeType })`
- Returns the transcript string or throws on error/empty

### Backend (`apps/web-api`)

#### New: `voice.transcribe` RPC endpoint

**Input schema (Zod):**
```
{ audio: z.string() (base64-encoded), mimeType: z.string() }
```

**Output schema:**
```
{ transcript: z.string() }
```

**Handler:** `apps/web-api/src/features/voice/rpc/transcribe.ts`
- Decodes base64 → Buffer
- Writes to a temp file (STT providers expect a file path per the `SttProvider.transcribe(audioPath)` contract)
- Resolves the STT provider from the registry
- Calls `provider.transcribe(tempPath)`
- Applies hallucination filter (`isHallucination` from `@ethosagent/gateway/voice-pipeline`)
- Cleans up temp file
- Returns `{ transcript }` or throws if no STT provider configured / transcription empty after filtering

#### New: `VoiceService` (`apps/web-api/src/features/voice/service.ts`)

Wraps STT provider resolution and transcription:
- Constructed with `SttProviderRegistry`, provider name, provider config, and `SecretsResolver`
- `transcribe(audioBuffer: Buffer, mimeType: string): Promise<string>` — writes temp file, calls provider, filters, cleans up
- Lazy provider resolution (same pattern as Gateway's `resolveSttProvider`)

#### Modified: Web-API initialization

The `createWebApi` function (or its caller in `apps/desktop/src/main/serve.ts` and wherever the web-api is started) needs to receive and thread the STT provider registry + config. This uses the same `CreateAgentLoopResult.sttProviders` and `CreateAgentLoopResult.voiceConfig` fields we already added.

### Contract additions (`@ethosagent/web-contracts`)

Add the `voice.transcribe` RPC schema to the web-contracts package so both client and server share the typed contract.

## Design System Compliance

Per DESIGN.md:
- **Icon:** 16px stroke SVG, `strokeWidth="1.5"`, `fill="none"`, `stroke="currentColor"`
- **Button:** 32px circle, `border-radius: 9999px`, `background: var(--accent)`, personality-accent-aware
- **Recording state:** `background: var(--error)` with pulsing animation
- **Timer:** 12px/400 (small), `color: var(--text-secondary)`
- **Spacing:** 8px grid alignment — button occupies same grid cell as send button
- **No extra chrome:** button appears only when useful (empty input), disappears when typing

## Electron Considerations

- Chromium's MediaRecorder API works in Electron out of the box
- Microphone permission: Electron surfaces the OS permission dialog on first `getUserMedia` call
- May need `session.setPermissionRequestHandler` in `apps/desktop/src/main/index.ts` to auto-grant or show a custom prompt — verify during implementation
- Audio format: `audio/webm;codecs=opus` is universally supported in Chromium

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Microphone permission denied | Toast: "Microphone access required for voice input" |
| No STT provider configured | Toast: "Voice transcription not configured — set auxiliary.asr in config" |
| STT returns empty / hallucination | Toast: "Could not transcribe audio — try again" |
| Network error during transcribe | Toast: "Transcription failed — check connection" |
| Recording too short (<500ms) | Discard silently (likely accidental tap) |
| Recording too long (>120s) | Auto-stop at 120s, send what we have |

## Scope Boundaries

### In scope
- Push-to-talk mic button in Composer
- `useVoiceRecorder` hook with MediaRecorder
- Server-side STT via existing provider registry
- Hallucination filtering
- Auto-send transcript as text message
- Error handling and toast notifications
- Works on web + desktop (same code)

### Out of scope (future work)
- TTS audio playback of agent responses
- `/voice` mode toggle in web UI
- Audio message bubbles (showing waveform/player)
- Client-side speech recognition (Web Speech API)
- Streaming/real-time transcription
- Voice activity detection (VAD)
- Audio file upload via attachment picker

## File Inventory

| File | Action | Layer |
|------|--------|-------|
| `apps/web/src/hooks/useVoiceRecorder.ts` | New | Frontend |
| `apps/web/src/components/chat/VoiceButton.tsx` | New | Frontend |
| `apps/web/src/components/chat/Composer.tsx` | Modified | Frontend |
| `apps/web/src/lib/voice.ts` | New | Frontend |
| `apps/web-api/src/features/voice/service.ts` | New | Backend |
| `apps/web-api/src/features/voice/rpc/transcribe.ts` | New | Backend |
| `packages/web-contracts/src/voice.ts` | New | Contract |
| `apps/desktop/src/main/serve.ts` | Modified | Desktop wiring |

## Acceptance Criteria

1. When the text area is empty, a mic button appears where the send button normally is
2. Holding the mic button records audio; releasing sends for transcription
3. Transcript is auto-sent as a normal text message — the agent responds to it
4. Recording indicator (red pulse + timer) visible during recording
5. Graceful handling of: no mic permission, no STT configured, transcription failure, empty result
6. Works in both web browser and Electron desktop app
7. Recordings under 500ms are discarded (accidental tap protection)
8. Recordings auto-stop at 120s
9. No audio data reaches the LLM — only the transcribed text (consistent with §10 anti-goals)
10. STT provider is resolved from the registry, not hardcoded (consistent with voice-sdk architecture)
