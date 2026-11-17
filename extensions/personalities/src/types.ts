import type { PersonalityConfig } from '@ethosagent/types';

export interface PersonalityToolsConfig {
  /**
   * `recency` is a default `max_age` for `web_search` (and the site tools that
   * share this binding) — a duration string like `30d`, `6m`, `1y`.
   */
  web_search?: { provider?: 'exa' | 'tavily' | 'brave'; secret?: string; recency?: string };
  /** One provider (xAI) — the name resolves to `providers/xai/<name>`. */
  x_search?: { secret?: string };
  /**
   * One secret NAME per answer engine, keyed by engine id — `chatgpt` resolves
   * to `providers/openai/<name>`, `perplexity` to `providers/perplexity/<name>`.
   * `secret` is the permanent legacy alias for `chatgpt` and nothing else
   * (`selectSecretRef` in `@ethosagent/tools-answer-engines` maps it; plan
   * engine-ask-per-engine-bindings D2). Stored as a field map, the same
   * `key → { field → name }` shape every other secret-only key has.
   */
  engine_ask?: { secret?: string; [engineId: string]: string | undefined };
  /**
   * One provider (Google) — the name resolves to `providers/google/<name>`.
   * Shared by both `youtube_search` and `youtube_comments`: same API, same
   * project, same daily quota pool.
   */
  youtube?: { secret?: string };
  /**
   * One provider (a Google service account) — the name resolves to
   * `providers/google-search-console/<name>`. Shared by both `gsc_sites` and
   * `gsc_queries`: one credential, one grant, one Cloud project. A separate
   * namespace from `youtube` above, which is an API key, not an RSA identity.
   */
  search_console?: { secret?: string };
  /**
   * Any other binding key: a secret NAME and nothing else. `parseToolsYaml`
   * PRESERVES a key none of the typed fields above claims rather than dropping
   * it, so a `tools.yaml` written by a newer build — or by a plugin's tool —
   * survives a read-modify-write by an older one.
   *
   * This package sits in the Extensions layer (ARCHITECTURE.md §II) and cannot
   * see the tool registry, so it cannot tell an unclaimed key from one this
   * build simply does not know about. The boundary that CAN is where the
   * refusal lives: `ToolSettingsService.setDefault` / `setForPersonality`
   * (apps/web-api) throws on a key no registered tool claims.
   */
  [key: string]:
    | { provider?: string; secret?: string; recency?: string; [field: string]: string | undefined }
    | undefined;
}

export interface DescribedPersonality {
  config: PersonalityConfig;
  /** True if the personality is loaded from the package's bundled data dir
   *  (read-only); false if it lives under the user's writable
   *  `<userPersonalitiesDir>/<id>/`. */
  builtin: boolean;
  /** Per-personality MCP tool policy loaded from mcp.yaml (NOT part of the
   *  frozen PersonalityConfig schema). Undefined when the personality has no
   *  mcp.yaml file. */
  mcpPolicy?: import('@ethosagent/types').McpPolicy;
  /** Warnings from parsing mcp.yaml — present when the file contained
   *  structural problems that caused policy to be silently dropped (e.g.
   *  tab indentation, unknown keys, bad indent). Empty array omitted. */
  mcpWarnings?: string[];
  /** Warnings from parsing config.yaml — a value the loader dropped rather
   *  than failing the load (today: an invalid `display.emoji`, see
   *  `buildDisplayConfig`). Empty array omitted. */
  configWarnings?: string[];
}

