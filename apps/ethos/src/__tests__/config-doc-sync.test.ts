// Config surface doc-sync test.
//
// Every documented config field must exist on the schema; every typed (and
// non-internal) field must be documented. Catches the slow-rot failure mode
// where someone adds `apiKey` to `EthosConfig` but forgets the doc — and the
// reverse, where docs reference a removed field.
//
// "Documented form" — one of:
//   (a) A markdown table row whose first cell names the field (with or without
//       backticks; commas allowed for grouped fields like
//       `emailImapHost`, `emailImapPort`) and whose remaining cells contain a
//       non-trivial description.
//   (b) A YAML/code-block line of the form `<field>: <value>  # <comment>` where
//       the comment contains at least one word — i.e. the YAML example
//       block describes each field inline.
//   (c) An H2 section heading naming the field or a dotted path under it
//       (`## memoryVault.*`, `## evolver.cron_enabled`). Both reference pages
//       document each key as its own section per the config-field reference
//       schema in .agents/skills/docs/SKILL.md, so the heading IS the
//       documented form there.
//
// Bare substring match is intentionally not enough: "the field name appeared
// somewhere in the file" is the bar that gets gamed in two years by future-you
// pasting the type into a code block and calling it documented.
//
// The pages document ON-DISK config keys; where a key's spelling differs from
// the interface field name (`displaySlowTurnNoticeMs` is the
// `display.slow_turn_notice_ms` line), DOC_KEY_ALIASES carries the mapping.
//
// Internal/derived fields (populated by the loader, not user-set) are tagged
// `@internal` in the source and skipped here. Adding a new user-facing field
// without docs fails this test — unless it is deliberately parked in the
// UNDOCUMENTED_* roster below, which is a one-way ratchet: a parked field
// that gains docs fails until its entry is removed.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const ETHOS_CONFIG_SRC = join(REPO_ROOT, 'packages', 'config', 'src', 'index.ts');
const PERSONALITY_SRC = join(REPO_ROOT, 'packages', 'types', 'src', 'personality.ts');
// New IA per DOCS.md: EthosConfig fields live in using/reference/config-yaml.md;
// PersonalityConfig fields live in using/reference/personality-yaml.md.
const CONFIG_REFERENCE_DOC = join(
  REPO_ROOT,
  'docs',
  'content',
  'using',
  'reference',
  'config-yaml.md',
);
const PERSONALITY_REFERENCE_DOC = join(
  REPO_ROOT,
  'docs',
  'content',
  'using',
  'reference',
  'personality-yaml.md',
);

interface FieldEntry {
  name: string;
  internal: boolean;
}

/**
 * Interface field name → the on-disk key the reference page documents, where
 * the two spellings differ. `parseConfigYaml` / `serializeConfigLines` in
 * packages/config/src/index.ts own the real mapping; this table mirrors only
 * the entries the doc-sync check needs.
 */
const DOC_KEY_ALIASES: Record<string, string> = {
  discordPostThinkingPlaceholder: 'discord.post_thinking_placeholder',
  displaySlowTurnNoticeMs: 'display.slow_turn_notice_ms',
  evolverCronEnabled: 'evolver.cron_enabled',
  evolverSchedule: 'evolver.schedule',
};

/**
 * Fields the reference pages do not document yet (plan
 * ux-feedback-and-config-clarity §6.8 re-enabled this suite against pages
 * that never covered the full surface). Each entry is asserted UNdocumented,
 * so documenting one fails the test until its entry is removed here — the
 * roster only shrinks, and a NEW field cannot ship undocumented without a
 * deliberate edit to this list.
 */
