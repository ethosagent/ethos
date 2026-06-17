import type { LearningLogEntry, LivingSoul } from '@ethosagent/types';

// Living Soul — pure string-manipulation over a SOUL.md body.
//
// Grammar (strict; ambiguity always resolves toward Core/immutable):
//   - Recognized headers: a line that, trimmed, exactly equals `# Core`,
//     `# Expression`, or `# Learning Log`.
//   - A soul is "sectioned" ONLY when BOTH `# Core` and `# Expression` are
//     present. Otherwise the entire body collapses to `core` (flat soul).
//   - Section bodies are captured verbatim — everything after the header
//     line's trailing newline, up to (but not including) the next recognized
//     header line. This guarantees byte-identical round-tripping of Core.

const CORE_HEADER = '# Core';
const EXPRESSION_HEADER = '# Expression';
const LEARNING_LOG_HEADER = '# Learning Log';

type SectionKind = 'core' | 'expression' | 'learningLog';

function recognizeHeader(line: string): SectionKind | null {
  const trimmed = line.trim();
  if (trimmed === CORE_HEADER) return 'core';
  if (trimmed === EXPRESSION_HEADER) return 'expression';
  if (trimmed === LEARNING_LOG_HEADER) return 'learningLog';
  return null;
}

interface HeaderHit {
  kind: SectionKind;
  /** Offset of the first character of this header's body (after its `\n`). */
  bodyStart: number;
  /** Offset of the first character of this header line. */
  headerStart: number;
}

export function parseLivingSoul(body: string): LivingSoul {
  // Locate every recognized header line with its character offsets, so we can
  // slice section bodies verbatim (trailing newlines included).
  const headers: HeaderHit[] = [];
  let offset = 0;
  for (const line of body.split('\n')) {
    const kind = recognizeHeader(line);
    if (kind !== null) {
      // Body starts after this header line's own trailing newline.
      headers.push({ kind, headerStart: offset, bodyStart: offset + line.length + 1 });
    }
    offset += line.length + 1; // +1 for the '\n' the split consumed
  }

  const hasCore = headers.some((h) => h.kind === 'core');
  const hasExpression = headers.some((h) => h.kind === 'expression');

  // Flat soul: collapse the whole body to `core`.
  if (!hasCore || !hasExpression) {
    return { core: body, expression: '', learningLog: [] };
  }

  // A section body runs from its bodyStart up to the next header's headerStart
  // (or end of body). Later headers of the same kind overwrite earlier ones —
  // the canonical layout has each header at most once.
  const sections: Record<SectionKind, string> = { core: '', expression: '', learningLog: '' };
  for (let i = 0; i < headers.length; i++) {
    const hit = headers[i];
    if (hit === undefined) continue;
    const next = headers[i + 1];
    const end = next ? next.headerStart : body.length;
    sections[hit.kind] = body.slice(hit.bodyStart, end);
  }

  return {
    core: sections.core,
    expression: sections.expression,
    learningLog: parseLearningLog(sections.learningLog.split('\n')),
  };
}

export function serializeLivingSoul(soul: LivingSoul): string {
  // Flat soul: emit `core` verbatim (no synthetic headers).
  if (soul.expression === '' && soul.learningLog.length === 0) {
    return soul.core;
  }
  let out = `${CORE_HEADER}\n${soul.core}${EXPRESSION_HEADER}\n${soul.expression}`;
  if (soul.learningLog.length > 0) {
    out += `${LEARNING_LOG_HEADER}\n${soul.learningLog.map(serializeLogEntry).join('\n')}\n`;
  }
  return out;
}

export function applyExpressionUpdate(
  body: string,
  newExpression: string,
  entry: LearningLogEntry,
): string {
  const soul = parseLivingSoul(body);
  const next: LivingSoul = {
    core: soul.core,
    expression: newExpression,
    learningLog: [...soul.learningLog, entry],
  };
  return serializeLivingSoul(next);
}

export function revertExpression(
  body: string,
  expressionToRestore: string,
  entry: LearningLogEntry,
): string {
  const soul = parseLivingSoul(body);
  const next: LivingSoul = {
    core: soul.core,
    expression: expressionToRestore,
    learningLog: [...soul.learningLog, entry],
  };
  return serializeLivingSoul(next);
}

// Learning Log line format (stable, round-trippable), one entry per line:
//   - {at} · {revisionId} · "{summary}" · evidence: {evidenceRef} · prev: {prevExpressionRef}
const SEP = ' · ';

function serializeLogEntry(entry: LearningLogEntry): string {
  return `- ${entry.at}${SEP}${entry.revisionId}${SEP}"${entry.summary}"${SEP}evidence: ${entry.evidenceRef}${SEP}prev: ${entry.prevExpressionRef}`;
}

function parseLearningLog(lines: string[]): LearningLogEntry[] {
  const entries: LearningLogEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const fields = line.slice(2).split(SEP);
    if (fields.length !== 5) continue;
    const [at, revisionId, quotedSummary, evidenceField, prevField] = fields;
    if (
      at === undefined ||
      revisionId === undefined ||
      quotedSummary === undefined ||
      evidenceField === undefined ||
      prevField === undefined
    ) {
      continue;
    }
    const summary = stripQuotes(quotedSummary);
    const evidenceRef = stripPrefix(evidenceField, 'evidence: ');
    const prevExpressionRef = stripPrefix(prevField, 'prev: ');
    entries.push({ revisionId, at, summary, evidenceRef, prevExpressionRef });
  }
  return entries;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