export interface CreatePersonalityInput {
  id: string;
  name: string;
  description?: string;
  model?: string | import('@ethosagent/types').ModelTierConfig;
  toolset: string[];
  soulMd: string;
  provider?: string;
  capabilities?: string[];
  mcp_servers?: string[];
  plugins?: string[];
  fs_reach?: { read?: string[]; write?: string[]; workdir?: string | string[] };
  skill_evolution?: {
    enabled?: boolean;
    min_tool_calls?: number;
    cooldown_minutes?: number;
    model?: string;
    evolve_existing?: boolean;
    promotion?: 'review' | 'auto';
    scope?: 'personality' | 'shared';
  };
  dreaming?: import('@ethosagent/types').DreamingConfig;
  evolution_approval_mode?: 'auto' | 'user';
  nightly?: import('@ethosagent/types').PersonalityConfig['nightly'];
  /** How this personality sounds, listens, and looks on a call. `tts_provider` /
   *  `stt_provider` / `realtime_provider` name entries in the deployment's
   *  `voice.tts.providers.*` / `voice.stt.providers.*` /
   *  `voice.realtime.providers.*` rosters; `tts_voice` is the TTS provider's
   *  voice id; `call_style` is the Call Stage treatment. Empty strings are
   *  dropped, so an editor can send blanks for "unset". */
  voice?: EditableVoiceConfig;
  /**
   * Per-personality safety policy at CREATE time — `network` only.
   *
   * `PersonalityConfig.safety` carries more (approvalMode, denyRules,
   * injectionDefense, …); those are edited afterwards through `update`, which
   * merges onto whatever is already on disk. Network reach is different: it is
   * set in the FIRST write so a narrowed personality is never briefly open — a
   * personality with no `safety.network` gets the open public internet under
   * the `safeFetch` floor (`resolveCapabilities`,
   * `packages/core/src/capability-resolver.ts`).
   *
   * Narrowing only, per ARCHITECTURE.md §V S6 — the non-overridable floor
   * (cloud-metadata + private ranges blocked, http/https only) is applied
   * beneath whatever is declared here.
   */
  safety?: Pick<NonNullable<PersonalityConfig['safety']>, 'network'>;
}

/**
 * The sub-keys of `PersonalityVoiceConfig` an editor may write.
 *
 * Every sub-key of the frozen `voice` block is here — the block is what a
 * personality declares about how it sounds, and a sub-key only config.yaml can
 * reach is a sub-key the editor silently erases on the next save.
 */
export interface EditableVoiceConfig {
  tts_provider?: string;
  stt_provider?: string;
  realtime_provider?: string;
  tts_voice?: string;
  /** How the Call Stage draws this personality. `''` clears it. */
  call_style?: import('@ethosagent/types').CallTreatment | '';
  /** Which voice stack serves this personality. `''` clears it. */
  tier?: 'pipeline' | 'realtime' | '';
  /** Fast-lane model for spoken turns. `''` clears it. */
  model?: string;
  /** BCP-47 tag → voice id. REPLACES the stored map; `{}` clears it. */
  languages?: Record<string, string>;
}