const UNDOCUMENTED_ETHOS_FIELDS = new Set([
  'a2a',
  'admin',
  'allowUnattendedDangerousTools',
  'apiVersion',
  'approvalTimeoutMs',
  'auxiliary',
  'aws',
  'awsProfile',
  'backgroundMaxConcurrent',
  'callCapture',
  'channelFilter',
  'channelToolsets',
  'compaction',
  'contextWindow',
  'cron',
  'decisions',
  'displayBellOnComplete',
  'displayBusyInputMode',
  'displayCallAccent',
  'displayCallStyle',
  'displayDebugPanel',
  'displayDebugPanelModel',
  'displayMemoryNotices',
  'displayResumeHint',
  'displayResumeRecapTurns',
  'displayStreamingEdits',
  'displayToolPreviewLength',
  'displayVerbosity',
  'execution',
  'gateway',
  'grounding',
  'idleWatcher',
  'kanban',
  'kanbanPoll',
  'maxRetries',
  'memoryCharLimits',
  'memoryConsolidation',
  'modelCatalog',
  'modelRegistry',
  'models',
  'pauseClockCorrection',
  'pauseLifecycle',
  'personalitiesConfig',
  'pluginsAutoInstall',
  'quick_commands',
  'region',
  'requestTimeoutMs',
  'storage',
  'teamSupervisor',
  'telemetry',
  'toolLoading',
  'toolLoop',
  'toolOrder',
  'toolPayloadLimitChars',
  'toolSettings',
  'webBaseUrl',
  'webhooks',
  'weeklyDigest',
]);

const UNDOCUMENTED_PERSONALITY_FIELDS = new Set([
  'decisions',
  'display',
  'dreaming',
  'evolution_approval_mode',
  'memory',
  'nightly',
]);

