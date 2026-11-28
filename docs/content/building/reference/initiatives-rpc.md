---
title: Initiatives RPC reference
description: The initiatives.* and constitution.initiatives* oRPC procedures behind the Initiatives page and Settings: request and response bodies, errors and auth.
kind: reference
audience: developer
slug: initiatives-rpc
updated: 2026-11-28
---

Ten `@experimental`, owner-only procedures let the web app read the initiative ledger, record decisions and edit the engine's settings.

## Source {#source}

| Part | File |
|---|---|
| Contract | [`packages/web-contracts/src/routes/initiatives.ts`](https://github.com/ethosagent/ethos/blob/main/packages/web-contracts/src/routes/initiatives.ts) |
| Zod schemas | [`packages/web-contracts/src/schema/initiatives.ts`](https://github.com/ethosagent/ethos/blob/main/packages/web-contracts/src/schema/initiatives.ts) |
| Handlers | [`apps/web-api/src/rpc/initiatives.ts`](https://github.com/ethosagent/ethos/blob/main/apps/web-api/src/rpc/initiatives.ts) |
| Logic | [`apps/web-api/src/services/initiatives.service.ts`](https://github.com/ethosagent/ethos/blob/main/apps/web-api/src/services/initiatives.service.ts) (`InitiativesService`); tests in `initiatives-rpc.test.ts` |

## Transport and auth {#transport}

Every procedure is `POST /rpc/<namespace>/<procedure>` with body `{ "json": <input> }`. The response is `{ "json": <output> }`. The examples below show the inner value.

| Rule | Detail |
|---|---|
| Cookie only | Neither `initiatives` nor `constitution` is in `SCOPE_MAP`, so a bearer API key gets `403 FORBIDDEN` ("Namespace ... is experimental and not accessible via API key"). The test also asserts a rejected key writes nothing. |
| Origin check | The CSRF middleware runs on every cookie POST, reads included. A missing `Origin` or `Referer` gives `401 UNAUTHORIZED`, as does a cross-origin one. |
| Strict bodies | Input schemas are `.strict()`. An unknown key such as `allowWrites`, or a missing required key, returns `400`. Decisions are recorded as `owner:web`. |

Errors reach the wire as `{ "json": { "defined": false, "code": "NOT_FOUND", "status": 404, "message": "...", "data": { "action": "..." } } }`. `EthosError` codes map through `statusFor` (`apps/web-api/src/middleware/error-envelope.ts`).

| Status | Code | Raised by |
|---|---|---|
| 400 | `BAD_REQUEST` | Schema validation, and `decide` when the verdict does not fit the gate or the initiative has no valid file |
| 400 | `INVALID_INPUT` | `settingsSave`, `constitutionSave` (a validator or ceiling refusal) |
| 400 | `CONFIG_INVALID` | `get` when the initiative file no longer parses |
| 401, 403 | `UNAUTHORIZED`, `FORBIDDEN` | Origin check, bearer key (above) |
| 404 | `NOT_FOUND` | `decide` on an unknown id, or with no ledger |
| 404 | `FILE_NOT_FOUND` | `get` on an unknown initiative, `settingsSave` for an unknown personality |
| 409 | `CONFLICT` | `decide` on the wrong state, such as `EXP-0003 is proposed, not briefed` |

`settings` with an id that fails `assertSafeId` throws a plain `IdValidationError`, not an `EthosError`, so oRPC answers `500`. No test pins this.

## initiatives.list {#list}

The Initiatives page table. With no ledger it returns an empty list and creates none. Filters are optional.

```json
{ "personalityId": "pm", "state": "active" }
```

```json
{ "items": [ { "id": "grow", "personalityId": "pm", "origin": "human", "state": "active",
  "title": "Self-serve activation", "version": 3, "spendTodayUsd": 0.42, "openExplorations": 1 } ] }
```

`title` is `null` and `invalidReason` is set when the file is missing or invalid.

## initiatives.get {#get}

One initiative: parsed file, per-line guidance mapping, raw YAML, versions and explorations.

```json
{ "id": "grow" }
```

```json
{ "personalityId": "pm", "initiative": { "id": "grow", "version": 3, "state": "active", "title": "Self-serve activation" },
  "guidance": [ { "text": "check LinkedIn", "status": "unreachable", "mapsTo": [] } ],
  "yaml": "id: grow\nversion: 3\n", "versions": [ { "version": 3 } ],
  "explorations": [ { "id": "EXP-0001", "question": "Which channel converts?", "state": "briefed",
    "budgetUsd": 2, "spentUsd": 1.1, "deadline": "2026-12-10T00:00:00.000Z",
    "briefMd": "## Options\n- A\n- B", "recommendedOption": "B" } ] }
```

`initiative` carries every key of the file (trimmed above). `versions` lists the current version only: the store has no read method for older ones.

## initiatives.activity {#activity}

Recent windows of one initiative, newest first. `limit` is 1 to 200 (default 50). An unknown id returns an empty list.

```json
{ "initiativeId": "grow", "limit": 20 }
```

```json
{ "windows": [ { "id": "W-4", "explorationId": "EXP-0001", "kind": "window",
  "started": "2026-11-28T09:00:00.000Z", "ended": "2026-11-28T09:12:00.000Z",
  "tools": ["web_search"], "reads": ["https://example.com"], "findings": 3, "costUsd": 0.31, "endReason": "done" } ] }
```

`kind` is `survey`, `scan`, `window` or `brief`.

## initiatives.exploringNow {#exploring-now}

The newest unfinished window, for the "exploring now" strip.

```json
{ "personalityId": "pm" }
```

```json
{ "current": { "windowId": "W-5", "initiativeId": "grow", "initiativeTitle": "Self-serve activation",
  "explorationId": "EXP-0001", "question": "Which channel converts?",
  "started": "2026-11-28T09:00:00.000Z", "costSoFarUsd": 0.12, "readOnly": true } }
```

`current` is `null` when nothing runs.

## initiatives.metrics {#metrics}

Gate and self-start outcomes since `now - sinceDays` (1 to 365, default 30). Spend and guidance are CLI-only.

```json
{ "personalityId": "pm", "sinceDays": 30 }
```

```json
{ "since": "2026-10-29T09:00:00.000Z", "gate1": { "asked": 3, "approved": 2, "rate": 0.67 },
  "gate2": { "briefs": 2, "adopted": 1, "rate": 0.5 }, "selfStart": { "started": 1, "kept": 1, "stopped": 0 } }
```

## initiatives.decide {#decide}

Gate 1, Gate 2 and agent-started decisions. Writes go through `decideInitiative`, the function the CLI and channel taps share. The body is a union on `gate`.

| `gate` | `verdict` | `target` | Extra |
|---|---|---|---|
| `gate1_explore` | `approve`, `reject`, `snooze` | exploration id, state `proposed` | `reason?` |
| `gate2_adopt` | `adopt`, `dig_deeper`, `park` | exploration id, state `briefed` | `reason?`, `option?` |
| `self_start` | `keep`, `make_mine`, `stop` | initiative id, state `self_started` | `reason?` |

```json
{ "gate": "gate2_adopt", "verdict": "adopt", "target": "EXP-0002", "option": "B" }
```

```json
{ "ok": true, "exploration": { "id": "EXP-0002", "state": "adopted" } }
```

`self_start` answers with `initiative: { id, state }`. `make_mine` writes nothing and returns `chatLink` (`/p/pm/chat?draft=make%20idea-x%20mine`), because you confirm the rewrite in chat. Errors: 404 unknown id, 409 wrong state, 400 other refusals.

## initiatives.settings {#settings}

A personality's `settings.yaml`, the operator ceilings and each standing guidance line's mapping.

```json
{ "personalityId": "pm" }
```

```json
{ "settings": { "enabled": true, "selfStart": false, "dailyBudgetUsd": 3,
    "delivery": { "ownerChannel": "telegram:12345", "digestTime": "08:30" }, "standingGuidance": [] },
  "status": "loaded", "ceilings": { "maxUsdPerDay": 10 }, "guidance": [] }
```

`status` is `missing` (defaults shown), `loaded` or `invalid` (the engine is paused for this personality, with `reason`).

## initiatives.settingsSave {#settings-save}

Replaces the whole `settings.yaml`, so send every key (optional `defaultAutonomy` and `delivery` may be absent). `dailyBudgetUsd` is lowered to the smaller operator ceiling.

```json
{ "personalityId": "pm", "settings": { "enabled": true, "selfStart": false, "dailyBudgetUsd": 5, "standingGuidance": [] } }
```

```json
{ "ok": true, "saved": { "enabled": true, "selfStart": false, "dailyBudgetUsd": 4, "standingGuidance": [] },
  "clamps": ["dailyBudgetUsd 5 → 4 (operator ceiling)"] }
```

An unknown personality returns `404 FILE_NOT_FOUND` and creates no directory. Writes are serialised in one process; a CLI or hand edit in another process between the read and the write is not detected.

## constitution.initiatives {#constitution-read}

The `initiatives` block of `constitution.yaml`. No input.
```json
{ "initiatives": { "enabled": true, "maxUsdPerDay": 10, "selfStartPoolUsdPerDay": 0.5, "maxSelfStarted": 2 } }
```

## constitution.initiativesSave {#constitution-save}

Replaces the block and keeps every other block byte for byte. All keys but `readableRoots` are required, so a partial body cannot drop a ceiling. `null` means no ceiling.
```json
{ "initiatives": { "enabled": true, "maxUsdPerDay": 10, "maxUsdPerDayPerPersonality": null,
  "selfStartPoolUsdPerDay": 0.5, "maxSelfStarted": 2, "readableRoots": ["~/code"] } }
```
```json
{ "ok": true, "appliesOn": "next window for limits; restart for the rest of the constitution" }
```

A `readableRoots` entry that is `~/.ssh`, under it, or one of its ancestors returns `400 INVALID_INPUT` and writes nothing.

## See also {#see-also}

- [Initiative config reference](../../using/reference/initiatives-config.md) — what each settings and constitution key means.
- [CLI: ethos initiatives](../../using/reference/cli/initiatives.md) — the same decisions from a shell.
- [Why is the initiative engine read-only, and what does it cost?](../../using/explanation/initiatives.md) — the engine behind these calls.
