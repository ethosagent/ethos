# @ethosagent/platform-meeting

Transcribe-only Google Meet presence, behind an isolated `MeetingClient`
boundary. Part of `plan/phases/gap-voice-realtime.md` **Phase D** (deliberately
last; every known open implementation is browser automation + caption scraping
and its own community calls it flaky — plan §3(d)).

**Transcribe-only.** There is no speak-into-meeting path. `meet_say` is
deferred pending Phase B/C learnings and a Recall.ai-class build-vs-buy
evaluation (plan §3(d)/§4). Zoom and hosted meeting-bot APIs are deferred too.

## What it does

- **`MeetingClient`** (`meeting-client.ts`) — the transport boundary for one
  meeting: `join({ url, displayName })`, `onCaption(handler)` (a stream of raw
  scraped caption fragments), `leave()`. Nothing browser-specific lives here.
- **`CaptionParser`** (`caption-parser.ts`) — PURE logic that merges Meet's
  rolling in-place caption updates (last-wins per line), attributes speakers,
  and dedups verbatim re-emits into clean `TranscriptEntry[]`. Fixture-tested
  (`__tests__/fixtures/meet-captions.ts`) — the §4 Phase D check target.
- **Transcript artifact** (`transcript.ts`) — `buildTranscriptArtifact` turns
  entries into a markdown note + short summary; `createMemoryTranscriptWriter`
  writes it through `MemoryProvider.sync()` — the same scope-bound store
  MEMORY.md/USER.md use, giving the "searchable knowledge base" outcome. No raw
  `node:fs`; the writer is injected.

The `meet_join` tool that drives this pipeline ships in
`@ethosagent/tools-meeting`.

## Why Playwright is NOT installed here

The production `MeetingClient` drives a real headless Chromium (Playwright,
reusing the existing `tools-browser` surface) against a live Meet. A headful
browser join cannot be verified in this repo without a running meeting, so
committing Playwright + a browser would put an unverifiable, flaky dependency in
the monorepo. Everything here binds ONLY to the `MeetingClient` interface, so it
typechecks and unit-tests against a `FakeMeetingClient` + a recorded caption
fixture. Wiring the real binding is the manual step below.

## Manual verification checklist (the live Playwright binding)

Do this on a workstation, NOT in CI:

1. `pnpm add -D playwright && npx playwright install chromium` (app layer, not
   committed to this package).
2. Implement `MeetingClient` wrapping Playwright:
   - `join({ url, displayName })` — launch Chromium, open the Meet URL, dismiss
     the device-permission prompts, set the display name, click **Join now**,
     then turn on **Captions** (the "CC" control).
   - `onCaption(handler)` — locate the live-caption container
     (`div[role="region"]` region labelled *Captions* / the `.ELhLl` /
     `[jsname]` caption nodes — verify against the current DOM) and observe it
     with a `MutationObserver`; on each mutation emit
     `{ speaker, text, blockId }` where `blockId` is the stable caption-line
     node id while it stays active. Meet re-emits the FULL current text per
     update — that is exactly what `CaptionParser` expects.
   - `leave()` — click **Leave call** and close the browser.
3. Inject the real client into `createMeetingTools({ meetingClient, memory })`
   and gate the `meet_join` tool into a personality's `toolset` (`meeting`).
4. Join a real Meet, let people talk, end the turn (abort) to stop capture, and
   verify the transcript + summary artifact was written to memory and reads
   correctly.

## Flakiness caveats (document these honestly to users)

- **Captions must be host-enabled.** If the meeting host has not enabled live
  captions, there is nothing to scrape — the transcript comes back empty (the
  artifact says so honestly).
- **One meeting per node.** A browser session owns one meeting; concurrent joins
  need separate browser contexts/nodes (same limitation Hermes documents).
- **Meet DOM fragility.** Caption scraping depends on Google's private,
  unversioned DOM. Class names and structure change without notice; the scraper
  selectors WILL need periodic maintenance. This is inherent to caption-scraping
  meeting bots and is why the feature is labeled experimental.
- **Bot-participant visibility.** The bot joins as a visible participant and may
  require host admit; it is not a silent recorder. Disclose its presence to
  meeting participants.
