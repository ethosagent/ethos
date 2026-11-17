import type { PersonalityConfig } from '@ethosagent/types';
import { PERSONALITY_DECISION_SITES } from './config-builders';
import type { CreatePersonalityInput } from './types';
import { normalizeWorkdir } from './workdirs';

// ---------------------------------------------------------------------------
// YAML parsers — no external dependency, handles the subset we need
// ---------------------------------------------------------------------------

const NESTED_BLOCKS = ['safety'] as const;

type NestedBlockName = (typeof NESTED_BLOCKS)[number];

function parseNestedBlock(
  lines: string[],
  startIdx: number,
): { obj: Record<string, unknown>; endIdx: number } {
  const obj: Record<string, unknown> = {};
  const indent = lines[startIdx]?.match(/^(\s+)/)?.[1]?.length ?? 2;
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.match(/^\s*#/)) {
      i++;
      continue;
    }
    const lineIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (lineIndent < indent) break;
    if (lineIndent === indent) {
      const m = line.match(/^\s+([\w]+):\s*(.*)$/);
      if (m) {
        const key = m[1];
        const val = m[2].trim();
        if (val === '' || val === '{}') {
          const next = lines[i + 1];
          const nextIndent = next?.match(/^(\s+)/)?.[1]?.length ?? 0;
          if (next && nextIndent > indent) {
            // A deeper-indented block follows. It is either a list (lines that
            // start with `- `) or a nested object. Lists on following lines are
            // not handled by the recursive object parser, so detect them here.
            if (next.trim().startsWith('- ')) {
              const items: string[] = [];
              let j = i + 1;
              while (j < lines.length) {
                const al = lines[j] ?? '';
                const alTrimmed = al.trim();
                if (alTrimmed === '' || alTrimmed.startsWith('#')) {
                  j++;
                  continue;
                }
                if (!alTrimmed.startsWith('- ')) break;
                items.push(
                  alTrimmed
                    .slice(2)
                    .trim()
                    .replace(/^["']|["']$/g, ''),
                );
                j++;
              }
              obj[key] = items;
              i = j;
              continue;
            }
            const { obj: child, endIdx } = parseNestedBlock(lines, i + 1);
            obj[key] = child;
            i = endIdx;
            continue;
          }
          obj[key] = {};
        } else if (val.startsWith('- ')) {
          const items: string[] = [val.slice(2)];
          let j = i + 1;
          while (j < lines.length) {
            const al = lines[j] ?? '';
            const alTrimmed = al.trim();
            if (!alTrimmed.startsWith('- ')) break;
            items.push(alTrimmed.slice(2).trim());
            j++;
          }
          obj[key] = items;
          i = j;
          continue;
        } else {
          obj[key] = val.replace(/^["']|["']$/g, '');
        }
      }
    }
    i++;
  }
  return { obj, endIdx: i };
}

/**
 * Extract the verbatim text of the `safety:` block from a config.yaml source.
 *
 * Captures from the `safety:` line through all subsequent indented child lines,
 * stopping at the first zero-indent non-blank, non-comment line (a new top-level
 * key) or EOF. Trailing blank lines inside the captured range are trimmed so we
 * do not emit stray blank lines. Returns '' if no safety block is found, and the
 * block WITHOUT a trailing newline (the caller adds spacing). This mirrors what
 * parseConfigYaml/parseNestedBlock consume, so it round-trips losslessly —
 * including sub-keys the read path does not parse (network, injectionDefense, …).
 */
export function extractRawSafetyBlock(src: string): string {
  const lines = src.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^safety:\s*$/.test(line) || /^safety:\s*\{\}\s*$/.test(line)) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (indent === 0) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end);
  while (block.length > 1 && (block[block.length - 1] ?? '').trim() === '') block.pop();
  return block.join('\n');
}

interface ParsedConfigYaml {
  flat: Record<string, string>;
  nested: Partial<Record<NestedBlockName, Record<string, unknown>>>;
}

export function parseConfigYaml(src: string): ParsedConfigYaml {
  const flat: Record<string, string> = {};
  const nested: Partial<Record<NestedBlockName, Record<string, unknown>>> = {};
  const srcLines = src.split('\n');

  // First pass: flat key-value pairs (and detect nested block starts)
  const nestedBlockStartLines = new Set<number>();
  for (let i = 0; i < srcLines.length; i++) {
    const line = srcLines[i] ?? '';

    // Check for top-level nested block declarations
    let foundNested = false;
    for (const block of NESTED_BLOCKS) {
      if (
        line.match(new RegExp(`^${block}:\\s*$`)) ||
        line.match(new RegExp(`^${block}:\\s*\\{\\}`))
      ) {
        const { obj } = parseNestedBlock(srcLines, i + 1);
        nested[block] = obj;
        // Mark lines consumed by the nested block (approximate: mark this start line)
        nestedBlockStartLines.add(i);
        foundNested = true;
        break;
      }
    }
    if (foundNested) continue;

    // Reject non-allowlisted nested blocks
    const nestedKey = line.match(/^(\w+):\s*$/)?.[1];
    if (nestedKey && !NESTED_BLOCKS.includes(nestedKey as NestedBlockName) && !line.match(/^#/)) {
      for (let j = i + 1; j < srcLines.length; j++) {
        const next = srcLines[j] ?? '';
        if (next.trim() === '') continue;
        if (next.match(/^\s+\w+:/)) {
          throw new Error(
            `Top-level key "${nestedKey}" cannot be a nested object in personality config. ` +
              `Only ${NESTED_BLOCKS.join(', ')} may be nested.`,
          );
        }
        break;
      }
    }

    // Allow dotted keys (e.g. `fs_reach.read`) so nested config can land
    // in the flat parser without escaping.
    const m = line.match(/^([\w.]+):\s*(.+)$/);
    if (m) flat[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }

  return { flat, nested };
}

/**
 * Set or remove flat top-level `key: value` lines in `config.yaml` text; every
 * other line is kept byte for byte. A key's first line is replaced and any
 * later duplicate dropped (the loader lets the LAST one win, `parseConfigYaml`,
 * so a leftover would override the change); a missing key is appended; `null`
 * removes every line of the key. Values go through {@link yamlScalar}, like
 * every rendered value. Only column-0 lines match, so nothing inside the
 * indented `safety:` block is touched.
 *
 * The writer behind identity amendments (plan personality-presence-and-
 * initiative §1): the bytes a reviewer approves are exactly these, and apply
 * writes them with `writeDefinitionBytes`, not through `update()`'s re-render.
 */
export function setConfigYamlScalars(
  src: string,
  updates: Readonly<Record<string, string | null>>,
): string {
  const lines = src === '' ? [] : src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of Object.entries(updates)) {
    const matcher = new RegExp(`^${key.replace(/[.]/g, '\\.')}:(\\s|$)`);
    const rendered = value === null ? null : `${key}: ${yamlScalar(value)}`;
    let placed = false;
    for (let i = 0; i < lines.length; i++) {
      if (!matcher.test(lines[i] ?? '')) continue;
      if (rendered !== null && !placed) {
        lines[i] = rendered;
        placed = true;
      } else {
        lines.splice(i, 1);
        i--;
      }
    }
    if (rendered !== null && !placed) lines.push(rendered);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export function yamlScalar(value: string): string {
  if (/[:\n\r#[\]{}&*!|>'"%@`]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Fields `renderConfigYaml` can emit. A superset of the user-settable
 * `CreatePersonalityInput` and the full `PersonalityConfig` so `update()` can
 * round-trip the entire existing config losslessly. Loader-populated fields
 * (`id`, `soulFile`, `skillsDirs`) and `soulMd` are intentionally excluded —
 * they are not part of config.yaml.
 */
export type RenderConfigInput = Omit<CreatePersonalityInput, 'id' | 'soulMd' | 'safety'> &
  Pick<
    PersonalityConfig,
    | 'platform'
    | 'streamingTimeoutMs'
    | 'budgetCapUsd'
    | 'safety'
    | 'context_engine'
    | 'context_engine_options'
    | 'context_layering'
    | 'memory'
    | 'mcp_export'
    | 'skills'
    | 'outbound_policy'
    | 'voice'
    | 'display'
    | 'execution'
    | 'decisions'
  >;

export function renderConfigYaml(input: RenderConfigInput): string {
  const lines: string[] = [`name: ${yamlScalar(input.name)}`];
  if (input.description) lines.push(`description: ${yamlScalar(input.description)}`);
  if (input.provider) lines.push(`provider: ${yamlScalar(input.provider)}`);
  if (input.platform) lines.push(`platform: ${yamlScalar(input.platform)}`);
  if (input.model) {
    if (typeof input.model === 'string') {
      lines.push(`model: ${yamlScalar(input.model)}`);
    } else {
      if (input.model.trivial) lines.push(`model.trivial: ${yamlScalar(input.model.trivial)}`);
      if (input.model.default) lines.push(`model.default: ${yamlScalar(input.model.default)}`);
      if (input.model.deep) lines.push(`model.deep: ${yamlScalar(input.model.deep)}`);
      if (input.model.dreaming) lines.push(`model.dreaming: ${yamlScalar(input.model.dreaming)}`);
    }
  }
  if (input.capabilities !== undefined && input.capabilities.length > 0) {
    lines.push(`capabilities: ${input.capabilities.map(yamlScalar).join(', ')}`);
  }
  if (input.mcp_servers !== undefined)
    lines.push(`mcp_servers: ${input.mcp_servers.map(yamlScalar).join(' ')}`);
  if (input.plugins !== undefined)
    lines.push(`plugins: ${input.plugins.map(yamlScalar).join(' ')}`);
  if (input.fs_reach?.read !== undefined && input.fs_reach.read.length > 0) {
    lines.push(`fs_reach.read: ${input.fs_reach.read.join(', ')}`);
  }
  if (input.fs_reach?.write !== undefined && input.fs_reach.write.length > 0) {
    lines.push(`fs_reach.write: ${input.fs_reach.write.join(', ')}`);
  }
  // Comma-separated, the same form `parseCsv` reads back — a single workdir
  // still renders as the bare path it always did.
  const workdirs = normalizeWorkdir(input.fs_reach?.workdir);
  if (workdirs.length > 0) {
    lines.push(`fs_reach.workdir: ${workdirs.join(', ')}`);
  }
  if (input.streamingTimeoutMs !== undefined) {
    lines.push(`streamingTimeoutMs: ${input.streamingTimeoutMs}`);
  }
  if (input.budgetCapUsd !== undefined) lines.push(`budgetCapUsd: ${input.budgetCapUsd}`);
  if (input.context_engine !== undefined) {
    lines.push(`context_engine: ${yamlScalar(input.context_engine)}`);
  }
  if (input.context_engine_options !== undefined) {
    for (const [k, v] of Object.entries(input.context_engine_options)) {
      lines.push(`context_engine_options.${k}: ${renderScalarValue(v)}`);
    }
  }
  if (input.context_layering !== undefined) {
    const cl = input.context_layering;
    if (cl.mode !== undefined) lines.push(`context_layering.mode: ${cl.mode}`);
    if (cl.max_depth !== undefined) lines.push(`context_layering.max_depth: ${cl.max_depth}`);
    if (cl.discovery_files !== undefined) {
      lines.push(`context_layering.discovery_files: ${cl.discovery_files.join(', ')}`);
    }
    if (cl.cap_total_chars !== undefined) {
      lines.push(`context_layering.cap_total_chars: ${cl.cap_total_chars}`);
    }
  }
  if (input.skill_evolution) {
    const se = input.skill_evolution;
    if (se.enabled !== undefined) lines.push(`skill_evolution.enabled: ${se.enabled}`);
    if (se.min_tool_calls !== undefined)
      lines.push(`skill_evolution.min_tool_calls: ${se.min_tool_calls}`);
    if (se.cooldown_minutes !== undefined)
      lines.push(`skill_evolution.cooldown_minutes: ${se.cooldown_minutes}`);
    if (se.model !== undefined) lines.push(`skill_evolution.model: ${yamlScalar(se.model)}`);
    if (se.evolve_existing !== undefined)
      lines.push(`skill_evolution.evolve_existing: ${se.evolve_existing}`);
    if (se.promotion !== undefined) lines.push(`skill_evolution.promotion: ${se.promotion}`);
    if (se.scope !== undefined) lines.push(`skill_evolution.scope: ${se.scope}`);
  }
  if (input.skills?.injection_mode !== undefined) {
    lines.push(`skills.injection_mode: ${input.skills.injection_mode}`);
  }
  const ingest = input.skills?.global_ingest;
  if (ingest !== undefined) {
    const p = 'skills.global_ingest';
    if (ingest.mode !== undefined) lines.push(`${p}.mode: ${ingest.mode}`);
    if (ingest.accept_tags?.length)
      lines.push(`${p}.accept_tags: ${ingest.accept_tags.join(', ')}`);
    if (ingest.reject_tags?.length)
      lines.push(`${p}.reject_tags: ${ingest.reject_tags.join(', ')}`);
    if (ingest.allow?.length) lines.push(`${p}.allow: ${ingest.allow.join(', ')}`);
    if (ingest.deny?.length) lines.push(`${p}.deny: ${ingest.deny.join(', ')}`);
    if (ingest.fallback_unknown !== undefined) {
      lines.push(`${p}.fallback_unknown: ${ingest.fallback_unknown}`);
    }
  }
  if (input.memory !== undefined) {
    lines.push(`memory.provider: ${yamlScalar(input.memory.provider)}`);
    if (input.memory.options !== undefined) {
      for (const [k, v] of Object.entries(input.memory.options)) {
        lines.push(`memory.options.${k}: ${renderScalarValue(v)}`);
      }
    }
  }
  if (input.mcp_export !== undefined) {
    const me = input.mcp_export;
    lines.push(`mcp_export.enabled: ${me.enabled}`);
    if (me.expose_tools !== undefined) {
      const tools = Array.isArray(me.expose_tools) ? me.expose_tools.join(' ') : me.expose_tools;
      lines.push(`mcp_export.expose_tools: ${tools}`);
    }
    if (me.expose_memory !== undefined) lines.push(`mcp_export.expose_memory: ${me.expose_memory}`);
    if (me.expose_sessions !== undefined) {
      lines.push(`mcp_export.expose_sessions: ${me.expose_sessions}`);
    }
    if (me.auth !== undefined) lines.push(`mcp_export.auth: ${me.auth}`);
  }
  if (input.outbound_policy !== undefined) {
    const op = input.outbound_policy;
    lines.push(`outbound_policy.approve_before_send: ${op.approve_before_send}`);
    if (op.channels !== undefined) {
      lines.push(`outbound_policy.channels: ${op.channels.join(' ')}`);
    }
    if (op.approver_personality !== undefined) {
      lines.push(`outbound_policy.approver_personality: ${yamlScalar(op.approver_personality)}`);
    }
  }
  if (input.dreaming !== undefined) {
    const d = input.dreaming;
    lines.push(`dreaming.enable: ${d.enable}`);
    if (d.idleMinutes !== undefined) lines.push(`dreaming.idleMinutes: ${d.idleMinutes}`);
    if (d.maxPerDay !== undefined) lines.push(`dreaming.maxPerDay: ${d.maxPerDay}`);
    if (d.prompt !== undefined) lines.push(`dreaming.prompt: ${yamlScalar(d.prompt)}`);
  }
  if (input.nightly !== undefined) {
    const n = input.nightly;
    if (n.enabled !== undefined) lines.push(`nightly.enabled: ${n.enabled}`);
    if (n.judge?.enabled !== undefined) lines.push(`nightly.judge.enabled: ${n.judge.enabled}`);
    if (n.judge?.minInteractions !== undefined) {
      lines.push(`nightly.judge.minInteractions: ${n.judge.minInteractions}`);
    }
    if (n.expression !== undefined) lines.push(`nightly.expression: ${n.expression}`);
  }
  if (input.evolution_approval_mode !== undefined) {
    lines.push(`evolution_approval_mode: ${yamlScalar(input.evolution_approval_mode)}`);
  }
  if (input.execution !== undefined) {
    lines.push(`execution: ${yamlScalar(input.execution)}`);
  }
  if (input.voice !== undefined) {
    const v = input.voice;
    // Always the NEW spelling — a personality read from `voice.provider` is
    // written back as `voice.tts_provider`, never both.
    if (v.tts_provider !== undefined) {
      lines.push(`voice.tts_provider: ${yamlScalar(v.tts_provider)}`);
    }
    if (v.stt_provider !== undefined) {
      lines.push(`voice.stt_provider: ${yamlScalar(v.stt_provider)}`);
    }
    if (v.realtime_provider !== undefined) {
      lines.push(`voice.realtime_provider: ${yamlScalar(v.realtime_provider)}`);
    }
    if (v.tts_voice !== undefined) lines.push(`voice.tts_voice: ${yamlScalar(v.tts_voice)}`);
    if (v.tier !== undefined) lines.push(`voice.tier: ${v.tier}`);
    if (v.model !== undefined) lines.push(`voice.model: ${yamlScalar(v.model)}`);
    if (v.call_style !== undefined) lines.push(`voice.call_style: ${v.call_style}`);
    for (const [tag, id] of Object.entries(v.languages ?? {})) {
      lines.push(`voice.languages.${tag}: ${yamlScalar(id)}`);
    }
  }
  if (input.display?.avatar_url !== undefined) {
    lines.push(`display.avatar_url: ${yamlScalar(input.display.avatar_url)}`);
  }
  if (input.display?.emoji !== undefined) {
    lines.push(`display.emoji: ${yamlScalar(input.display.emoji)}`);
  }
  if (input.decisions !== undefined) {
    const d = input.decisions;
    if (d.provider !== undefined) lines.push(`decisions.provider: ${yamlScalar(d.provider)}`);
    for (const site of PERSONALITY_DECISION_SITES) {
      const mode = d.sites?.[site];
      if (mode !== undefined) lines.push(`decisions.sites.${site}: ${mode}`);
    }
  }
  if (input.safety !== undefined && Object.keys(input.safety).length > 0) {
    lines.push('safety:');
    lines.push(...renderNestedBlock(input.safety as Record<string, unknown>, 1));
  }
  return `${lines.join('\n')}\n`;
}

/** Render a scalar config value (string/number/boolean) for a dotted key. */
export function renderScalarValue(v: unknown): string {
  if (typeof v === 'string') return yamlScalar(v);
  return String(v);
}

/**
 * Emit a nested object block (the inverse of `parseNestedBlock`) at the given
 * indent depth (2 spaces per level). Mirrors the parser's value handling:
 * scalars inline, string arrays as `- item` lists, and nested objects
 * recursively. Used for `safety:`.
 */
export function renderNestedBlock(obj: Record<string, unknown>, depth: number): string[] {
  const pad = '  '.repeat(depth);
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      out.push(`${pad}${key}:`);
      for (const item of value) out.push(`${pad}  - ${renderScalarValue(item)}`);
    } else if (value !== null && typeof value === 'object') {
      out.push(`${pad}${key}:`);
      out.push(...renderNestedBlock(value as Record<string, unknown>, depth + 1));
    } else {
      out.push(`${pad}${key}: ${renderScalarValue(value)}`);
    }
  }
  return out;
}

/**
 * Render one nested sub-key of a `safety:` block (`network:`, …) as the lines
 * that replace it. An object with nothing left to emit becomes `key: {}` — the
 * shape `parseNestedBlock` reads back as an empty block, which is how a cleared
 * sub-key (an emptied allow list) survives the round trip.
 */
export function renderSafetySubBlock(key: string, value: Record<string, unknown>): string[] {
  const children = renderNestedBlock(value, 2);
  return children.length > 0 ? [`  ${key}:`, ...children] : [`  ${key}: {}`];
}

/** How many lines the sub-block starting at `idx` spans: its own line plus
 *  every deeper-indented line under it. */
export function subBlockLength(lines: string[], idx: number): number {
  let end = idx + 1;
  while (end < lines.length && /^\s{3,}\S/.test(lines[end] ?? '')) end++;
  return end - idx;
}
