import {
  type DreamingConfig,
  isSingleEmojiGrapheme,
  type ModelTierConfig,
  type PersonalityConfig,
  type PersonalityObservabilityConfig,
  type PersonalitySafetyConfig,
} from '@ethosagent/types';

export function buildContextLayering(
  cfg: Record<string, string>,
): PersonalityConfig['context_layering'] | undefined {
  const mode = cfg['context_layering.mode'];
  const maxDepth = cfg['context_layering.max_depth'];
  const discovery = cfg['context_layering.discovery_files'];
  const cap = cfg['context_layering.cap_total_chars'];
  if (!mode && !maxDepth && !discovery && !cap) return undefined;
  const out: NonNullable<PersonalityConfig['context_layering']> = {};
  if (mode) {
    if (mode !== 'static' && mode !== 'progressive' && mode !== 'off') {
      throw new Error(
        `Invalid context_layering.mode: "${mode}". Expected one of: static, progressive, off`,
      );
    }
    out.mode = mode;
  }
  if (maxDepth && /^\d+$/.test(maxDepth)) out.max_depth = Number.parseInt(maxDepth, 10);
  if (discovery) {
    const list = discovery
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) out.discovery_files = list;
  }
  if (cap && /^\d+$/.test(cap)) out.cap_total_chars = Number.parseInt(cap, 10);
  return out;
}

export function buildSkillEvolution(
  cfg: Record<string, string>,
): PersonalityConfig['skill_evolution'] | undefined {
  const enabled = cfg['skill_evolution.enabled'];
  const minToolCalls = cfg['skill_evolution.min_tool_calls'];
  const cooldown = cfg['skill_evolution.cooldown_minutes'];
  const model = cfg['skill_evolution.model'];
  const evolveExisting = cfg['skill_evolution.evolve_existing'];
  const promotion = cfg['skill_evolution.promotion'];
  const scope = cfg['skill_evolution.scope'];
  if (!enabled && !minToolCalls && !cooldown && !model && !evolveExisting && !promotion && !scope) {
    return undefined;
  }
  const out: NonNullable<PersonalityConfig['skill_evolution']> = {};
  if (enabled === 'true') out.enabled = true;
  else if (enabled === 'false') out.enabled = false;
  if (minToolCalls && /^\d+$/.test(minToolCalls)) {
    out.min_tool_calls = Number.parseInt(minToolCalls, 10);
  }
  if (cooldown && /^\d+$/.test(cooldown)) {
    out.cooldown_minutes = Number.parseInt(cooldown, 10);
  }
  if (model) out.model = model;
  if (evolveExisting === 'true') out.evolve_existing = true;
  else if (evolveExisting === 'false') out.evolve_existing = false;
  if (promotion === 'review' || promotion === 'auto') out.promotion = promotion;
  if (scope === 'personality' || scope === 'shared') out.scope = scope;
  return out;
}

export function buildDreamingConfig(cfg: Record<string, string>): DreamingConfig | undefined {
  const enable = cfg['dreaming.enable'];
  if (enable !== 'true') return undefined;
  const idleMinutes = cfg['dreaming.idleMinutes'];
  const maxPerDay = cfg['dreaming.maxPerDay'];
  const prompt = cfg['dreaming.prompt'];
  const out: DreamingConfig = {
    enable: true,
    idleMinutes: idleMinutes && /^\d+$/.test(idleMinutes) ? Number.parseInt(idleMinutes, 10) : 60,
    maxPerDay: maxPerDay && /^\d+$/.test(maxPerDay) ? Number.parseInt(maxPerDay, 10) : 1,
  };
  if (prompt) out.prompt = prompt;
  return out;
}

