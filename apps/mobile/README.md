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
  and an EAS login (`npx eas login`) for a cloud build. `expo export`, the tests,
  and Expo Go need none of this — see "Run it locally" below.
- A reachable `ethos serve` at 0.8.1 or newer (the first release with
  `meta.whoami` and `/healthz` `version`) — or a server run from source under
  `tsx`, which reports `"version":"dev"` and is treated as satisfying any
  floor (`versionAtLeast` in `apps/mobile/src/api/scopes.ts`).

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

## Run it locally

Three ways to see the app, fastest first:

1. **Expo Go.** `pnpm --filter @ethosagent/mobile start`, then scan the QR code
   with the Expo Go app (App Store / Play Store) — no Xcode, no Android
   Studio, no Apple account, no `prebuild`. Nothing in this app's dependency
   list is a bespoke native module: `expo-camera`, `expo-secure-store` and
   `expo-haptics` are modules Expo Go ships for every SDK-57 project, and the
   native tab bar (`expo-router/unstable-native-tabs`) is built on
   `react-native-screens`, the same native primitive Expo Go already bundles
   for Expo Router's stack navigation — so Connect, Chat, Sessions and
   Activity should all render. What does NOT work: registering for remote
   push. `expo-notifications` dropped push support in Expo Go as of SDK 53 —
   confirmed in the installed package
   (`expo-notifications/build/warnOfExpoGoPushUsage.js` throws on Android and
   warns on iOS, both naming SDK 53). Approvals still arrive over the `/sse`
   stream while the app is foregrounded; see "Not in this build yet" → Push.
2. **iOS Simulator** (`pnpm --filter @ethosagent/mobile ios`, or
   `npx expo run:ios` from `apps/mobile`) — a real dev client, one step
   closer to a device build, but simulators never receive APNs pushes either
   way.
3. **Device dev build via EAS** (`npx eas login`, then an EAS build profile)
   — the only path that can receive an actual push, exercise the manual
   device checklist below, and test cleartext / Local Network behavior the
   way a real phone will see it.

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

## Voice on a real iPhone (free provisioning)

A call needs the native audio library (`react-native-audio-api`), so it never
runs in Expo Go (the composer shows no mic there) and has not been exercised in
the simulator. This is the `sideload` variant: signed by a free Personal Team,
no push, no TestFlight, installed straight from a Mac over a cable.

1. **Install Xcode** — free, from the Mac App Store. Open it once and let it
   install its components.
2. **Sign into Xcode with an Apple ID** — Xcode → Settings → Accounts → `+` →
   Apple ID. That creates a free **Personal Team**. Its team id is the 10
   characters shown beside it (or in Keychain Access under the
   "Apple Development" certificate's Organizational Unit).
3. **Enable Developer Mode on the iPhone** — plug it in and trust the Mac, then
   Settings → Privacy & Security → Developer Mode → on, and restart when asked.
4. **Server.** `web.host` must be reachable from the phone (a LAN or tailnet
   address, not `127.0.0.1`), and the phone's key must hold `voice:talk`.
   Keys minted before Phase 3 lack it — the app still connects, but shows no
   mic. Mint a fresh one and reconnect:

   ```sh
   ethos api-key create --preset phone --qr
   ```

   The personality you call also needs `voice_session` in its `toolset.yaml`.
5. **Prebuild the sideload variant** (the variable names are the ones
   `app.config.ts` reads; the bundle id must be one no one else has claimed):

   ```sh
   cd apps/mobile
   APP_VARIANT=sideload ETHOS_APPLE_TEAM_ID=<team> ETHOS_SIDELOAD_BUNDLE_ID=com.<you>.ethos \
     npx expo prebuild -p ios --clean
   ```

6. **Build and install** (same three variables in the environment):

   ```sh
   APP_VARIANT=sideload ETHOS_APPLE_TEAM_ID=<team> ETHOS_SIDELOAD_BUNDLE_ID=com.<you>.ethos \
     npx expo run:ios --device --configuration Release
   ```

7. **Trust the developer profile** on the phone — Settings → General → VPN &
   Device Management → your Apple ID → Trust. The first launch fails until you do.
8. **It expires after 7 days** (a Personal Team's provisioning profile). Re-run
   step 6.

### Acceptance checks

Record each as PASS/FAIL with the date, device and iOS version.

- **Start a call from the composer mic.** The Call Stage opens with no tab bar,
  the mono `provider · model` line fills, and after the first reply it carries `NNNms`.
- **Lock the screen mid-reply.** The audio continues to the end of the reply,
  and the next turn is heard with the screen still locked.
- **Take a real incoming phone call.** The stage reads `held · phone call`,
  then the call resumes by itself after you hang up. **If it does not resume,
  record it** — that is the trigger for the CallKit escalation
  (`react-native-callkeep`, plan T7).
- **Talk over the agent (barge-in).** Playout stops and the agent's line in
  `This call` is marked `[interrupted]`.
- **The speaker-echo test.** On speakerphone, with nobody speaking, does the
  agent interrupt itself? **If yes, record it** — that is the trigger for moving
  the engine to the pinned RNAA 1.0 nightly with voice processing (echo
  cancellation; only `src/voice/engine.ts` changes).
- **A mid-call clarify fills the slot.** Ask for something that makes the agent
  ask a question: it appears in the reserved slot at the base of `This call`
  without moving anything, and answering collapses it to `✓ answered · clarify`.

### Measurement

1. On the iPhone: Settings → Developer → **Network Link Conditioner** → Add a
   profile named **Ethos LTE lossy**: 75 ms delay and 3 % packet loss, each
   way (in and out). The bar assumes 100 ms of jitter too; if the form has no
   jitter field, **record that** — it is a known deviation from the bar, not
   something to drop silently.
2. With the profile on, run **50 turns on the realtime tier** and **50 on the
   pipeline tier** (a personality with `voice.tier: pipeline`), **20 barge-in trials**, and **3 min of agent speech** lossy — then
   **3 min on plain Wi-Fi** with the conditioner off.
3. After each run: More → Settings → Developer → **Share call trace**, and save
   the JSONL to the Mac (AirDrop). It is the last call's trace, so share before
   starting the next call.
4. Grade it:

   ```sh
   node apps/mobile/scripts/voice-trace-report.mjs <file> --tier=realtime   # or --tier=pipeline
   ```

   Exit 0 is PASS, 1 is FAIL. Record PASS/FAIL per tier with the printed numbers.

### What needs the paid Apple program (skipped)

Push notifications (the `aps-environment` entitlement), TestFlight, and the
Notification Service Extension all need a paid Apple Developer Program
membership. The sideload build strips the push entitlements, so approvals and
questions reach it over the open stream only.

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
