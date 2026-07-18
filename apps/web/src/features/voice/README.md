# Browser talk-mode (Phase B UI)

Real-time voice UI for the Chat surface — the toggle, the in-call speaking
indicator/controls, and the live transcript. Part of
`plan/phases/gap-voice-realtime.md` Phase B.

## What ships here (verifiable, no native deps)

- **`voice-call-client.ts`** — the `VoiceCallClient` boundary: `connect` /
  `disconnect`, mute, mic stream for the level meter, and an event stream that
  mirrors `VoiceSessionEvent` (`extensions/voice-session/src/types.ts`). The
  default `createUnwiredVoiceCallClient()` reports the manual binding step
  instead of connecting, so the tree typechecks and tests without
  `livekit-client` or a running LiveKit server.
- **`voice-call-reducer.ts`** — the pure call state machine
  (`idle | connecting | listening | agent_speaking | interrupted | ended`),
  transcript accumulation, barge-in/interrupted handling, and the
  `voiceTranscriptToMessages` projection into the existing `MessageList`.
- **`useVoiceCall.ts`** — drives a `VoiceCallClient` through the reducer and owns
  the mic level meter (same AudioContext/analyser pattern as `useVoiceRecorder`).
- **`gating.ts`** — `personalityCanTalk(toolset)`: the §3(e) toolset gate.
- **`TalkMode.tsx`** — the toggle + in-call control bar + speaking indicator.

Unit tests cover the reducer (incl. barge-in), the gating predicate, and the
untrusted-JSON `parseVoiceCallControlEvent` guard. There is no
`@testing-library/react` / jsdom harness in this repo, so component rendering is
not tested; the toggle's gating is verified through the pure `personalityCanTalk`
function it calls.

## Going live — the manual `livekit-client` binding (NOT run in CI)

To talk in the browser end to end:

1. **Install the transport at the app layer** (not committed here):
   `pnpm --filter @ethosagent/web add livekit-client`.
2. **Implement `VoiceCallClient`** wrapping `livekit-client`: join the room
   (`Room.connect`), publish the local mic track (`createLocalAudioTrack` →
   `micStream()` returns its `MediaStream`), subscribe to the agent's remote
   audio track for playout, and translate inbound data-channel payloads into
   `VoiceCallEvent`s via `parseVoiceCallControlEvent` (never cast). `setMuted`
   toggles the published track.
3. **Point at the server side**: a running LiveKit server (or LiveKit Cloud) and
   the app-layer `LiveKitVoiceTransport` / `createLiveKitTransport`
   (`extensions/platform-voice/src/livekit/`) bridging the room to a
   `VoiceSession`. Bind a voice-capable personality per
   `extensions/platform-voice/README.md`.
4. **Inject the real factory**: pass `createClient` into `useVoiceCall` in
   `apps/web/src/pages/Chat.tsx` (defaults to the unwired client today).
5. **Verify**: talk to a personality whose toolset lists `voice_session`; assert
   **p50 utterance-end → first-audio ≤ 2.5s** (plan §3(c)) and that speaking over
   the agent (barge-in) stops playout in ~300ms and records `[interrupted]`.