// Parse the dotted nightly.* keys into a PersonalityConfig['nightly'] block.
// Only emits the keys actually present so absent fields fall back to their
// behavior-preserving defaults at the call sites. Returns undefined when no
// nightly.* key is set, so the personality carries no nightly block at all.
export function buildNightlyConfig(
  cfg: Record<string, string>,
): PersonalityConfig['nightly'] | undefined {
  const enabled = cfg['nightly.enabled'];
  const judgeEnabled = cfg['nightly.judge.enabled'];
  const minInteractions = cfg['nightly.judge.minInteractions'];
  const expression = cfg['nightly.expression'];
  if (
    enabled === undefined &&
    judgeEnabled === undefined &&
    minInteractions === undefined &&
    expression === undefined
  ) {
    return undefined;
  }
  const out: NonNullable<PersonalityConfig['nightly']> = {};
  if (enabled !== undefined) out.enabled = enabled === 'true';
  const judge: NonNullable<NonNullable<PersonalityConfig['nightly']>['judge']> = {};
  if (judgeEnabled !== undefined) judge.enabled = judgeEnabled === 'true';
  if (minInteractions !== undefined && /^\d+$/.test(minInteractions)) {
    judge.minInteractions = Number.parseInt(minInteractions, 10);
  }
  if (judge.enabled !== undefined || judge.minInteractions !== undefined) out.judge = judge;
  if (expression !== undefined) out.expression = expression === 'true';
  return out;
}

export function buildMemoryConfig(
  cfg: Record<string, string>,
): import('@ethosagent/types').PersonalityMemoryConfig | undefined {
  const provider = cfg['memory.provider'];
  if (!provider) return undefined;
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (!key.startsWith('memory.options.')) continue;
    const subKey = key.slice('memory.options.'.length);
    if (subKey.length === 0) continue;
    if (/^-?\d+$/.test(value)) options[subKey] = Number.parseInt(value, 10);
    else if (value === 'true') options[subKey] = true;
    else if (value === 'false') options[subKey] = false;
    else options[subKey] = value;
  }
  return { provider, ...(Object.keys(options).length > 0 ? { options } : {}) };
}

/**
 * Parse the dotted `voice.*` keys into `PersonalityConfig.voice`.
 *
 * Dotted keys, not a nested block: `config.yaml` is flat by design, the flat
 * parser already reads `[\w.]+` keys, and every comparable field (`fs_reach.*`,
 * `memory.options.*`, `nightly.judge.*`) uses the same shape. Adding `voice` to
 * `NESTED_BLOCKS` would mean a second parse path, a second render path, and a
 * raw-block-preservation dance like `safety`'s — for four scalars and a string
 * map. The language map mirrors `memory.options.*`: any `voice.languages.<tag>`
 * key becomes an entry.
 *
 *   voice.tts_provider: studio
 *   voice.stt_provider: whisper-es
 *   voice.realtime_provider: live
 *   voice.tts_voice: af_bella
 *   voice.tier: pipeline
 *   voice.model: claude-haiku-4-5
 *   voice.call_style: rings
 *   voice.languages.es: ef_dora
 *
 * `voice.tts_provider` / `voice.stt_provider` / `voice.realtime_provider` name
 * entries in the deployment's `voice.tts.providers.*` / `voice.stt.providers.*`
 * / `voice.realtime.providers.*` rosters. They are kept verbatim — validating
 * them here would mean this loader knew the machine's config, and a name this
 * machine lacks is a fallback at resolution time (`selectTtsEntry` /
 * `selectSttEntry`), not a load failure.
 *
 * `voice.provider` is accepted as the older spelling of `voice.tts_provider`
 * (it shipped before a personality could name an STT engine). The explicit new
 * key wins; the renderer only ever writes the new one, so a personality
 * re-saved from either spelling carries one key, not two.
 *
 * An unknown `voice.tier` or `voice.call_style` is dropped rather than thrown
 * on: a bad voice id should not make a personality unloadable — it falls back
 * to the global voice, and to the operator/derived call treatment.
 */
