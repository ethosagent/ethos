# Ethos for iPhone (and Android)

`@ethosagent/mobile` is a remote for an `ethos serve` you already run: it holds a
server URL and a scoped API key, and renders the server's contracts. No agent
runs on the phone. Expo SDK 57 · React Native 0.86 · React 19.2.3 · expo-router ·
New Architecture · Hermes.

Phase 1 ships Connect, Chat (stream, status line, trail, approvals, clarify),
Sessions, Activity and More → Settings. Push, Agents, Teams, voice and the
long-tail screens come in later phases.

## Prerequisites

- Node 24 and pnpm 10 (the repo's own).
- For a device or simulator build: Xcode 26.4+ (iOS) or Android Studio (Android),
  and an EAS login (`npx eas login`) for a cloud build. `expo export` and the tests
  need neither.
- A reachable `ethos serve` at 0.8.1 or newer (the first release with
  `meta.whoami` and `/healthz` `version`).

## Commands

```sh
pnpm install                                   # from the repo root; default isolated linker
pnpm --filter @ethosagent/mobile typecheck     # tsc with Expo's tsconfig
pnpm --filter @ethosagent/mobile test          # the app's own vitest project (pure-TS cases)
pnpm --filter @ethosagent/mobile start         # Metro for a dev client
pnpm --filter @ethosagent/mobile prebuild      # generate ios/ and android/ (gitignored)
pnpm --filter @ethosagent/mobile ios           # build and run on a simulator or device
cd apps/mobile && npx expo export --platform ios   # Hermes bundle, no Xcode needed
```

The root `pnpm typecheck` and `pnpm test` already run the app's typecheck and
tests; the root vitest config excludes `apps/mobile`.

`APP_VARIANT` (`development` · `preview` · `production`) picks the bundle id —
`com.ethos.mobile.dev`, `.preview`, `com.ethos.mobile` — so the three builds can
sit on one phone.

## Pointing the app at your server

`ethos serve` binds `127.0.0.1` unless told otherwise, and a loopback server is
unreachable from a phone. The iOS simulator shares the Mac's network, so
`http://localhost:3000` works there, and the Android emulator reaches the Mac at
`http://10.0.2.2:3000` — but anything you test that way has not tested the address
a phone will use. Bind it where the phone can reach it:

```yaml
# ~/.ethos/config.yaml
web:
  host: 0.0.0.0        # or the Mac's tailnet / LAN address
```

Then mint a phone key — Settings → Mobile app → Generate QR code on the web, or
`ethos api-key create --preset phone --qr` — and scan it, or type the URL
(`http://192.168.1.20:3000`, `http://mac-mini.local:3000`, a tailnet name) and
the key. Connect runs two probes (`GET /healthz`, `meta.whoami`) and refuses a key
that lacks the phone's scopes or a server older than 0.8.1, naming the fix.

Plain `http` is allowed only to local-network hosts on iOS (ATS
`NSAllowsLocalNetworking`); Android allows cleartext everywhere. Prefer https
through a real certificate (Tailscale HTTPS, Let's Encrypt behind a proxy).

## Not in this build yet

- **Push.** Registration, category actions and dispatch are wired (T4) — but
  none of it reaches a device without EAS credentials and the two native
  targets below, and none of it reaches the simulator in any case; simulators
  do not receive APNs pushes. Approvals still arrive in the app over the stream.
- **Clarify notification actions.** The plan (D11) has a ≤3-option clarify
  push turn its options into notification actions; this build deliberately
  does not. An iOS category's action titles must be registered before the
  notification ever arrives, so a button could only ever read "Option 1/2/3",
  never the real option text, and the server's minimal payload never carries
  that text either (payload privacy, D11) — a lock-screen button that cannot
  name what it picks is worse than none. A clarify push carries no actions
  (`apps/mobile/src/push/categories.ts`); tapping it opens the app, where the
  real options are rendered and answered. Pinned by
  `apps/mobile/src/push/__tests__/categories.test.ts` and
  `apps/web-api/src/__tests__/services/push-dispatcher.test.ts`.
- **Fonts.** Geist / Geist Mono are not in the repo; content uses the platform font
  until they are embedded with the `expo-font` config plugin.
- **Markdown, attachments, swipe actions, the list spike.** Assistant text renders as
  plain text; Sessions verbs are on long-press only; the chat list is `FlatList`.
- **Live Activity rows.** `/sse/activity` frames are `ActivityEvent` envelopes, which
  the SDK's `EventStream` does not parse yet; Activity refreshes on focus and on pull.

## Manual device checklist (every TestFlight build)

**The Notification Service Extension is not implemented** (T-NATIVE — no Xcode
in this build environment). Until it exists, an approval banner shows only the
minimal push payload — `Ethos · <personality>` and "Wants to run `<tool>` ·
Open to review" — and never the tool's args; it is missing the args preview
the extension would fetch over the bearer key, not missing a safety check, so
this is fail-closed rather than broken. The checklist items below that depend
on the extension (the tool-args preview, the locked-phone read, the
server-unreachable fallback body) cannot be exercised until it ships.

- Lock-screen **Allow once** with the app force-quit: Face ID asked, then 20 of 20
  taps reach the server within 5 s; the banner is replaced in place by
  `✓ allowed once · <tool> · HH:MM` (then `resolved elsewhere` when the web decides first).
- The tool text shows on a LOCKED phone (the extension reads the key).
- An approval push breaks through a Focus mode as time-sensitive.
- Notification extension fails closed: server unreachable → `Open to review`, no Allow.
- Live Activity starts, ticks and ends.
- CallKit: an incoming phone call pauses and resumes a Call Stage call (Phase 3).
- Camera QR scan.
- Dark: tab and back tint and icons in `--info` (the light skin is not in this build).
- Perf pass on an iPhone 12, release build: cold start to an interactive Chat and the
  streaming numbers (≤ 1 dropped frame/s at 50 deltas/s into 500 messages), written
  into the build's release note.
- VoiceOver walk and an AX3 Dynamic Type pass of Connect → Chat → Sessions → Activity.
- The prototype's 23-step "Walk the flow" against the `marketing` team over Tailscale.
- A timed **cold install → first agent reply**, the seconds in the `mobile-v*` release note.
- T-ENV, once: plain-`http` connect from a device on a LAN address AND a tailnet
  (`100.64/10`) address in a release build; the import cost of
  `@ethosagent/web-contracts` (≤ 150 ms) and the median `SseEventSchema.parse`
  (≤ 0.2 ms at 50 frames/s) measured on an iPhone 12; the polyfills
  (`crypto.randomUUID`, `AbortSignal.timeout`) proven on the device.
