# Native notification helper fix

### App-bundle requirement — empirically confirmed, not assumed

A bare command-line Mach-O executable calling `UNUserNotificationCenter
.current()` **crashes immediately**:

```
*** Terminating app due to uncaught exception 'NSInternalInconsistencyException',
reason: 'bundleProxyForCurrentProcess is nil: mainBundle.bundleURL file://...'
```

Verified directly on a real machine (macOS 26.2, Darwin 25.2). Wrapping the
same binary in a minimal `.app` bundle with a `CFBundleIdentifier` in its
`Info.plist` fixes this — no crash, a real `UNUserNotificationCenter`
instance. This is the same reason `terminal-notifier` itself ships its own
app bundle (`fr.julienxx.oss.terminal-notifier` — see the Troubleshooting
section above), not a difference between this helper and that one.

A second, less obvious requirement was also found empirically: the bundle
must be registered with Launch Services (`lsregister`) **from a stable,
non-ephemeral path**. The identical bundle run from `/private/tmp` failed
with `usernoted: Failed to find or validate client of identifier ...` in
the unified log (`log show`); the same bundle run from `/Applications` or a
normal path under `$HOME` (including this package's own `native/bin/`) was
correctly validated, and its authorization request actually reached
`usernoted` (status transitioned away from `notDetermined`). Neither
`AppKit` nor `NSApplication` was needed for any of this — plain
`Foundation` + `UserNotifications` is enough, contrary to the concern that
some `UserNotifications` APIs historically required a full app-bundle
*event loop* (not just a bundle identifier) to work from a bare executable.

`scripts/build-notification-helper.sh` (invoked from `build:native`, same
as `mic-detector`/`mic-capture`) does the wrapping: compiles the binary into
`native/bin/notification-helper.app/Contents/MacOS/notification-helper`,
writes `Info.plist` (`CFBundleIdentifier: ai.ethosagent.callcapture
.notification-helper`, `LSUIElement: true` — no Dock icon, no menu bar),
ad-hoc codesigns it (`codesign --sign -`, no paid Developer ID needed for a
local dev build), and registers it with Launch Services immediately so the
very first run doesn't race Spotlight/Launch Services' own lazy indexing.

### App icon

The notification banner shows the real Ethos brand icon (the round
blue-ring mark), not a generic default — `scripts/build-notification
-helper.sh` copies `apps/desktop/build/icon.icns` (the same icon the
desktop app ships, built from `apps/desktop/assets/brand/icon-1024.png`)
into the bundle's `Contents/Resources/icon.icns` and sets
`CFBundleIconFile`/`CFBundleIconName` in `Info.plist`. Verified empirically:
rendering the real built bundle's Launch-Services-resolved icon via
`NSWorkspace.icon(forFile:)` produced a 1024×1024 PNG that is visibly the
Ethos ring (byte-identical, 268355 bytes, to the same render of an earlier
test bundle wired the same way) — not a blank-document or generic-
executable placeholder, and not the same render as an unrelated app's icon
(`Terminal.app`, compared for contrast, different bytes and image). This is
the same LaunchServices icon-
resolution mechanism Finder/Dock/Spotlight/notification banners all share,
so the mechanism proof transfers; only the literal banner's rendered pixels
still need a human's eyes to confirm, same caveat as the click-bridge below.

### Protocol

One notification per process invocation (mirrors `mic-capture.swift`'s
one-process-per-session model, not `mic-detector.swift`'s persistent-
multi-event one) — simpler than routing a dismiss-by-identifier command
across multiple concurrently-open notifications in one process, and a
natural fit since `NotificationGate.presentCaptureOffer()` already mints
one offer per call.

```
argv:
  notification-helper --check-status          side-effect-free preflight
  notification-helper <callId> <title> <msg>  show one notification

stdout (NDJSON, one line per event):
  {"event":"status","status":"authorized"|"denied"|"notDetermined"}
  {"event":"shown"}
  {"event":"clicked","callId":"..."}   exits 0 right after
  {"event":"authDenied"}               not authorized; exits 1
  {"event":"error","message":"..."}    exits 1
```

**No stdin command channel.** Withdrawing a still-pending/delivered
notification is done by sending `SIGTERM` — `notification-helper` withdraws
both its pending and delivered notification (`removePendingNotification-
Requests`/`removeDeliveredNotifications`) before exiting cleanly. This is
simpler than a `{"command":"dismiss"}` stdin protocol and needs no
identifier disambiguation (there's only ever one notification per process),
and it's exactly `SpawnedChild`'s existing `kill()` idiom from
`detector.ts` — `NotificationGate`'s `expire()` calls `child.kill('SIGTERM')`
and awaits the process's own exit before resolving `'expired'`, confirming
the withdrawal actually ran (mirroring the old `terminal-notifier -remove`
implementation awaiting its exit the same way).

### Authorization — what was verified, and what honestly wasn't

`requestAuthorization` is called on first use if not already determined —
this is the genuine system "Allow Notifications from Ethos?" dialog,
interactive the way Camera/Microphone prompts already are for this
package's other native helpers, unlike `terminal-notifier` which apparently
never triggered it. Verified via the unified log that the request pipeline
works end-to-end once the app-bundle/Launch-Services conditions above are
met: `usernoted` recognizes the client and the authorization status
genuinely transitions away from `notDetermined`. What could **not** be
verified in this environment: this exec session has no interactive Aqua
session attached (confirmed separately — `open -W` on the bundle fails with
"Unable to block on applications"), so macOS auto-denies the request rather
than presenting the dialog to a human. A real user running `ethos serve`/
`ethos gateway` from their own interactive Terminal session should see the
real dialog, the same way every other macOS app using
`UNUserNotificationCenter` does. The same honesty standard applies here as
applied to the old click-bridge verification above: the plumbing is
provably correct end-to-end; only a human clicking "Allow" on a real dialog,
and then a real banner, needs the repo owner's own eyes to confirm.

### `terminal-notifier` fully retired from this package's runtime path

No remaining runtime dependency on it — `preflight.ts`'s
`checkCallCaptureDependencies()` checks `notification-helper` (binary
presence + authorization status) instead, `ethos doctor`'s "Call capture"
section names it in its dependency list, and the historical Phase 2
narrative above is left as-is (kept for history, per this file's own
convention — see the top of this file).

### Investigated, not a code bug: "whitish grey layer" on first banner, correct on click (2026-08-19)

A real user tested the new `notification-helper` banner and reported: *"there
is a whitish grey layer on top of it, when i click on it then it comes out to
be correct of dark grey background."* Given this immediately follows the
`terminal-notifier` dark-mode-legibility fix above, it needed a real
investigation, not an assumption either way.

**Ruled out as the cause, by reading `notification-helper.swift` and Apple's
`UNMutableNotificationContent` API surface:**

- `content.sound = .default` and no explicit `interruptionLevel` — the
  default interruption level is `.active`, which is the standard full-banner
  presentation; there is no undocumented "muted" interruption level, and
  `.timeSensitive` (which *would* require the
  `com.apple.developer.usernotifications.time-sensitive` entitlement this
  ad-hoc-signed, non-provisioned bundle doesn't have, and would silently
  downgrade to `.active` without it per Apple's docs) governs whether a
  notification breaks through Focus/DND, not its background material.
  Setting it explicitly would be a no-op for this symptom.
- No `categoryIdentifier`/registered `UNNotificationCategory` — this affects
  which action buttons a banner offers, not its background rendering.
- The `CFBundleIconFile`/`CFBundleIconName` icon added earlier this session —
  per Apple's notification layout, the app icon renders in its own fixed
  thumbnail slot, never as a background layer behind the banner's own chrome.
  Confirmed by re-reading the icon-wiring code in
  `scripts/build-notification-helper.sh`: it only ever touches
  `Contents/Resources/icon.icns`, nothing content/appearance-related.
- An Apple "delivery quietness" heuristic that mutes a *brand-new, untrained*
  app's banners until a few interactions "train" it — this was the leading
  hypothesis going in, but no Apple documentation, WWDC session, or developer
  forum thread supports it as a real mechanism. `Reduce Interruptions` Focus
  and notification summaries are real and interaction-adaptive, but they
  govern *whether/when* a notification is delivered, and are user-opt-in
  Focus features — not an automatic per-bundle-identity visual toning that
  self-resolves after a handful of clicks.

**What the evidence actually points to:** this environment is macOS 26.2
("Tahoe" — see the `Darwin 25.2` build note earlier in this doc), which
shipped a system-wide "Liquid Glass" material: a translucent, glass-like
rendering applied throughout system chrome, explicitly including
notification banners, per Apple's own design documentation. This is widely
and publicly documented (Apple's own 2025-06 design announcement; TidBITS
and MacRumors coverage of the macOS 26.1 update) as causing washed-out,
lower-contrast "whitish" appearance complaints broadly enough that Apple
shipped a direct fix for it in macOS 26.1: `System Settings → Appearance →
Liquid Glass → Clear/Tinted`, where `Tinted` raises the material's opacity
specifically to address this class of readability complaint. Critically,
this is OS-level system chrome — `UNMutableNotificationContent` exposes no
property that touches it (title, body, sound, `interruptionLevel`,
`categoryIdentifier`, attachments, badge — none of these are a background
material knob). This is the same "we don't control the source of the
banner's chrome" situation `terminal-notifier`'s original bug lived in, just
a different, OS-version-specific layer on top of it: the `UNUserNotification-
Center` migration's promise ("Apple's own templated banners are guaranteed
to render correctly themed") is still true and still confirmed by this same
report — the user's own words are that clicking through reveals the
*correct* dark grey background, i.e. the underlying Dark Mode theming this
package's fix was for is intact. The transient glass layer on top is a
separate, newer rendering behavior introduced by this OS version, not a
regression of it.

**Conclusion: expected macOS 26 system behavior, not a code bug.** No code
change was made — `notification-helper.swift` is unchanged from what's
described above. If a user wants a more opaque banner, the fix is on their
end: `System Settings → Appearance → Liquid Glass → Tinted`. This is
consistent with this package's standing principle (see the
`terminal-notifier` fix above) of not reaching for a bespoke color hack over
system-rendered chrome we don't own.
