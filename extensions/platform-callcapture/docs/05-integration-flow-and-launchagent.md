# Phase 4 flow diagram and LaunchAgent

### Flow diagram — as actually built

The plan doc's original diagram (see
`plan/phases/call-capture-extension.md` (local working notes, not in the repo),
"## Architecture" → "### Flow diagram") assumed the same shape this phase
shipped, with one correction: cancellation was an open question there
("whether the existing `before_tool_call` approval gate can be reused
as-is... is unresolved") and is now resolved, in favor of the
already-existing `abortSignal` mechanism above rather than any approval-gate
adaptation.

```
 [Persistent host: ethos serve, macOS + callCapture.personalityId set]
                    |
                    v
        +-----------------------+
        | CallCaptureDaemon:    |
        | Phase 1 detector      |
        | (MicActivityDetector) |
        +-----------------------+
                    |
                    v  call_started
        +-----------------------+
        | checkCallCaptureDeps  |------ missing dep --> [logged error, no
        | (T5 combined preflight)|      notification, daemon stays idle]
        +-----------------------+
                    |  ok
                    v
        +-----------------------+
        | wake (audit leg, same |
        | closure as            |
        | WatcherManager)  ---> logged into the bound personality's session
        +-----------------------+
                    |
                    v
        +-----------------------+
        | NotificationGate      |------ capture-offer-card missing/spawn
        | .presentCaptureOffer  |       fail --> outcome 'error', logged
        +-----------------------+
                    |
        +-----------+-----------+
        |                       |
        v                       v
   [expired/error] -->     [accepted]
   no capture, logged           |
                                 v
                    +-----------------------+
                    | runCapture(abortSignal)|
                    | --> runCallCapture(    |
                    |   callCaptureOpts, {   |
                    |   sessionKey:          |
                    |   callcapture:<id>,    |
                    |   abortSignal, ... })  |
                    | (direct dispatch — no  |
                    |  LLM turn, no tool     |
                    |  registry; the click   |
                    |  above WAS the only    |
                    |  approval needed)      |
                    +-----------------------+
                                 |
                                 v
                    +-----------------------+
                    | TapCapture + MicCapture|
                    | --> streamed STT       |
                    +-----------------------+
                                 |
                    call_ended  |  runs until aborted
                    (daemon)    v
                    +-----------------------+
                    | controller.abort()    |
                    | --> runCallCapture     |
                    |     stops both         |
                    |     streams, saves     |
                    |     whatever was       |
                    |     captured           |
                    +-----------------------+
                                 |
                                 v
                    +-----------------------+
                    | summarizeTranscript    |
                    | (LLM content summary,  |
                    | decision 7)            |
                    | --> memory.sync():     |
                    |     transcript artifact|
                    |     + digest index     |
                    +-----------------------+
                                 |
                                 v
                    [searchable transcript + summary in memory]
```

### Running as a LaunchAgent

Call capture needs one of the always-on host commands (`ethos serve` or
`ethos gateway`, see "Phase 4 — Integration" above) running continuously —
in practice, that means registering it as a macOS LaunchAgent so it survives
reboots and login, per plan/phases/call-capture-extension.md's "Preflight"
§6. This mirrors [`docs/content/using/how-to/run-as-daemon.md`](../../../docs/content/using/how-to/run-as-daemon.md)'s
launchd section exactly (that page is the canonical reference for daemonizing
any long-running `ethos` command); this section names the specific plist for
`ethos serve`, since that is the more common single-user host choice for a
personal machine running call capture. `ethos gateway` works identically for
this purpose given the wiring above — swap `serve` for `gateway start` in
`ProgramArguments` and the label/log paths below.

First, confirm how `ethos` actually resolves as an executable on your
machine — a global install (`npm install -g @ethosagent/cli` or the pnpm
equivalent) publishes a real `ethos` binary via `apps/ethos/package.json`'s
`bin` field:

```bash
which ethos
# e.g. /opt/homebrew/bin/ethos, or ~/.nvm/versions/node/v24.x.x/bin/ethos
```

Paste that absolute path into `ProgramArguments` below — service managers do
not source your shell rc, so a bare `ethos` will not resolve.

Write `~/Library/LaunchAgents/ai.ethosagent.callcapture.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.ethosagent.callcapture</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/ethos</string>
    <string>serve</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/YOUR_USERNAME</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USERNAME</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/YOUR_USERNAME/.ethos/logs/callcapture.out.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USERNAME/.ethos/logs/callcapture.err.log</string>
</dict>
</plist>
```

Replace `/opt/homebrew/bin/ethos` with your own `which ethos` output and
`YOUR_USERNAME` with the output of `whoami`. Then load and start:

```bash
launchctl load ~/Library/LaunchAgents/ai.ethosagent.callcapture.plist
launchctl start ai.ethosagent.callcapture
launchctl list | grep ethosagent
tail -f ~/.ethos/logs/callcapture.out.log
```

Verify the daemon actually started (the log should show `CallCaptureDaemon`
construction and `MicActivityDetector` startup, and `ethos doctor` should
report the "Call capture" section's daemon heartbeat as `ok` within ~10s —
see "`ethos doctor` integration" above).

Stop, unload, or reload after an `ethos upgrade`:

```bash
launchctl stop   ai.ethosagent.callcapture
launchctl unload ~/Library/LaunchAgents/ai.ethosagent.callcapture.plist
# after upgrading:
launchctl stop ai.ethosagent.callcapture && launchctl start ai.ethosagent.callcapture
```

`RunAtLoad` plus the `~/Library/LaunchAgents/` location starts the daemon at
login; `KeepAlive` restarts it on crash. See `docs/content/using/how-to/
run-as-daemon.md`'s "Troubleshoot" section for the general daemon-launch
failure modes (stripped `PATH`/`HOME`, `nvm`-installed binaries, etc.) — they
apply here unchanged, since this is the same launchd mechanism wrapping a
different `ethos` subcommand.

## Fix — per-process detection (2026-08-18)
