# Per-process detection fix

### The bug, confirmed live in production use

A user ran the shipped Phase 1-4 feature end-to-end: joined a real Zoom
call, got the notification, accepted it, capture started correctly. They
then **left the Zoom call but kept the Zoom app open** (did not Quit). The
capture never stopped — `audiotee`/`mic-capture` ran unattended for many
minutes after the call ended, because `call_ended` never fired.

**Root cause, confirmed empirically**: `kAudioDevicePropertyDeviceIsRunningSomewhere`
(what `native/mic-detector.swift` watched, per the "Approach: CoreAudio, not
`ioreg`" section above) is a **system-wide, device-level** flag — "is
anything using this input device at all." Zoom keeps it warm in the
background outside of active calls, so it never returns to `false` once
Zoom has touched the mic, regardless of whether a call is actually active.
Quitting Zoom entirely released it, but "quit the app to stop a stuck
recording" was rejected as a workaround, not a fix.

### The fix: per-PROCESS audio activity, not per-DEVICE

CoreAudio has a more precise API surface: translate a PID to its
`AudioProcess` object, then watch that SPECIFIC process's own running-input
state.

- `kAudioHardwarePropertyTranslatePIDToProcessObject` (on
  `kAudioObjectSystemObject`, `kAudioObjectPropertyScopeGlobal`) —
  translates a `pid_t` to an `AudioObjectID` representing that process
  within the audio HAL.
- `kAudioProcessPropertyIsRunningInput` (on that process's `AudioObjectID`)
  — a `UInt32` boolean: is this specific process currently running an input
  stream.

### Validation performed, and honestly which tier

**Mechanism tier (strongest tier achieved — no live Zoom call was available
in the validation environment):** a controlled two-process test proved the
exact property this fix depends on. A long-running `ffmpeg` process (B) held
the default input device the entire time. A second process (a small
`AVAudioEngine`-based "mic-toggler" harness, standing in for "an app that
opens the mic for a call, then leaves the call but stays running") captured
for 5 seconds, then **stopped its own engine while staying alive** for
another 10 seconds before exiting — simulating "leave the call, keep the app
open" precisely. A probe watching process A's own
`kAudioProcessPropertyIsRunningInput` (translated from its PID) observed:
`true` while A was capturing, transitioning to `false` within one poll tick
(~32ms) of A stopping its own engine — **while A was still alive** and
**while process B was still actively holding the device** (confirmed via
`kAudioDevicePropertyDeviceIsRunningSomewhere` staying `true` throughout).
This is exactly the property the device-wide flag lacked, proven against a
second, independent process holding the device the whole time.

**Empirical finding that changed the design — event listeners don't fire for
Process objects:** the original per-device code used
`AudioObjectAddPropertyListenerBlock` for genuinely event-driven detection,
and that mechanism still works fine for Device objects. The equivalent
listener on a Process object was tested and found NOT to fire: registration
succeeded (`status == noErr`) for `kAudioProcessPropertyIsRunningInput` and
`kAudioProcessPropertyIsRunning`, across both `kAudioObjectPropertyScopeGlobal`
and `kAudioObjectPropertyScopeInput` (three combinations total), but the
callback was never observed to fire during a real, confirmed transition —
while polling the identical property on the identical object correctly
observed every transition within one tick. This is not treated as a bug in
this package; `audiotee`'s own vendored README already carries an "API
Instability Warning" for this general area of CoreAudio (Process/Tap
objects, macOS 14.2+). Consequence: `native/mic-detector.swift` **polls**
the per-process property (every 2s), but only for the bounded set of
currently-running known calling apps (typically 0-1), and only while at
least one is open — app PRESENCE (which known apps are running, their PIDs)
is still fully event-driven via `NSWorkspace`, so the idle cost (no known
app open) stays at zero.

**A significant, honestly-reported residual finding:** while testing the
shipped binary against real processes on the validation machine, a genuine,
already-running `zoom.us` background process (not started by this testing —
elapsed ~26 minutes, holding open UDP sockets to a Zoom media relay on port
8801) reported `kAudioProcessPropertyIsRunningInput` **and**
`kAudioProcessPropertyIsRunningOutput` as `true`, continuously, with no
call visibly active from the outside. The validation environment has no
Accessibility/Screen Recording permission and could not capture a
screenshot or read window titles, so it was **not possible to conclusively
determine** whether this reflected a genuinely stuck "left a call, audio
engine didn't release" state (the same class of symptom the device-wide fix
was built to solve, just one layer deeper) or a benign always-on
"pre-warmed audio path" some calling apps may keep regardless of call state.
**This is reported as an open, unresolved risk, not swept under the rug:**
the per-process signal is a strict, proven improvement over the device-wide
one at the mechanism level (see above), but it may not be a complete fix for
every calling app's specific internal behavior. Anyone deploying this should
verify with a real call on their own machine: leave a call with the app
still open and confirm `mic-detector`'s aggregate returns to `false` within
a few seconds.

### Bounded safety net, added because of that residual finding

Because of the finding above, `CallCaptureDaemon` (`src/daemon.ts`) now
carries a **bounded maximum-capture-duration safety net** (default 4 hours,
configurable via `maxCaptureDurationMs`) **underneath** the real
`call_ended` signal — never a substitute for it. If `call_ended` never
arrives for an in-flight capture (whether because a given app's per-process
signal itself gets stuck warm, or any other reason), the safety-net timer
aborts the capture and logs a warning naming exactly what happened. This is
a deliberately different situation from the one a prior review round
rejected a bounded-duration fallback for ("don't build this as a substitute
for a real cancellation mechanism") — this is a net under a best-effort
precise signal, not instead of one, added in direct response to a concrete,
reproducible piece of evidence that the precise signal alone might not be
airtight for every app.

### Known-app tracking: `NSWorkspace`, not `pgrep` — and the old process-prefilter folded in

`native/mic-detector.swift` now tracks known calling apps (the same list
`process-prefilter.ts`'s `KNOWN_CALLING_APP_PROCESSES` has always had:
`zoom.us`, `Microsoft Teams`, `Discord`, `Skype`, `FaceTime`, `Webex`,
`GoToMeeting`) via `NSWorkspace.shared.runningApplications` for the initial
scan and `NSWorkspace.shared.notificationCenter`'s
`didLaunchApplicationNotification`/`didTerminateApplicationNotification` for
reactive, event-driven tracking as apps launch and quit — attaching/detaching
a per-process poll entry as each known app comes and goes, rather than
watching one fixed thing for the binary's whole lifetime.

**Match key, verified empirically:** `NSRunningApplication.executableURL?.lastPathComponent`
— NOT `.localizedName` or `.bundleIdentifier` — is the correct match key.
Checked against three installed apps' actual `Info.plist`:
`CFBundleExecutable` for `zoom.us.app` is `zoom.us`, for `Discord.app` is
`Discord`, for `FaceTime.app` is `FaceTime` — identical, in every case, to
the process name `pgrep -x` would have matched. This conveniently means the
existing `KNOWN_CALLING_APP_PROCESSES` list didn't need to change at all —
only how it's matched did. (`.bundleIdentifier` was deliberately avoided:
some of these apps, notably Teams, have shipped multiple bundle IDs across
"classic" vs. "new" client generations, which the executable name is more
stable against.)

**Multiple known apps open at once:** each tracked app's `running` state is
independent; the aggregate "a call is active" is `true` if ANY tracked app
shows running input, and only returns to `false` once ALL of them do —
`native/mic-detector.swift`'s `recomputeAggregate()`.

**The old `pgrep`-based process-prefilter gate is gone, not duplicated:**
see "Process prefilter (decision 1's coarse prefilter — SUPERSEDED, folded
into the detector)" above. The native detector only ever watches known
calling apps in the first place, so `CallCaptureDaemon` no longer takes a
separate `checkCallingAppRunning` port — every `call_started` event already
carries the triggering app's clean source label (`source` field, mapped by
`detector.ts` via `sourceLabelForProcessName`), which is at least as precise
as the old pgrep match (the daemon now knows exactly which app's PID
triggered the event, not just that some pgrep pattern matched somewhere).

