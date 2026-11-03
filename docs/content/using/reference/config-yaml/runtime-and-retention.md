---
title: "config.yaml: execution, display, retention and notifications"
description: "config.yaml execution, display, retention and notification keys."
kind: reference
audience: user
updated: 2026-11-03
---

## Synopsis {#synopsis}

Keys that shape execution, display, retention and notifications. Part of the [config.yaml reference](../config-yaml.md).

## execution.docker.\* {#execution-docker}

Type: dotted group · Default: per-field below

The container every docker-sandboxed tool call runs in. A personality whose toolset includes `terminal`, `run_code`, `run_tests`, `lint` or a `process_*` tool, and which declares no `execution:` requirement, resolves to the `docker` posture (unless Ethos itself runs in a container). Those tools run inside `execution.docker.image` and nothing else.

| Field | Type | Default | Description |
|---|---|---|---|
| `execution.docker.image` | string | unset | The sandbox image, **digest-pinned**: `<image>@sha256:<64 hex digits>`. Required for the docker posture to execute anything. Unset → every exec tool returns `Docker sandbox has no image configured…` naming this key. An unpinned value (`node:24-bookworm`) is a config warning and is ignored — it never blocks boot. |
| `execution.docker.cpu` | number > 0 | `2` | Docker `--cpus` quota. Fractional values are allowed. |
| `execution.docker.diskMb` | integer ≥ 1 | unset (no quota) | Best-effort `--storage-opt size=<N>m`. Enforced only on btrfs, zfs, devicemapper, or overlay2 over xfs with `pquota`; elsewhere Ethos warns once and runs without the quota. |

Recommended image (verified 2026-09-25): `node:24-bookworm` — official Debian 12 image with `bash`, `node` 24, `python3` 3.11, `git` and `curl`. That covers the shell `terminal` uses (`bash -lc`) and both `run_code` runtimes with their tool shims (`python3`, `node`). A smaller image works when you need less: `node:24-bookworm-slim` has no `python3` or `git`, so `run_code` with `runtime: python` fails in it.

Pin the digest you pulled. Containers start with `--pull=never`, so the image must already be on the machine, under the same repository name as the ref:

```bash
docker pull node:24-bookworm
docker inspect --format '{{index .RepoDigests 0}}' node:24-bookworm
```

```text
node@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
```

```yaml
execution.docker.image: node@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
execution.docker.cpu: 2
```

Notes:

