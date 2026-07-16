// ---------------------------------------------------------------------------
// Summary helpers — verbatim copy of the summary-mode machinery from
// `extensions/tools-delegation/src/index.ts`.
//
// These are trivial, pure, dependency-free functions. They are DUPLICATED here
// rather than imported from tools-delegation on purpose: tools-delegation
// depends on @ethosagent/core + @ethosagent/agent-mesh, and background jobs are
// a lower-level engine that must not pull that graph in. Importing the helpers
// would create a cross-extension dependency cycle (job-runner -> tools-delegation
// -> core, while core has no business knowing about job-runner). Duplicating ~30
// lines of pure string logic is the cheaper tradeoff. If the summary contract
// changes, update BOTH copies.
// ---------------------------------------------------------------------------

// Summary-mode result cap. Much lower than the full-mode cap so the parent
// re-ingests only a bounded digest of the child's work.
export const SUMMARY_RESULT_CAP = 2_000;

// Instruction appended to the child prompt in summary mode. The child is asked
// to end its final message with a `## Summary` section; the parent extracts and
// returns only that section.
export const SUMMARY_INSTRUCTION =
  '\n\n---\n' +
  'When you finish, end your final message with a section:\n\n' +
  '## Summary\n' +
  '<a concise summary of what you did and the key result, under ~1500 chars>\n\n' +
  'The caller will read ONLY this Summary section.';

/**
 * Extracts the content of a `## Summary` section from the child's final text.
 * Heading match is case-tolerant and accepts any markdown heading level. The
 * section runs from the heading to the next heading (or end of text). Returns
 * `undefined` when no summary heading is present.
 */
export function extractSummarySection(text: string): string | undefined {
  const lines = text.split('\n');
  const headingIdx = lines.findIndex((line) => /^#{1,6}\s+summary\s*$/i.test(line.trim()));
  if (headingIdx === -1) return undefined;
  const rest = lines.slice(headingIdx + 1);
  const nextHeadingRel = rest.findIndex((line) => /^#{1,6}\s+/.test(line.trim()));
  const sectionLines = nextHeadingRel === -1 ? rest : rest.slice(0, nextHeadingRel);
  return sectionLines.join('\n').trim();
}

/** Truncates text to `cap` chars, appending a marker while staying within `cap`. */
export function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const marker = '\n[truncated]';
  return text.slice(0, cap - marker.length) + marker;
}
