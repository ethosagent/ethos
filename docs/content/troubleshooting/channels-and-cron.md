---
title: "Troubleshooting: channels, gateway and cron"
description: "Channel adapter, voice, gateway and cron job errors by symptom, with Cause, Fix and Prevent."
kind: reference
audience: shared
updated: 2026-11-03
---

## Synopsis {#channels-and-cron-synopsis}

Entries follow the same Cause / Fix / Prevent shape as [Troubleshooting](../troubleshooting.md).

## Channels and gateway {#channels-and-gateway}

### Duplicate outbound message on a channel adapter {#duplicate-outbound}

Cause · The [gateway](../getting-started/glossary.md#gateway) dedupes outbound messages with a 30-second TTL. A reply is keyed by `(sessionId, sha256(content), inbound message)`, so one reply sent twice is dropped while identical replies to two different messages both send (`replyDedupScope` in `extensions/gateway/src/index.ts`, pinned by `extensions/gateway/src/__tests__/dedup-reply-scope.test.ts`). Notices and agent-initiated sends (`send_message`) are keyed by `(sessionId, sha256(content))`: the same text to the same session within the window is silently dropped.

Fix · For an intentional retransmission of a notice or `send_message`, vary the text or wait the TTL. To disable, set `GatewayConfig.outboundDedupTtlMs: 0` or `ETHOS_DEDUP_LEGACY=1` (one-release rollback hatch).

Prevent · Do not roll adapter-local dedup. The gateway is the single dedup path; adapter dedup is a bug.

### Telegram or Discord bot does not respond {#bot-not-responding}

Cause · The bot's token is invalid or the bot is not added to the channel. An adapter that fails to start does not stop the other bots. A transient failure (a network error) is retried in the background, from 5 seconds up to every 5 minutes, until the adapter starts. A refused credential (`401`, `TokenInvalid`, `invalid_auth`) is logged as permanent and not retried (`startAdaptersIsolated` in `apps/ethos/src/commands/gateway.ts`). When every adapter's credential is refused, `ethos gateway start` exits with code `78`, which `ethos run-all` and the service templates do not restart. `ethos boot` keeps the web UI, cron and serve running and warns `no chat adapter started`, so you can fix the token in Settings.

Fix · Look in `~/.ethos/logs/gateway.log` for `adapter <id> failed to start` or `failed permanently`. For a permanent failure, re-run `ethos setup messaging`, paste a fresh token, and restart the gateway. Confirm the bot is in the target chat with the required permissions.

### `TEAM_MANIFEST_INVALID` {#team-manifest-invalid}

Cause · `team.yaml` failed to parse or failed schema validation. The offending field is named in the cause.

Fix · Fix the named field in `team.yaml` and re-run `ethos team start`.

### `ffmpeg not found` at gateway startup {#ffmpeg-not-found}

Cause · `ffmpeg` is not on the gateway's `PATH`. It is an optional runtime dependency: the gateway starts and runs without it, but it can only deliver a voice note whose container the TTS provider already produces, and it can only hand speech-to-text the platform's raw bytes.

Fix ·
1. Install it: `brew install ffmpeg`, `sudo apt-get install -y ffmpeg`, or `sudo dnf install -y ffmpeg`.
2. Confirm with `ffmpeg -version`.
3. If it is installed somewhere the gateway's `PATH` does not reach, set `voice.transcode.ffmpegPath` to the absolute path in `~/.ethos/config.yaml`.
4. Restart the gateway. The notice disappears.

Prevent · Add `ffmpeg` to the host's provisioning. The shipped Docker image does not include it — see [Run Ethos in Docker](../using/how-to/run-in-docker.md#prerequisites).

### Text reply arrives but the voice note does not {#voice-note-missing}

Cause · The reply was skipped, not lost, and the gateway recorded why. The four usual reasons: the platform was silenced with `voice.channels.<platform>.ttsOut: false`; the adapter declares no voice caps; the synthesized format is not one the adapter accepts and there is no `ffmpeg` to convert it; or the audio exceeded the platform's `maxBytes`.

Fix ·
1. Check `voice.channels.<platform>.ttsOut` — an explicit `false` outranks `/voice all`.
2. Check the channel supports voice out at all in the [capability matrix](../platforms/capability-matrix.md#voice-caps).
3. Install `ffmpeg` (above).
4. Check the conversation's mode with `/voice`.

Prevent · Run `ethos doctor` after changing voice providers; it reports which STT and TTS actually resolved.

### A voice note arrives twice, or long after the fact {#voice-note-redelivered}

Cause · Voice delivery is at-least-once. A synthesized reply whose send was never confirmed stays as a `pending` obligation in the delivery ledger and is re-sent at the next gateway start, bypassing the dedup cache on purpose.

Fix · Nothing, if it arrived. If pending obligations are accumulating, the underlying sends are failing — check the gateway log and the delivery readout in **Settings → Voice**.

Prevent · Bound the backlog with [`voice.artifacts.abandonAfterDays`](../using/reference/config-yaml.md#voice-artifacts) and `voice.artifacts.maxTotalMb`. See [Why does a redelivered voice note re-send the recording?](../building/explanation/why-voice-replies-redeliver.md).

### A voice memo is answered as if it were empty {#voice-in-empty}

Cause · The turn ran but carried no transcript, so it degraded to `(voice message)` rather than being dropped. Either no speech-to-text provider resolved, or the provider returned nothing usable, or the upload was never classified as audio in the first place.

Fix ·
1. Run `ethos doctor` and read its Voice section — it names the STT provider that actually resolved.
2. Check the recording's container. A `.webm` upload is treated as video on Slack and Discord and never reaches transcription; re-record as `.ogg`, `.m4a`, or `.mp3`.
3. Install `ffmpeg` (above) so the audio is normalized into a container the provider accepts.

Prevent · Check the [capability matrix](../platforms/capability-matrix.md#matrix) before assuming symmetry — voice in and voice out are separate capabilities.

## Cron and jobs {#cron-and-jobs}

### `JOB_NOT_FOUND` {#job-not-found}

Cause · The cron job id passed to `ethos cron remove`, `run`, or `disable` does not exist.

Fix · Run `ethos cron list` and copy the exact id.

### `JOB_LOCK_FAILED` {#job-lock-failed}

Cause · Another cron-mutating command is holding the lock.

Fix · Wait and re-run. If it repeats, check for a stuck `ethos cron` process and kill it.

### `CRON_INVALID` {#cron-invalid}

Cause · The cron expression failed validation.

Fix · Use a valid 5-field cron expression. Test on `https://crontab.guru` before re-running.

### `Job "<id>" is already running` {#cron-already-running}

Cause · `ethos cron run` or "Run now" was refused because a run of that job is still executing. A job never runs twice at once (`CronScheduler.runJobNow` in `extensions/cron/src/index.ts`). A run left behind by a crashed process does not cause this; that marker is ignored.

Fix · Wait for the run to finish, then run the job again. `ethos cron list` shows the job's last run.

### `CRON_TARGET_NOT_ALLOWED` {#cron-target-not-allowed}

Cause · A cron job's output had no bot to deliver it. Either no bot on that platform is bound to the job's personality, or the job predates recorded bots and the platform now has several (`createCronDeliver` in `apps/ethos/src/lib/cron-deliver.ts`).

Fix · Recreate the job from the chat it should reply to, so it records which bot to use.