- `docker buildx imagetools inspect node:24-bookworm` prints the same index digest without pulling. It does not put the image on the machine — run `docker pull` before the first tool call.
- If you pulled through a mirror (`docker pull mirror.gcr.io/library/node:24-bookworm`), use the `RepoDigests` value it reports (`mirror.gcr.io/library/node@sha256:…`). A `node@sha256:…` ref does not resolve locally under `--pull=never` when only the mirror name exists.
- The container runs as your host uid with all capabilities dropped, no network unless the personality's `safety.network` allows it, and only the personality's `fs_reach` paths mounted. The image needs no user account for that uid.
- Check the result: `ethos doctor` lists every docker-posture personality and flags a missing image; `ethos personality show <id>` prints the image (or `NOT CONFIGURED`) under `## Execution`.
- Source: `dockerImageRefError` in [packages/config/src/index.ts](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts); `MissingDockerImageError` in [extensions/execution-docker/src/index.ts](https://github.com/ethosagent/ethos/blob/main/extensions/execution-docker/src/index.ts).

## verbose {#verbose}

Type: boolean · Default: `false`

Print a per-turn timing summary (LLM time, TTFT, tool wall-clock, tokens, cost) after every chat response.

```yaml
verbose: true
```

Notes:

- Toggle within a session with [`/verbose`](../slash-commands.md#slash-verbose) — that override is session-local and never written here.

## skin {#skin}

Type: string · Default: engine default

Named [skin](../../../getting-started/glossary.md#skin) override. Built-in values: `default`, `mono`, `paper`. Applies across the TUI and the web `ConfigProvider`. This is the only place a skin is set — a personality is an identity, not a theme, so personalities carry no `skin` field.

```yaml
skin: mono
```

## retention.* {#retention}

Per-category TTLs for the observability store and the observe-mode channel transcript. Unset fields fall back to the runtime defaults shown below.

**Duration grammar:** `forever`, or a whole number followed by `d` (days), `w` (weeks), `m` (months, 30 days) or `y` (years, 365 days) — `30d`, `12w`, `6m`, `2y`. **Hours and minutes are not in the grammar**; `12h` is not a retention value. A value outside the grammar is dropped at load with a warning naming the key, and the category prunes on its default window instead. `ethos doctor` prints that warning, as do `ethos serve`, `ethos gateway` and `ethos boot` at startup.

| Field | Default | Description |
|---|---|---|
| `retention.messages` | `365d` | Conversation message history. The same window also removes a session row, with its compaction and decision rows, once the row has not been updated inside the window and holds no message inside it. `ethos gateway start` and `ethos boot` run that session prune at startup and then hourly (`pruneExpiredSessions` in [session-retention.ts](https://github.com/ethosagent/ethos/blob/main/apps/ethos/src/lib/session-retention.ts)); `forever` turns it off. |
| `retention.traces` | `90d` | Turn traces. |
| `retention.spans` | `90d` | Tool / LLM spans inside traces. |
| `retention.blobs` | `7d` | Large response payloads stored out-of-band. |
| `retention.archive` | `730d` | Archive partitions. |
| `retention.channelTranscript` | `30d` | Third-party group-chat text recorded verbatim by an [observe-mode](telegram-slack-teams.md#telegram-bots) channel, in `~/.ethos/channel-transcript.db`. Pruned against when Ethos saw the message, not when the platform says it was sent, so a backdated message cannot outlive the window. Short by design: the corpus grows with the room's traffic rather than with your use of the agent, and only the last digest window is ever read. |
| `retention.events.error` | `90d` | Error events from `errors.jsonl`. |
| `retention.events.audit` | `365d` | Audit events (key rotation, personality writes, approvals). |
| `retention.events.channel` | `365d` | Channel-adapter events (pairing, dedup). |
| `retention.events.install` | `forever` | Install / migration events. Never deleted by default. |

```yaml
retention.messages: 365d
retention.traces: 90d
retention.channelTranscript: 7d
retention.events.error: 90d
retention.events.install: forever
```

Notes:

- **A per-personality window for `retention.channelTranscript` prunes nothing, and is refused.** Observe-mode transcripts live in one `~/.ethos/channel-transcript.db` with no personality column, and the nightly job reads the global `retention.channelTranscript` only. Both setters refuse the combination and name the reason: `ethos retention set channelTranscript <duration> --personality <id>`, and the web Settings page — where the Personality column offers only `Global` for this subkey, and a save carrying one is rejected before it is written. Set the global key instead. A value an earlier build stored is still cleared the usual way: `ethos retention reset channelTranscript --personality <id>`, or removing the row in Settings and saving.
- **Pruning runs once a night, at 03:00 local time, and a missed run is not made up.** All retention categories are aged out by a single system cron job (`observability-prune`) on a fixed `0 3 * * *` schedule that no config key changes. That job is created with `missedRunPolicy: skip`, so a machine that was asleep or powered off at 03:00 rolls the run forward rather than executing it late — a laptop that is never awake at 03:00 never prunes anything, indefinitely and silently. There is no prune at startup, apart from the session-row prune described under `retention.messages`. Run Ethos on a machine that is up at 03:00 if a window here matters to you.
- **`ethos data prune` does not cover `retention.channelTranscript`.** It prunes the observability store only. The channel transcript is a separate database with no manual prune command; the nightly job is the only thing that ages it out.
- **Per-message audit events outlive the transcript text they describe.** Every message an observe-mode channel records also emits a `channel.observed` audit event carrying the platform, chat id and sender id — no message text, but a durable record of who spoke where and when. That event is in the `audit` category (`365d`) and in a different database, so it survives the transcript's `30d` window by roughly 12×. Lowering `retention.channelTranscript` does not lower it; set `retention.events.audit` too if that matters to you.

## personalities.\<id\>.retention.* {#personalities-retention}

Per-personality retention overrides. Same sub-fields as the top-level `retention.*` block; values apply only to data tagged with the matching personality id.

```yaml
personalities.engineer-paired.retention.messages: 730d
personalities.engineer-paired.retention.traces: 180d
```

Notes:

- Only the `retention` sub-block is parsed under `personalities.<id>.*`. Other top-level keys cannot be overridden per personality from this file — set them in the personality's own `config.yaml`.
- **No category honours a per-personality window on the nightly prune today.** `personalities.<id>.retention.*` is read by `ethos retention show --personality <id>` and by `ethos data prune --personality <id>` (which prunes on demand, against the merged window). The scheduled `observability-prune` job reads the global `retention.*` block only, so a value set here shortens nothing on its own.

## channelDigest.* {#channel-digest}

Type: object · Default: off

The scheduled summary of what [`observe`-mode](telegram-slack-teams.md#telegram-bots) channels recorded. One digest per lane — a lane is a chat *and* a thread — delivered to the owner's DM from the bot that watched it, plus the in-app notifications feed. Nothing is ever posted back into the observed room.

Off unless `enabled: true`. Seeded only by `ethos gateway start` and `ethos boot`; `ethos serve` runs no channel adapters and creates no job.

| Field | Type | Default | Description |
|---|---|---|---|
| `channelDigest.enabled` | boolean | `false` | Create the `channel-digest` cron job. Any value other than the literal `true` reads as `false`. |
| `channelDigest.cron` | cron expression | `0 8 * * *` | When the digest runs, in the host's local time. |
| `channelDigest.deliverTo` | `owner` \| `inApp` | `owner` | `owner` — the owner's DM *and* the in-app feed. `inApp` — the feed only. The feed always gets a copy, so this names the delivery that can be switched off, not a choice between two. Any other value is a parse error. |
| `channelDigest.maxMessagesPerLane` | integer ≥ 1 | `500` | Messages read per lane per run. The oldest undigested ones are taken first; the rest are counted, reported in the digest's footnote, and read by the next run. A whole-string check — `500 messages` is a parse error, not `500`. |
| `channelDigest.maxLanesPerRun` | integer ≥ 1 | `25` | Lanes one run may send to the model. A real ceiling: it binds before any money is spent. Lanes past it are deferred with their cursors untouched, so nothing is lost — one watched Slack channel with 80 threads in a day is otherwise 80 model calls and 80 direct messages from one nightly run. |
| `channelDigest.costWarnUsdPerLane` | number > 0 | `0.5` | Spend **notice** threshold for one lane, in USD. Not a ceiling — a digest is a single model call that reports its cost after billing, so a lane that costs more is still delivered, with a footnote saying what it cost. |

```yaml
channelDigest.enabled: true
channelDigest.cron: 0 8 * * *
channelDigest.deliverTo: owner
channelDigest.maxLanesPerRun: 25
```

Notes:

- **Owner delivery needs `channel_filter.<platform>.ownerUserId`.** A platform with no owner id has nowhere to send its digests: each lane is counted undelivered, its cursor is left alone, and a `channel.digest_undelivered` event says why. The in-app copy still goes out.
- **An owner id that names a watched chat is refused.** `ownerUserId` is a bare platform id, and on Telegram or WhatsApp nothing in it distinguishes a DM from a group — so a value copied from an observed chat would post the summary into a room it is about, in front of the people it is about. Any observed chat on that platform is refused, not just the lane being summarised.
- **`deliverTo: inApp` under `ethos gateway` refuses to start.** Only `ethos boot` serves the web UI that the feed reaches, so under `ethos gateway` every digest would be generated and discarded. The error names both fixes.
- **Delivery is what consumes a lane.** A cursor advances only on a confirmed delivery, so a failed send, a missing owner, a refused owner or a crash mid-run all leave the messages to be digested again. Duplicates are possible by design; a lost digest is not.
- **The digest turn gets no tools, no memory, no session and no plugin hooks.** It is a bare model call, not an agent turn — the one place in the system where unfiltered third-party text meets a model. See [Security controls](../../../security/controls.md).
- **Two runs on one machine cannot overlap.** A run holds `~/.ethos/channel-digest.lock` for its whole duration; a second run on the same host skips rather than waiting, names the process holding the lock in its run output, and records a `channel.digest_skipped` event. A restart overlapping its predecessor is covered. An `ethos gateway start` beside an `ethos boot` never gets that far: both take the gateway lock, and the second exits `3`. **The guarantee stops at the host boundary.** The lock identifies its holder by process id and boot id, both facts about the local machine, so a lock written by another host can read as abandoned and be taken over rather than respected — two machines sharing one `~/.ethos` over a network mount do not exclude each other. Both then send the same rooms to the model, deliver the same digest to the same owner, and the later write erases the cursors the earlier one advanced. Run one gateway per `~/.ethos`.

## notifications.* {#notifications}

Type: object · Default: off

Quiet hours for notices the gateway sends without being asked: a finished background job's wake notice and an owner notice such as a post-call summary. Inside the window the notice is held in `~/.ethos/notify-queue.db` and delivered within a minute of the window ending, through the same delivery ledger as every other tracked send. A reply to a message the user just sent is never held, and neither is a notice about that message (a dead-lettered or interrupted turn).

| Field | Type | Default | Description |
|---|---|---|---|
| `notifications.quietHours` | `HH:MM-HH:MM` | unset | The daily window, in `notifications.timezone`. A start later than the end crosses midnight. A malformed value is a warning and turns quiet hours off. |
| `notifications.timezone` | IANA zone | the host's zone | The zone the window is read in, e.g. `Europe/London`. An unknown zone is a warning and falls back to the host's. |
| `notifications.bots.<botKey>.quietHours` | `HH:MM-HH:MM` \| `off` | unset | A per-bot window, keyed by the bot's `botKey` (its `id:` or derived key). `off` turns quiet hours off for that bot only. |

```yaml
notifications.quietHours: 22:00-07:00
notifications.timezone: Europe/London
notifications.bots.work-slack.quietHours: off
```

In any chat, `/mute <30m|2h|1d>` holds that chat's notices for the given time, outside quiet hours too, and `/mute off` ends it early. A mute lasts at most 30 days, is stored beside the chat's session in `~/.ethos/gateway/lanes/<botKey>.json`, and survives a restart. In a group chat only the owner set in `channel_filter.<platform>.ownerUserId` can mute or unmute; a group on a platform with no owner refuses it (`Gateway.handleMuteCommand`). Plain `/mute`, which shows the current mute, stays open to everyone.

Notes:

- **Held, never dropped.** The hold and the release are `Gateway.noticeHoldReason` and `Gateway.releaseHeldNotices` in [`extensions/gateway/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/gateway/src/index.ts). The release runs at the top of every delivery sweep: at boot and every 60 seconds. If no held-notice store is wired, which only happens outside `ethos gateway start` and `ethos boot`, the notice is sent at once rather than kept only in memory.
- **What is not held yet.** Cron job output, watcher wakes, the channel digest and `deliver: 'parent'` background reviews are delivered on their own schedules and ignore quiet hours.
- **Daylight saving.** The window is read from the zone's wall clock each time it is checked, so it moves with a DST change.

## See also {#see-also}

- [config.yaml reference](../config-yaml.md): the index of every section and its page.
