// Transcript artifact — assemble parsed caption entries into a markdown
// transcript + a short summary, and write it through an INJECTED writer (no raw
// node:fs). The production writer is memory-backed (`createMemoryTranscriptWriter`),
// so the transcript lands in the same scope-bound store MEMORY.md/USER.md use —
// the "searchable knowledge base" outcome users cite (plan §3(d)).

import type { MemoryContext, MemoryProvider } from '@ethosagent/types';
import type { TranscriptEntry } from './caption-parser';

/** A finished meeting transcript ready to be written to a store. */
export interface TranscriptArtifact {
  /** Memory key the transcript is stored under (a `.md` filename). */
  key: string;
  /** Human title of the meeting note. */
  title: string;
  /** Full markdown document: title, meta, summary, and the transcript body. */
  markdown: string;
  /** Standalone short summary (participants + line count), for channel posts. */
  summary: string;
}

/**
 * The sink a transcript is written through. Kept as a one-method seam so the
 * artifact never touches `node:fs` directly and tests can assert on a fake.
 */
export interface TranscriptWriter {
  write(artifact: TranscriptArtifact): Promise<void>;
}

export interface BuildTranscriptInput {
  /** The Meet URL the transcript came from (recorded in the note header). */
  meetingUrl: string;
  /** Parsed, finalized transcript entries. */
  entries: readonly TranscriptEntry[];
  /** Injectable clock for a deterministic key/header. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Build a transcript artifact from parsed entries. Deterministic given `now`;
 * the summary is a plain participant/line-count roll-up (an LLM summarizer can
 * be layered on later without changing the write path).
 */
export function buildTranscriptArtifact(input: BuildTranscriptInput): TranscriptArtifact {
  const now = input.now ?? Date.now();
  const iso = new Date(now).toISOString();
  const title = `Meeting transcript — ${iso}`;
  const key = `meeting-${now}.md`;
  const summary = summarize(input.entries);

  const body =
    input.entries.length === 0
      ? '_No captions were captured. Captions must be enabled by the meeting host._'
      : input.entries.map((e) => `- **${e.speaker || 'Unknown'}:** ${e.text}`).join('\n');

  const markdown = [
    `# ${title}`,
    '',
    `- Meeting: ${input.meetingUrl}`,
    `- Captured: ${iso}`,
    '',
    '## Summary',
    '',
    summary,
    '',
    '## Transcript',
    '',
    body,
    '',
  ].join('\n');

  return { key, title, markdown, summary };
}

function summarize(entries: readonly TranscriptEntry[]): string {
  if (entries.length === 0) return 'No captions were captured.';
  const participants = [
    ...new Set(entries.map((e) => e.speaker.trim()).filter((s) => s.length > 0)),
  ];
  const who = participants.length > 0 ? participants.join(', ') : 'unknown participants';
  return `${entries.length} caption line(s) from ${participants.length} speaker(s): ${who}.`;
}

/**
 * A memory-backed {@link TranscriptWriter}: writes the transcript markdown under
 * its key via `MemoryProvider.sync()` (`action: 'replace'`) — the same
 * scope-bound write path tools-memory uses. No `node:fs`; the store handles
 * persistence and full-text indexing.
 */
export function createMemoryTranscriptWriter(
  memory: MemoryProvider,
  ctx: MemoryContext,
): TranscriptWriter {
  return {
    async write(artifact: TranscriptArtifact): Promise<void> {
      await memory.sync(
        [{ action: 'replace', key: artifact.key, content: artifact.markdown }],
        ctx,
      );
    },
  };
}
