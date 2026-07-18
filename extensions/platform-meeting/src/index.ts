// @ethosagent/platform-meeting — transcribe-only Google Meet presence, behind
// an isolated `MeetingClient` boundary. Playwright + caption scraping is the
// app-layer/manual production binding (see README.md); this package binds ONLY
// to interfaces so it typechecks and unit-tests against a fake + a recorded
// caption fixture. Part of plan/phases/gap-voice-realtime.md Phase D.

export { CaptionParser, parseCaptions, type TranscriptEntry } from './caption-parser';
export type { MeetingClient, MeetingJoinOptions, RawCaptionFragment } from './meeting-client';
export {
  type BuildTranscriptInput,
  buildTranscriptArtifact,
  createMemoryTranscriptWriter,
  type TranscriptArtifact,
  type TranscriptWriter,
} from './transcript';