function escapeRe(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Form (c): an H2 heading whose key (markdown escapes stripped, `{#anchor}`
 * suffix dropped, comma/slash groups split) equals the field or is a dotted
 * path under it. `## toolset.yaml`, `## skills/` and
 * `## fs_reach.read / fs_reach.write` all count for their fields.
 */
function headingDocuments(field: string, doc: string): boolean {
  for (const line of doc.split('\n')) {
    const m = line.match(/^##\s+(.+?)\s*(\{#[-\w]+\})?\s*$/);
    if (!m) continue;
    const text = (m[1] ?? '').replace(/\\([.<>*_])/g, '$1');
    for (const candidate of text.split(/[,/]/)) {
      const key = candidate.trim();
      if (key === field || key.startsWith(`${field}.`)) return true;
    }
  }
  return false;
}

/**
 * Extract top-level property names from `export interface <name> { ... }`.
 *
 * Brace-depth scan so that nested object types don't leak into the field
 * list. JSDoc/line comments preceding each field are collected so the test
 * can honor `@internal`.
 */
function extractFields(src: string, interfaceName: string): FieldEntry[] {
  const re = new RegExp(`export interface ${interfaceName}\\s*\\{`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`${interfaceName} not found in source`);
  const start = (m.index ?? 0) + m[0].length;

  // Find the matching closing brace at depth 0.
  let depth = 1;
  let end = start;
  while (end < src.length && depth > 0) {
    const ch = src[end];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
    end++;
  }
  const body = src.slice(start, end);

  const lines = body.split('\n');
  const fields: FieldEntry[] = [];
  let pendingComment: string[] = [];
  let inBlockComment = false;
  let blockDepth = 0;

  for (const line of lines) {
    const startDepth = blockDepth;
    for (const ch of line) {
      if (ch === '{') blockDepth++;
      else if (ch === '}') blockDepth--;
    }

    if (inBlockComment) {
      pendingComment.push(line);
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }

    // Only top-level lines are candidates for top-level field declarations.
    if (startDepth !== 0) continue;

    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (trimmed.startsWith('/**') || trimmed.startsWith('/*')) {
      pendingComment = [trimmed];
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
      pendingComment.push(trimmed);
      continue;
    }

    const fieldMatch = trimmed.match(/^([A-Za-z_$][\w]*)\??\s*:/);
    if (fieldMatch) {
      fields.push({
        name: fieldMatch[1] ?? '',
        internal: pendingComment.some((c) => /@internal\b/.test(c)),
      });
      pendingComment = [];
    } else {
      pendingComment = [];
    }
  }

  return fields;
}

/**
 * Returns true if `field` is documented (form (a), (b) or (c)) anywhere in
 * `doc`, under its own name or its DOC_KEY_ALIASES spelling.
 */
function isDocumented(field: string, doc: string): boolean {
  const alias = DOC_KEY_ALIASES[field];
  const names = alias ? [field, alias] : [field];
  return names.some((name) => headingDocuments(name, doc) || bodyDocuments(name, doc));
}

/** Forms (a) and (b) for one name. */
function bodyDocuments(field: string, doc: string): boolean {
  const lines = doc.split('\n');

  // (a) Table row matcher.
  for (const line of lines) {
    if (!line.includes('|')) continue;
    // Trim leading/trailing pipes by slicing off empty boundary cells.
    const cells = line.split('|');
    if (cells.length < 4) continue;
    const inner = cells.slice(1, -1).map((c) => c.trim());
    const firstCell = inner[0] ?? '';
    const restCells = inner.slice(1).join(' ').trim();

    // First cell either is the field, contains `<field>` in a backtick group
    // (e.g. comma-separated grouped fields), or starts with `<field>` followed
    // by punctuation or whitespace (e.g. `<flag>` / `<alias>`).
    const fieldExact = firstCell === field || firstCell === `\`${field}\``;
    const fieldGroup = new RegExp(`(^|[\\s,])\`${escapeRe(field)}\`([\\s,]|$)`).test(firstCell);
    if (!fieldExact && !fieldGroup) continue;

    if (restCells.length >= 3 && /[a-zA-Z]/.test(restCells)) return true;
  }

  // (b) Field appears in a code block AND a "sentence describing it" appears
  //     within 5 lines (per the spec). We accept any of:
  //       (b1) Same-line `# comment` with at least one letter-word.
  //       (b2) A `#` section-header comment within 3 lines above (the YAML
  //            example block in cli-reference.md uses this pattern).
  //       (b3) A line of prose (outside code blocks) within ±5 lines that
  //            mentions the field by name with at least 5 words.
  const inCodeFlags = lines.map(() => false);
  {
    let inside = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*```/.test(lines[i] ?? '')) {
        inside = !inside;
        inCodeFlags[i] = false; // fence line itself
        continue;
      }
      inCodeFlags[i] = inside;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (!inCodeFlags[i]) continue;
    const line = lines[i] ?? '';

    // YAML key form: `<field>: <value>` (with or without trailing comment).
    const yamlMatch = line.match(
      new RegExp(`^\\s*${escapeRe(field)}\\s*:\\s*([^#\\n]*)(#\\s*(.+))?$`),
    );
    if (yamlMatch) {
      // (b1) inline comment
      const comment = (yamlMatch[3] ?? '').trim();
      if (comment.length > 0 && /[a-zA-Z]/.test(comment)) return true;

      // (b2) section header within 3 lines above
      for (let j = Math.max(0, i - 3); j < i; j++) {
        const above = lines[j] ?? '';
        if (!inCodeFlags[j]) continue;
        const sectionHeader = above.match(/^\s*#\s*(.+)$/);
        if (sectionHeader) {
          const text = (sectionHeader[1] ?? '').replace(/[─-]+/g, '').trim();
          // Must be a real description (≥ 2 letter-words), not just a divider.
          const words = text.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w));
          if (words.length >= 2) return true;
        }
      }
    }

    // (b3) field name in this code line; look for prose in a ±5-line window.
    if (new RegExp(`\\b${escapeRe(field)}\\b`).test(line)) {
      const start = Math.max(0, i - 5);
      const end = Math.min(lines.length - 1, i + 5);
      for (let j = start; j <= end; j++) {
        if (j === i) continue;
        if (inCodeFlags[j]) continue;
        const proseLine = (lines[j] ?? '').trim();
        if (!proseLine) continue;
        if (proseLine.startsWith('|')) continue; // table fragments handled in (a)
        if (proseLine.startsWith('#')) continue; // markdown headings aren't sentences
        // Must contain the field name AND ≥ 5 letter-words.
        if (!new RegExp(`\\b${escapeRe(field)}\\b`, 'i').test(proseLine)) continue;
        const words = proseLine.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w));
        if (words.length >= 5) return true;
      }
    }
  }

  return false;
}