**Unchanged by this fix:** the browser-based-call blind spot (Meet in
Chrome, etc. — browsers were never in `KNOWN_CALLING_APP_PROCESSES` and
still aren't, see the process-prefilter section above), the notification/
accept-gate mechanism (Phase 2), the capture pipeline itself (Phase 3's
`tap-capture.ts`/`mic-capture.ts`/`transcript-session.ts`), and the
memory-write/artifact/digest logic (`extensions/tools-callcapture`) except
that source labels can now be at least as precise as before, never less.
The floating recording-indicator UI (a separate, larger follow-up) remains
out of scope here too.

## Fix — native notification helper, replacing terminal-notifier (2026-08-18)

### The bug, and the friction that preceded it

A real user reported the `terminal-notifier` banner rendering with white,
hard-to-read text on their machine — almost certainly a Light/Dark Mode
re-theming failure. `terminal-notifier` is a third-party CLI we don't
control the source of and which gives no styling API, so this wasn't
something this package could special-case a color fix for. It was also the
second time `terminal-notifier` had been a source of friction: see
"Troubleshooting: notification permission granted but no banner appears"
above, a real production bug that needed a `killall NotificationCenter
usernoted` workaround.

### The fix: `UNUserNotificationCenter` directly, owned the way `mic-detector`/`mic-capture` already are

`native/notification-helper.swift` uses Apple's modern `UserNotifications`
framework directly instead of shelling out to `terminal-notifier`. Apple's
own templated banners are guaranteed to render correctly themed for the
system's current appearance — this fixes the reported bug as a side effect
of using the current-generation API, not a bespoke color hack. It also lets
the click be observed **inside the same process**, via
`UNUserNotificationCenterDelegate`'s `didReceive response:` callback —
`click-listener.ts` (the local loopback HTTP bridge that existed solely to
receive `terminal-notifier -execute`'s shell-out callback) is gone, along
with its test. `notification.ts`'s public contract
(`NotificationGate.presentCaptureOffer()` → `CaptureOfferHandle` with
`waitForOutcome()`/`expire()`) is unchanged — this is a pure internal
implementation swap. `daemon.ts` needed **zero changes**: it only ever
depended on that contract.
