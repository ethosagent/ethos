# Browser talk-mode: going live

[Back to the talk-mode guide](../README.md)

## Going live

Nothing here needs a native dependency or a LiveKit server any more. Both tiers
are wired in `Chat.tsx` and reachable from a running deployment:

1. **Enable the personality.** Its `toolset.yaml` must list `voice_session`, or
   the phone button renders disabled with a tooltip saying so.
2. **Configure the pipeline tier** — `auxiliary.asr.*` and `auxiliary.tts.*`. See
   `docs/content/using/how-to/local-voice.md`. This alone gives you a working
   call.
3. **Configure the realtime tier, optionally** — a `voice.realtime.providers.<name>`
   entry, `voice.realtime.default`, and `voice.tier: realtime`. Only
   `openai-realtime` can serve a browser: `gemini-live` declares
   `caps.ephemeralToken: false`, so the mint refuses `no_browser_token` and the
   call runs on the pipeline behind a visible notice. There is no server-relay
   path.
4. **Run it**: `make web`, then the phone icon in the personality bar.

LiveKit and SIP remain the *server-side* `VoiceSession` transports
(`extensions/platform-voice/`) and are unrelated to this directory. They still
need their own bindings; see that package's README.

### What only a human can verify

Nothing in CI drives real audio. Check by hand: a real mic and speakers (capture
at the provider's own input rate — 24 kHz for OpenAI Realtime, nothing
resamples), audible barge-in stopping playout in ~300ms and recording
`[interrupted]`, the thinking earcon, the screen wake lock, and a real network
blip on a phone exercising both socket backoffs independently. For mouth-to-ear
numbers use `pnpm bench:voice:live:realtime` or the deployment's own
`realtime_first_audio` spans — see `docs/testing/latency-bench.md` (§6b).