export interface UpdatePersonalityPatch {
  /**
   * Only `skills.global_ingest.allow` is patchable here (the catalog skill
   * grant, unified-catalog `catalog.setSkillGrant`). It REPLACES the allow
   * list and leaves every other `skills` sub-key (mode, deny, tags, ...) as
   * stored. Each entry must be a plain qualified name (`catalog/<id>`): the
   * list is rendered comma-joined onto one config.yaml line.
   */
  skills?: { global_ingest?: { allow?: string[] } };
  name?: string;
  description?: string;
  model?: string | import('@ethosagent/types').ModelTierConfig;
  toolset?: string[];
  soulMd?: string;
  mcp_servers?: string[];
  plugins?: string[];
  capabilities?: string[];
  provider?: string;
  fs_reach?: { read?: string[]; write?: string[]; workdir?: string | string[] };
  /** Partial dreaming config — shallow-merged onto the existing dreaming block
   *  so a patch that carries only `enable` (or only a cadence number) never
   *  drops sibling fields. */
  dreaming?: Partial<import('@ethosagent/types').DreamingConfig>;
  /** Enable-only dreaming toggle. Merges `enable` into the existing dreaming
   *  cadence (idleMinutes / maxPerDay), defaulting cadence when none exists.
   *  Used by the web editor's toggle so flipping it never resets cadence. */
  dreamingEnable?: boolean;
  /** Governed-learning approval dial. 'auto' applies evolved Expression
   *  automatically; 'user' holds it for human approval. */
  evolution_approval_mode?: 'auto' | 'user';
  /** Skill-evolution tuning — shallow-merged onto the existing config so a
   *  patch to one knob (e.g. `model`) never drops sibling fields. */
  skill_evolution?: import('@ethosagent/types').PersonalityConfig['skill_evolution'];
  /** Per-personality safety config (e.g. approval mode). Merged onto the
   *  existing safety block so a partial patch never drops sibling fields. */
  safety?: import('@ethosagent/types').PersonalityConfig['safety'];
  /** Per-personality memory backend. Merged onto the existing memory block so
   *  a provider patch never drops `options`. */
  memory?: import('@ethosagent/types').PersonalityConfig['memory'];
  /** Nightly governed-learning gates. The UI sends the FULL nightly object
   *  (incl. the full judge sub-object), so a one-level shallow merge onto the
   *  existing block is correct — `judge` is replaced wholesale, not deep-merged. */
  nightly?: import('@ethosagent/types').PersonalityConfig['nightly'];
  /** Voice sub-keys, shallow-merged onto the stored `voice` block so a patch
   *  carrying only `tts_voice` leaves a hand-written `languages` map alone.
   *  `''` CLEARS that sub-key — the same convention `fs_reach.workdir` uses,
   *  and the only way the editor can express "back to the default provider". */
  voice?: EditableVoiceConfig;
  /** Sub-keys of the `display` identity block, merged by `mergeDisplayConfig`.
   *  `''` clears a sub-key — the same convention as `voice.*` /
   *  `fs_reach.workdir`. `avatar_url` is written by `writeAvatar`/
   *  `deleteAvatar` below (there is no raw-URL-paste flow in v1); `emoji` must
   *  pass `isSingleEmojiGrapheme` or `update()` refuses the patch. */
  display?: { avatar_url?: string; emoji?: string };
  /** `mcp_export.*` sub-keys, shallow-merged onto the stored declaration like
   *  `safety` / `memory` / `nightly`, so `{ enabled: false }` withdraws the
   *  export and keeps `expose_tools` / `expose_memory` / `expose_sessions` /
   *  `auth` for when it is turned back on. `enabled` falls back to the stored
   *  value, then to `false` — a patch never turns export ON by omission. */
  mcp_export?: Partial<import('@ethosagent/types').PersonalityMcpExportConfig>;
  /** `decisions.*` sub-keys, merged by `mergeDecisionsConfig`: `sites` is
   *  shallow-merged per site, so a patch naming one site leaves the others;
   *  `provider: ''` clears the reference (the `voice.*` convention). */
  decisions?: {
    provider?: string;
    sites?: Partial<
      Record<
        import('@ethosagent/types').PersonalityDecisionSiteId,
        import('@ethosagent/types').PersonalityDecisionSiteMode
      >
    >;
  };
}

/** One personality directory whose load failed (N3, ux-feedback-and-config-
 *  clarity). The registry keeps serving the last-good copy: `define()` runs
 *  only after a successful parse, so a broken edit never evicts the config
 *  already in the `personalities` map. */
export interface PersonalityLoadFailure {
  id: string;
  dir: string;
  /** Human-readable cause, prefixed with the source file where the parse
   *  names one (e.g. `config.yaml: …` — see `withSourceFile`). */
  error: string;
}

/** Outcome of the most recent `loadFromDirectory` call. */
export interface PersonalityLoadReport {
  failures: PersonalityLoadFailure[];
  /** Personalities whose mtime fingerprint changed on this call — a reload of
   *  something already registered, with the changed inputs named (basenames
   *  of the six fingerprinted paths, e.g. `SOUL.md`). First sights are not
   *  listed. */
  reloaded: Array<{ id: string; changed: string[] }>;
  /** config.yaml values dropped with a warning on this call (a personality
   *  that loaded, minus the bad value — see `DescribedPersonality.configWarnings`).
   *  Same once-per-content-change cadence as `reloaded`. Omitted when none. */
  warnings?: Array<{ id: string; warning: string }>;
}

/** The definition files `FilePersonalityRegistry.writeDefinitionBytes` may
 *  replace (plan personality-memory-boundary G2, prereq C). */
export type DefinitionBytesFile = 'toolset.yaml' | 'config.yaml';