function safeRead(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

describe('config surface doc-sync', () => {
  describe('EthosConfig fields are documented in config-yaml.md', () => {
    const src = readFileSync(ETHOS_CONFIG_SRC, 'utf-8');
    const fields = extractFields(src, 'EthosConfig');
    const doc = safeRead(CONFIG_REFERENCE_DOC);

    for (const field of fields) {
      if (field.internal) continue;
      if (UNDOCUMENTED_ETHOS_FIELDS.has(field.name)) {
        it(`tracks \`${field.name}\` as undocumented`, () => {
          expect(
            isDocumented(field.name, doc),
            `EthosConfig.${field.name} is now documented in using/reference/config-yaml.md — ` +
              `remove it from UNDOCUMENTED_ETHOS_FIELDS in this test.`,
          ).toBe(false);
        });
        continue;
      }
      it(`documents \`${field.name}\``, () => {
        expect(
          isDocumented(field.name, doc),
          `EthosConfig.${field.name} is not documented in using/reference/config-yaml.md.\n` +
            `Add either:\n` +
            `  (a) a markdown table row whose first cell names \`${field.name}\` and whose remaining cells describe it,\n` +
            `  (b) a YAML code-block line: \`${field.name}: <value>  # <comment>\`, or\n` +
            `  (c) a \`## ${field.name}\` reference section (the config-field schema).\n` +
            `If \`${field.name}\` is not user-facing, mark it with \`@internal\` in packages/config/src/index.ts.`,
        ).toBe(true);
      });
    }
  });

  describe('PersonalityConfig fields are documented in personality-yaml.md', () => {
    const src = readFileSync(PERSONALITY_SRC, 'utf-8');
    const fields = extractFields(src, 'PersonalityConfig');
    const doc = safeRead(PERSONALITY_REFERENCE_DOC);

    for (const field of fields) {
      if (field.internal) continue;
      if (UNDOCUMENTED_PERSONALITY_FIELDS.has(field.name)) {
        it(`tracks \`${field.name}\` as undocumented`, () => {
          expect(
            isDocumented(field.name, doc),
            `PersonalityConfig.${field.name} is now documented in using/reference/personality-yaml.md — ` +
              `remove it from UNDOCUMENTED_PERSONALITY_FIELDS in this test.`,
          ).toBe(false);
        });
        continue;
      }
      it(`documents \`${field.name}\``, () => {
        expect(
          isDocumented(field.name, doc),
          `PersonalityConfig.${field.name} is not documented in using/reference/personality-yaml.md.\n` +
            `Add either:\n` +
            `  (a) a markdown table row whose first cell names \`${field.name}\` and whose remaining cells describe it,\n` +
            `  (b) a YAML code-block line: \`${field.name}: <value>  # <comment>\`, or\n` +
            `  (c) a \`## ${field.name}\` reference section (the config-field schema).\n` +
            `If \`${field.name}\` is internal/derived (populated by the loader, not user-set), mark it with \`@internal\` in packages/types/src/personality.ts.`,
        ).toBe(true);
      });
    }
  });

  describe('docs reference no removed fields', () => {
    // Reverse direction: known historical fields that have been removed from
    // the schema must not be referenced in docs. Empty for now (no fields
    // have been removed); future removals add an entry here so the test
    // catches stale doc references.
    const REMOVED_ETHOS_FIELDS: string[] = [];
    const REMOVED_PERSONALITY_FIELDS: string[] = [];

    it('config-yaml.md does not document removed EthosConfig fields', () => {
      const doc = safeRead(CONFIG_REFERENCE_DOC);
      for (const field of REMOVED_ETHOS_FIELDS) {
        expect(
          isDocumented(field, doc),
          `EthosConfig.${field} was removed from the schema but using/reference/config-yaml.md still documents it. Remove the doc entry.`,
        ).toBe(false);
      }
    });

    it('personality-yaml.md does not document removed PersonalityConfig fields', () => {
      const doc = safeRead(PERSONALITY_REFERENCE_DOC);
      for (const field of REMOVED_PERSONALITY_FIELDS) {
        expect(
          isDocumented(field, doc),
          `PersonalityConfig.${field} was removed from the schema but using/reference/personality-yaml.md still documents it. Remove the doc entry.`,
        ).toBe(false);
      }
    });
  });
});