export function buildVoiceConfig(
  cfg: Record<string, string>,
): import('@ethosagent/types').PersonalityVoiceConfig | undefined {
  const ttsProvider = cfg['voice.tts_provider'] || cfg['voice.provider'];
  const sttProvider = cfg['voice.stt_provider'];
  const realtimeProvider = cfg['voice.realtime_provider'];
  const ttsVoice = cfg['voice.tts_voice'];
  const tier = cfg['voice.tier'];
  const model = cfg['voice.model'];
  const callStyle = cfg['voice.call_style'];
  const languages: Record<string, string> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (!key.startsWith('voice.languages.')) continue;
    const tag = key.slice('voice.languages.'.length);
    if (tag.length > 0 && value) languages[tag] = value;
  }
  const out: import('@ethosagent/types').PersonalityVoiceConfig = {
    ...(ttsProvider ? { tts_provider: ttsProvider } : {}),
    ...(sttProvider ? { stt_provider: sttProvider } : {}),
    ...(realtimeProvider ? { realtime_provider: realtimeProvider } : {}),
    ...(ttsVoice ? { tts_voice: ttsVoice } : {}),
    ...(tier === 'pipeline' || tier === 'realtime' ? { tier } : {}),
    ...(model ? { model } : {}),
    ...(callStyle === 'liquid' || callStyle === 'orb' || callStyle === 'rings'
      ? { call_style: callStyle }
      : {}),
    ...(Object.keys(languages).length > 0 ? { languages } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse the dotted `display.*` keys into `PersonalityConfig.display`.
 *
 * Same dotted-key convention as `voice` (see `buildVoiceConfig` above): a
 * true nested block would mean a second parse path and a second render path
 * for two scalars.
 *
 *   display.avatar_url: /api/personalities/researcher/avatar
 *   display.emoji: 🦉
 *
 * An emoji that fails `isSingleEmojiGrapheme` is dropped and named in
 * `warnings` rather than thrown: a cosmetic value must never stop a
 * personality from loading.
 */
export function buildDisplayConfig(
  cfg: Record<string, string>,
  warnings: string[],
): import('@ethosagent/types').PersonalityConfig['display'] | undefined {
  const avatarUrl = cfg['display.avatar_url'];
  const emoji = cfg['display.emoji'];
  let validEmoji: string | undefined;
  if (emoji) {
    if (isSingleEmojiGrapheme(emoji)) {
      validEmoji = emoji;
    } else {
      const shown = emoji.length > 40 ? `${emoji.slice(0, 40)}…` : emoji;
      warnings.push(
        `config.yaml: display.emoji ${JSON.stringify(shown)} is not a single emoji — ignored`,
      );
    }
  }
  if (!avatarUrl && !validEmoji) return undefined;
  return {
    ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
    ...(validEmoji ? { emoji: validEmoji } : {}),
  };
}

export const PERSONALITY_DECISION_SITES = [
  'injection',
  'approver',
  'router',
] as const satisfies readonly import('@ethosagent/types').PersonalityDecisionSiteId[];

/**
 * Parse the dotted `decisions.*` keys into `PersonalityConfig.decisions`
 * (plan decision-provider-personality §4.2). Same dotted-key convention as
 * `voice` (see `buildVoiceConfig` above):
 *
 *   decisions.provider: typesafe
 *   decisions.sites.injection: shadow
 *   decisions.sites.approver: on
 *   decisions.sites.router: off
 *
 * `decisions.provider` names the operator's `decisions.provider` in
 * `~/.ethos/config.yaml` and is kept verbatim — whether this machine configured
 * it is a resolution-time question, not a load failure (the
 * `voice.tts_provider` rule). A site mode outside `off | shadow | on` is
 * dropped rather than thrown on, exactly like an unknown `voice.tier` (PD12):
 * the site is then undeclared, i.e. `off`. Unknown `decisions.sites.<x>` keys
 * are ignored.
 */
export function buildDecisionsConfig(
  cfg: Record<string, string>,
): PersonalityConfig['decisions'] | undefined {
  const provider = cfg['decisions.provider'];
  const sites: NonNullable<import('@ethosagent/types').PersonalityDecisionsConfig['sites']> = {};
  for (const site of PERSONALITY_DECISION_SITES) {
    const mode = cfg[`decisions.sites.${site}`];
    if (mode === 'off' || mode === 'shadow' || mode === 'on') sites[site] = mode;
  }
  const out: import('@ethosagent/types').PersonalityDecisionsConfig = {
    ...(provider ? { provider } : {}),
    ...(Object.keys(sites).length > 0 ? { sites } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

const EXECUTION_REQUIREMENTS = ['remote', 'none'] as const;

/**
 * The three literals this key used to accept and no longer does, each with the
 * sentence that tells its author where the thing they meant now lives. Named
 * individually rather than folded into the generic "expected one of" error
 * because the fix differs per value: `ssh` has a direct replacement, and
 * `docker` / `local` have none — they were never the personality's to state.
 */
const RETIRED_EXECUTION_VALUES: Record<string, string> = {
  ssh:
    'a personality declares a REQUIREMENT, not a transport. Use `execution: remote` ' +
    'and name the machine under `execution.ssh.*` in ~/.ethos/config.yaml.',
  docker:
    "sandboxing is the operator's choice, not the personality's. Remove this key — " +
    'an exec-bearing personality is already sandboxed by default.',
  local:
    "running un-sandboxed on this host is the operator's choice, not the " +
    "personality's. Remove this key and set `execution.containerized` in " +
    '~/.ethos/config.yaml (or ETHOS_EXECUTION_BACKEND=local) if this deployment ' +
    'is itself the boundary.',
};

/**
 * Execution requirement — what this personality demands of wherever its
 * execution tools run. Validated rather than silently dropped: a typo would
 * otherwise fall through to the resolver's default and run the agent's hands
 * somewhere the author did not choose.
 *
 * The retired transport literals (`ssh`, `docker`, `local`) are REJECTED, not
 * translated. `ssh` → `remote` is a translation anyone could argue is safe, and
 * it is exactly the kind of quiet contract shift this key exists to prevent —
 * the author should read the one sentence that says a personality no longer
 * names transports. `docker` and `local` have no honest translation at all: a
 * silent drop would move where an agent's hands run without telling anyone.
 * The remote TARGET is operator config (`execution.ssh.*` in
 * ~/.ethos/config.yaml), never this key.
 */
export function parseExecutionPosture(raw: string | undefined): PersonalityConfig['execution'] {
  if (!raw) return undefined;
  const requirement = EXECUTION_REQUIREMENTS.find((r) => r === raw);
  if (requirement) return requirement;
  const retired = RETIRED_EXECUTION_VALUES[raw];
  const expected = `Expected one of: ${EXECUTION_REQUIREMENTS.join(', ')}`;
  throw new Error(
    retired
      ? `Invalid execution: "${raw}" is no longer accepted — ${retired} ${expected}.`
      : `Invalid execution: "${raw}". ${expected}`,
  );
}

/**
 * The platforms `outbound_policy.channels` may name.
 *
 * A deliberate COPY of `SEND_MESSAGE_PLATFORMS` in
 * `extensions/tools-messaging/src/index.ts` — the roster the gated tool
 * actually addresses. It is not shared code because both are extensions and
 * `@ethosagent/personalities` must not import a sibling extension (O-D2; the
 * same layer reason the gate seam in tools-messaging is declared
 * structurally rather than imported). The two are pinned equal by
 * `packages/wiring/src/__tests__/outbound-policy-platforms.test.ts`, which
 * imports BOTH and fails if either list moves alone — `packages/wiring` is
 * the lowest layer that can see both. **They must change together:** a
 * platform added to `send_message` and not to this list would be refused at
 * load for anyone trying to gate it; one removed here and not there would go
 * back to sending ungated.
 */
export const OUTBOUND_POLICY_PLATFORMS = [
  'slack',
  'telegram',
  'discord',
  'whatsapp',
  'email',
] as const;

/**
 * Outbound approval policy — the block `executeSendMessage`
 * (extensions/tools-messaging/src/index.ts) reads to decide whether a
 * `send_message` publishes or is queued for a human.
 *
 * `channels` is VALIDATED rather than passed through, for the same reason
 * `parseExecutionPosture` validates its requirement: a typo here is silent
 * and its failure mode is the dangerous direction. `channels: telgram` would
 * match no platform, so the gate would never fire and the personality this
 * key exists to hold back would publish freely — with a config that reads as
 * if it were gated. Validation runs whatever `approve_before_send` says,
 * because a `false` today is a `true` after one edit.
 *
 * One case it does NOT catch, because the whole block is gone by then: a
 * config.yaml declaring `outbound_policy.channels` with no
 * `outbound_policy.approve_before_send` returns `undefined` on the first line
 * below, so nothing is parsed and nothing is validated. That config also gates
 * nothing, which is the honest reading of a policy whose only required field is
 * missing — but the unknown name in it goes unreported.
 */
export function buildOutboundPolicy(
  cfg: Record<string, string>,
): import('@ethosagent/types').OutboundPolicyConfig | undefined {
  const approve = cfg['outbound_policy.approve_before_send'];
  if (!approve) return undefined;
  const out: import('@ethosagent/types').OutboundPolicyConfig = {
    approve_before_send: approve === 'true',
  };
  const channels = cfg['outbound_policy.channels'];
  if (channels) out.channels = parseOutboundChannels(channels);
  const approver = cfg['outbound_policy.approver_personality'];
  if (approver) out.approver_personality = approver;
  return out;
}

function parseOutboundChannels(raw: string): string[] {
  const names = raw.split(/\s+/).filter(Boolean);
  const known: readonly string[] = OUTBOUND_POLICY_PLATFORMS;
  for (const name of names) {
    if (known.includes(name)) continue;
    throw new Error(
      `Invalid outbound_policy.channels: "${name}". ` +
        `Expected one of: ${OUTBOUND_POLICY_PLATFORMS.join(', ')}.`,
    );
  }
  return names;
}

/**
 * The shape of one `mcp_export.expose_tools` entry the update path will write.
 * Kept in step with the `personalities.update` input in
 * `packages/web-contracts/src/routes/personalities.ts` (`McpExportToolNameInput`), which
 * refuses the same names at the wire.
 */
export const MCP_EXPORT_TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;

export function buildMcpExportConfig(
  cfg: Record<string, string>,
): import('@ethosagent/types').PersonalityMcpExportConfig | undefined {
  const enabled = cfg['mcp_export.enabled'];
  if (!enabled) return undefined;
  const out: import('@ethosagent/types').PersonalityMcpExportConfig = {
    enabled: enabled === 'true',
  };
  const tools = cfg['mcp_export.expose_tools'];
  if (tools === 'all' || tools === 'none') out.expose_tools = tools;
  else if (tools) out.expose_tools = tools.split(/\s+/).filter(Boolean);
  const memory = cfg['mcp_export.expose_memory'];
  if (memory === 'scoped' || memory === 'none' || memory === 'full') out.expose_memory = memory;
  if (cfg['mcp_export.expose_sessions'] === 'true') out.expose_sessions = true;
  if (cfg['mcp_export.expose_sessions'] === 'false') out.expose_sessions = false;
  const auth = cfg['mcp_export.auth'];
  if (auth === 'localhost' || auth === 'bearer') out.auth = auth;
  return out;
}

const INGEST_MODES = ['capability', 'tags', 'explicit', 'none'] as const;

const INGEST_FALLBACKS = ['deny', 'warn', 'allow'] as const;

const INJECTION_MODES = ['full', 'index'] as const;

/**
 * `skills.*` dotted keys → `PersonalityConfig.skills`. `skills` is not in
 * `NESTED_BLOCKS`, so the dotted form is the only way to write it.
 *
 * - `skills.global_ingest.*` → `skills.global_ingest`, the filter
 *   `extensions/skills/src/ingest-filter.ts` applies to the global skill pool.
 *   Lists are comma-separated, like `fs_reach.*`.
 * - `skills.injection_mode` → `skills.injection_mode`, read by
 *   `SkillsInjector` (`extensions/skills/src/skills-injector.ts`) to pick a
 *   skill index or full bodies, and by `usesSkillIndexMode`
 *   (`packages/core/src/agent-loop/ghost-skills.ts`) for the ghost-skill markers.
 *
 * A `mode`, `fallback_unknown` or `injection_mode` outside its vocabulary is
 * ignored and the reader's default (`capability` / `allow` / `index`) stands,
 * the same as leaving the key out.
 */
export function buildSkillsConfig(
  cfg: Record<string, string>,
): PersonalityConfig['skills'] | undefined {
  const prefix = 'skills.global_ingest.';
  const mode = cfg[`${prefix}mode`];
  const fallback = cfg[`${prefix}fallback_unknown`];
  const acceptTags = parseCsv(cfg[`${prefix}accept_tags`]);
  const rejectTags = parseCsv(cfg[`${prefix}reject_tags`]);
  const allow = parseCsv(cfg[`${prefix}allow`]);
  const deny = parseCsv(cfg[`${prefix}deny`]);
  const ingest: NonNullable<NonNullable<PersonalityConfig['skills']>['global_ingest']> = {};
  if (INGEST_MODES.includes(mode as (typeof INGEST_MODES)[number])) {
    ingest.mode = mode as (typeof INGEST_MODES)[number];
  }
  if (INGEST_FALLBACKS.includes(fallback as (typeof INGEST_FALLBACKS)[number])) {
    ingest.fallback_unknown = fallback as (typeof INGEST_FALLBACKS)[number];
  }
  if (acceptTags) ingest.accept_tags = acceptTags;
  if (rejectTags) ingest.reject_tags = rejectTags;
  if (allow) ingest.allow = allow;
  if (deny) ingest.deny = deny;
  const skills: NonNullable<PersonalityConfig['skills']> = {};
  if (Object.keys(ingest).length > 0) skills.global_ingest = ingest;
  const injectionMode = cfg['skills.injection_mode'];
  if (INJECTION_MODES.includes(injectionMode as (typeof INJECTION_MODES)[number])) {
    skills.injection_mode = injectionMode as (typeof INJECTION_MODES)[number];
  }
  return Object.keys(skills).length > 0 ? skills : undefined;
}

export function buildModelConfig(
  cfg: Record<string, string>,
): string | ModelTierConfig | undefined {
  const trivial = cfg['model.trivial'];
  const defaultModel = cfg['model.default'];
  const deep = cfg['model.deep'];
  const dreaming = cfg['model.dreaming'];
  if (!trivial && !defaultModel && !deep && !dreaming) return cfg.model || undefined;
  const out: ModelTierConfig = {};
  if (trivial) out.trivial = trivial;
  if (defaultModel) out.default = defaultModel;
  if (deep) out.deep = deep;
  if (dreaming) out.dreaming = dreaming;
  return out;
}

export function buildContextEngineOptions(
  cfg: Record<string, string>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (!key.startsWith('context_engine_options.')) continue;
    const subKey = key.slice('context_engine_options.'.length);
    if (subKey.length === 0) continue;
    if (/^-?\d+$/.test(value)) out[subKey] = Number.parseInt(value, 10);
    else if (/^-?\d+\.\d+$/.test(value)) out[subKey] = Number.parseFloat(value);
    else if (value === 'true') out[subKey] = true;
    else if (value === 'false') out[subKey] = false;
    else out[subKey] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function buildSafetyConfig(raw: Record<string, unknown>): PersonalitySafetyConfig {
  const result: PersonalitySafetyConfig = {};
  const obs = raw.observability as Record<string, unknown> | undefined;
  if (obs) {
    const validStoreValues = ['none', 'redacted', 'full'] as const;
    const validLlmValues = ['none', 'metadata', 'full'] as const;
    const observability: PersonalityObservabilityConfig = {};
    if (obs.storeToolArgs !== undefined) {
      if (!validStoreValues.includes(obs.storeToolArgs as (typeof validStoreValues)[number]))
        throw new Error(`Invalid storeToolArgs: "${obs.storeToolArgs}"`);
      observability.storeToolArgs =
        obs.storeToolArgs as PersonalityObservabilityConfig['storeToolArgs'];
    }
    if (obs.storeToolBodies !== undefined) {
      if (!validStoreValues.includes(obs.storeToolBodies as (typeof validStoreValues)[number]))
        throw new Error(`Invalid storeToolBodies: "${obs.storeToolBodies}"`);
      observability.storeToolBodies =
        obs.storeToolBodies as PersonalityObservabilityConfig['storeToolBodies'];
    }
    if (obs.storeLlmPayloads !== undefined) {
      if (!validLlmValues.includes(obs.storeLlmPayloads as (typeof validLlmValues)[number]))
        throw new Error(`Invalid storeLlmPayloads: "${obs.storeLlmPayloads}"`);
      observability.storeLlmPayloads =
        obs.storeLlmPayloads as PersonalityObservabilityConfig['storeLlmPayloads'];
    }
    if (Array.isArray(obs.redactPatterns)) {
      for (const p of obs.redactPatterns) {
        if (typeof p !== 'string') throw new Error('redactPatterns entries must be strings');
      }
      observability.redactPatterns = obs.redactPatterns as string[];
    }
    if (obs.exportTraces !== undefined) {
      // Same posture as the store values above: a malformed value on a safety
      // field throws at load rather than silently defaulting to "exported".
      const exportTraces = nestedBool(obs.exportTraces);
      if (exportTraces === undefined)
        throw new Error(`Invalid exportTraces: "${obs.exportTraces}". Expected true or false`);
      observability.exportTraces = exportTraces;
    }
    result.observability = observability;
  }

  // Ch.4b — approvalMode parsing
  if (raw.approvalMode !== undefined) {
    const mode = raw.approvalMode;
    if (mode !== 'manual' && mode !== 'smart' && mode !== 'off') {
      throw new Error(`Invalid approvalMode: "${mode}". Expected one of: manual, smart, off`);
    }
    result.approvalMode = mode;
  }

  // Ch.4b — denyRules parsing. Same posture as approvalMode above: a malformed
  // value throws at load rather than being dropped, because a safety field that
  // silently accepts garbage reads as protection while gating nothing.
  //
  // Empty and whitespace-only entries are rejected because of how
  // `matchDenyRule` (packages/core/src/agent-loop/deny-rules.ts) matches: a rule is
  // a substring of `${toolName} ${canonical-json-args}`, guarded by
  // `rule.length > 0`. So `""` can never match (a silent no-op rule) and `" "`
  // matches every call (the subject always contains a space). Both are config
  // mistakes worth catching at load.
  if (raw.denyRules !== undefined) {
    const rules = raw.denyRules;
    if (!Array.isArray(rules)) {
      throw new Error(
        `Invalid denyRules: ${JSON.stringify(rules)}. Expected a list of match strings`,
      );
    }
    const denyRules: string[] = [];
    for (const rule of rules) {
      if (typeof rule !== 'string') {
        throw new Error(
          `Invalid denyRules entry: ${JSON.stringify(rule)}. Every entry must be a string`,
        );
      }
      if (rule.trim() === '') {
        throw new Error('Invalid denyRules entry: empty rule. Every entry must be non-empty');
      }
      denyRules.push(rule);
    }
    result.denyRules = denyRules;
  }

  const asp = raw.allowed_skill_permissions as Record<string, unknown> | undefined;
  if (asp) {
    const out: NonNullable<PersonalitySafetyConfig['allowed_skill_permissions']> = {};
    for (const cat of ['fs_read', 'fs_write', 'network', 'mcp_env_passthrough'] as const) {
      const v = nestedListOrBool(asp[cat]);
      if (v !== undefined) out[cat] = v;
    }
    if (Object.keys(out).length > 0) result.allowed_skill_permissions = out;
  }

  const net = raw.network as Record<string, unknown> | undefined;
  if (net) {
    const out: NonNullable<PersonalitySafetyConfig['network']> = {};
    if (Array.isArray(net.allow)) out.allow = net.allow.map(String);
    if (Array.isArray(net.deny)) out.deny = net.deny.map(String);
    const priv = nestedBool(net.allow_private_urls);
    if (priv !== undefined) out.allow_private_urls = priv;
    if (Object.keys(out).length > 0) result.network = out;
  }

  const inj = raw.injectionDefense as Record<string, unknown> | undefined;
  if (inj) {
    const out: NonNullable<PersonalitySafetyConfig['injectionDefense']> = {};
    const classifier = inj.classifier as Record<string, unknown> | undefined;
    if (classifier) {
      const alwaysCallLLM = nestedBool(classifier.alwaysCallLLM);
      if (alwaysCallLLM !== undefined) out.classifier = { alwaysCallLLM };
    }
    const prd = inj.postReadDowngrade as Record<string, unknown> | undefined;
    if (prd) {
      const downgrade: NonNullable<
        NonNullable<PersonalitySafetyConfig['injectionDefense']>['postReadDowngrade']
      > = {};
      const dEnabled = nestedBool(prd.enabled);
      if (dEnabled !== undefined) downgrade.enabled = dEnabled;
      const turns = nestedInt(prd.turns);
      if (turns !== undefined) downgrade.turns = turns;
      if (prd.tools === 'auto') downgrade.tools = 'auto';
      else if (Array.isArray(prd.tools)) downgrade.tools = prd.tools.map(String);
      if (Object.keys(downgrade).length > 0) out.postReadDowngrade = downgrade;
    }
    const blockSecretResults = nestedBool(inj.blockSecretResults);
    if (blockSecretResults !== undefined) out.blockSecretResults = blockSecretResults;
    const toolResultDelimiters = nestedBool(inj.toolResultDelimiters);
    if (toolResultDelimiters !== undefined) out.toolResultDelimiters = toolResultDelimiters;
    if (Object.keys(out).length > 0) result.injectionDefense = out;
  }

  const pii = raw.piiRedaction as Record<string, unknown> | undefined;
  if (pii) {
    const enabled = nestedBool(pii.enabled);
    if (enabled !== undefined) {
      const out: NonNullable<PersonalitySafetyConfig['piiRedaction']> = { enabled };
      if (Array.isArray(pii.extraPatterns)) out.extraPatterns = pii.extraPatterns.map(String);
      result.piiRedaction = out;
    }
  }
  return result;
}

/** Coerce a nested-block scalar to a boolean. Returns undefined when the value
 *  is absent or not a recognized boolean string. */
function nestedBool(v: unknown): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** Coerce a nested-block scalar to an integer, or undefined when not numeric. */
function nestedInt(v: unknown): number | undefined {
  return typeof v === 'string' && /^\d+$/.test(v) ? Number.parseInt(v, 10) : undefined;
}

/** A skill-permission category is either a string list or a boolean toggle. */
function nestedListOrBool(v: unknown): string[] | boolean | undefined {
  if (Array.isArray(v)) return v.map(String);
  return nestedBool(v);
}

// Ch.4b — load-time refusal of unsafe combinations (v1 floor).
//
// `approvalMode: off` paired with a channel-ingress platform is the
// catastrophic combination — a stranger or allowlisted remote user
// can drive auto-approved destructive actions. We refuse it at config
// load.
//
// **v1 limitation.** This check matches a hardcoded set of platform
// strings on `personality.platform`. A new channel adapter or a
// multi-channel binding wired solely at the gateway layer will not be
// caught here. The plan-tracked v2 lifts this check up to the wiring
// layer (which knows which surfaces actually bind the personality)
// and replaces the string match with a typed "ingress capability"
// flag. Until then, every channel-adapter package adding a new
// platform name is responsible for adding it to the set below — the
// alternative (silent bypass) is the worse failure mode.
const CHANNEL_INGRESS_PLATFORMS: ReadonlySet<string> = new Set([
  'telegram',
  'discord',
  'slack',
  'whatsapp',
  'email',
]);

export function validateUnsafeCombinations(id: string, config: PersonalityConfig): void {
  const mode = config.safety?.approvalMode;
  if (mode === 'off' && config.platform && CHANNEL_INGRESS_PLATFORMS.has(config.platform)) {
    throw new Error(
      `personality "${id}" has approvalMode: off but is bound to channel "${config.platform}".\n` +
        '       Remote senders + auto-approve = remote-driven destructive actions.\n' +
        "       Either: (a) move approvalMode to 'smart' or 'manual', or\n" +
        '               (b) remove channel bindings from this personality (cli/cron only).\n' +
        '       This combination is not configurable; it is rejected at config load.',
    );
  }
}
