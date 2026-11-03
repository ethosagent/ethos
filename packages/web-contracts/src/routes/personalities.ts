// The ONE runtime import from `@ethosagent/types` this contract takes: the
// voice-mode list is a closed enum every layer names (the decision function in
// voice-text, `LaneVoiceModeStore` in core, the gateway's `/voice` command, and
// the chat header), and a second spelling here is exactly the drift the shared
// constant exists to prevent. `@ethosagent/types` is zero-dep, so importing it
// costs the published contract nothing.
import { isSingleEmojiGrapheme } from '@ethosagent/types';
import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  DecisionProviderIdSchema,
  DecisionSiteModeSchema,
  McpExportViewSchema,
  McpPolicySchema,
  ModelTierConfigSchema,
  PersonalitySchema,
  PersonalitySkillSchema,
  ProviderIdSchema,
} from '../schemas';

// ---------------------------------------------------------------------------
// Personalities (v0 read-only — create/edit lands in v1)
// ---------------------------------------------------------------------------

const PersonalityListInput = z.object({
  /** Page size. */
  limit: z.number().int().positive().optional(),
  /** Opaque cursor from the previous response's `nextCursor`. */
  cursor: z.string().optional(),
});
const PersonalityListOutput = z.object({
  items: z.array(PersonalitySchema),
  nextCursor: z.string().nullable(),
  defaultId: z.string(),
});
const PersonalityGetInput = z.object({ id: z.string() });
const PersonalityGetOutput = z.object({
  personality: PersonalitySchema,
  /** Markdown body of SOUL.md. Empty string when the file isn't present. */
  soulMd: z.string(),
  /** Per-personality MCP tool policy from `mcp.yaml`. Null when the
   *  personality has no `mcp.yaml`. A server with no `tools` entry means
   *  "all tools allowed" (default-allow). */
  mcpPolicy: McpPolicySchema.nullable(),
});

const PersonalityCharacterSheetInput = z.object({ id: z.string() });

// Structured execution posture (Phase 2a, lane E1). Mirrors the
// `ExecutionPosture` / `DockerAbsentDecision` contracts in
// `@ethosagent/types`; the web Execution UI consumes this directly rather than
// re-computing posture from the toolset (single source of truth = the resolver
// behind `buildExecutionPosture`).
const DockerAbsentSchema = z.object({
  blocked: z.literal(true),
  canInstall: z.literal(true),
  canConsentLocal: z.boolean(),
  consentForbiddenReason: z.string().optional(),
});
const ExecutionPostureSchema = z.object({
  backend: z.enum(['docker', 'local', 'ssh', 'none']),
  /**
   * What the PERSONALITY required (`execution:` in its `config.yaml`), absent
   * when it required nothing. Carried BESIDE `backend` because `ExecutionPosture`
   * in `@ethosagent/types` says a surface must be able to show both — what was
   * asked for and what this machine provides. Without it a `backend: 'none'`
   * that declared `execution: none` is indistinguishable from one that simply
   * has no exec-bearing tool, which are different facts about the personality;
   * `postureWhy` in `apps/web/src/lib/execution-posture.ts` reads this to tell
   * them apart, the same split `character-sheet.ts` makes for the CLI sheet.
   */
  requirement: z.enum(['remote', 'none']).optional(),
  networkMode: z.enum(['none', 'bridge']),
  memoryMb: z.number(),
  containerized: z.boolean(),
  mounts: z.array(
    z.object({
      hostPath: z.string(),
      containerPath: z.string(),
      mode: z.enum(['ro', 'rw']),
    }),
  ),
  scratchPaths: z.array(z.string()),
  dockerAbsent: DockerAbsentSchema.optional(),
  /**
   * Honest host fallback (Phase 2a F1) — the requested sandbox or remote
   * backend could not run and the constitution permitted `local`, so `backend`
   * says `local` and this says why. Without it the UI cannot tell an intended
   * host posture from a demoted one.
   */
  hostFallback: z
    .object({
      reason: z.enum(['docker-disabled', 'docker-unavailable', 'ssh-unavailable']),
    })
    .optional(),
  /**
   * The remote target, ALREADY FORMATTED by the resolver — display only, the
   * resolver never dials it. It prints exactly what the operator configured, so
   * a host with no explicit port renders `build-01` and never `build-01:22`.
   * Nothing downstream may default a port back in.
   */
  sshTarget: z.string().optional(),
  /** The digest-pinned image a `docker` posture runs in (`execution.docker.image`). */
  dockerImage: z.string().optional(),
  /**
   * A `docker` posture with no `execution.docker.image`: every exec tool
   * refuses. `message` is the refusal's own wording — render it verbatim.
   */
  dockerImageMissing: z.object({ message: z.string() }).optional(),
  /**
   * Why an `ssh` posture will not reach its target. `message` is the canonical
   * wording — render it verbatim rather than composing a second explanation of
   * the same fact.
   */
  sshRefused: z
    .object({
      reason: z.enum(['unconfigured', 'constitution-requires-sandbox']),
      message: z.string(),
    })
    .optional(),
});
/** Wire shape of the resolved execution posture (Phase 2a, lane E1). */
export type ExecutionPostureWire = z.infer<typeof ExecutionPostureSchema>;
export type DockerAbsentWire = z.infer<typeof DockerAbsentSchema>;
const PersonalityCharacterSheetOutput = z.object({
  /** Generated Markdown character sheet — the same artifact `ethos personality
   *  show` prints. Regenerated on each call; see `renderCharacterSheet` in
   *  @ethosagent/personalities. */
  markdown: z.string(),
  /** Resolved execution posture (Phase 2a, lane E1). Null when the server has
   *  no data directory wired and therefore cannot resolve the posture. */
  posture: ExecutionPostureSchema.nullable(),
  /** The sheet's `## Prompt size` numbers, structured for the Personalities
   *  tab: the measured static prompt prefix (chars/4, serialized tool schemas
   *  and project context included) and the AGENTS.md/CLAUDE.md project-context
   *  term measured in the personality's declared `fs_reach` workdir —
   *  `workdir: null` when it declares none, so the term depends on the
   *  directory the agent runs in. Null when the server could not measure (no
   *  tool registry wired); `projectContext` null when it was not measured.
   *  Optional so a server predating the field still parses. */
  promptSize: z
    .object({
      staticPrefixTokens: z.number(),
      projectContext: z.object({ workdir: z.string().nullable(), tokens: z.number() }).nullable(),
    })
    .nullable()
    .optional(),
});

const PersonalityIdRegex = /^[a-z0-9_-]+$/;

/** Nightly governed-learning gates. Defaults reproduce today's behavior
 *  (pass + judge + expression all run). Shared by create + update. */
const PersonalityNightlyInput = z
  .object({
    enabled: z.boolean().optional(),
    judge: z
      .object({
        enabled: z.boolean().optional(),
        minInteractions: z.number().int().min(1).optional(),
      })
      .optional(),
    expression: z.boolean().optional(),
  })
  .optional();

/**
 * A `voice.languages.<tag>` key. The tag is written into config.yaml as part of
 * a dotted key, so the charset is BCP-47's own (letters, digits, hyphen) and
 * nothing else — a tag carrying a separator or a newline would serialize into
 * lines the loader never meant to read.
 */
const VoiceLanguageTagSchema = z.string().regex(/^[A-Za-z0-9-]+$/);

/**
 * The editable slice of a personality's `voice` block — how it sounds and what
 * it listens through.
 *
 * `tts_provider` / `stt_provider` / `realtime_provider` name entries in the
 * deployment's `voice.tts.providers.*` / `voice.stt.providers.*` /
 * `voice.realtime.providers.*` rosters (LABELS, never credentials); `tts_voice`
 * is the TTS provider's voice id. `''` clears the key, so "Default" is
 * expressible.
 *
 * `call_style` is how the personality LOOKS on a call — the visual sibling of
 * `tts_voice`, and editable for the same reason. `''` clears it, which hands
 * the choice back to `display.call_style` and then to the id derivation.
 *
 * `tier` picks which voice stack serves this personality, `model` names its
 * fast-lane model, and `languages` maps a BCP-47 tag to the voice that speaks
 * it. All three are existing sub-keys of the frozen `voice` block — no new
 * top-level `PersonalityConfig` field is introduced by exposing them.
 *
 * `languages` REPLACES the stored map (an empty object clears it), unlike the
 * scalars beside it, because a per-key merge would leave no way to delete a tag.
 */
const PersonalityVoiceInput = z
  .object({
    tts_provider: z.string().optional(),
    stt_provider: z.string().optional(),
    realtime_provider: z.string().optional(),
    tts_voice: z.string().optional(),
    call_style: z.enum(['liquid', 'orb', 'rings', '']).optional(),
    tier: z.enum(['pipeline', 'realtime', '']).optional(),
    model: z.string().optional(),
    languages: z.record(VoiceLanguageTagSchema, z.string().min(1)).optional(),
  })
  .optional();

/**
 * `decisions.*` on a personality (plan decision-provider-personality §9) — the
 * `voice` semantics: `sites` is merged per site onto the stored block
 * (`mergeDecisionsConfig`, extensions/personalities), so a patch naming one
 * site keeps the others; `provider: ''` clears the reference. `provider` must
 * name a catalog id: the editor only offers ones the operator added, and a
 * typo here would load as a silent `off` (PD3). Both objects are strict, so an
 * unknown site key is refused rather than stripped.
 */
const PersonalityDecisionsInput = z
  .object({
    provider: DecisionProviderIdSchema.or(z.literal('')).optional(),
    sites: z
      .object({
        injection: DecisionSiteModeSchema.optional(),
        approver: DecisionSiteModeSchema.optional(),
        router: DecisionSiteModeSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const PersonalityCreateInput = z.object({
  /** Lowercase id; becomes the directory name. */
  id: z.string().min(1).regex(PersonalityIdRegex),
  name: z.string().min(1),
  description: z.string().optional(),
  model: z.union([z.string(), ModelTierConfigSchema]).optional(),
  toolset: z.array(z.string()),
  /** Markdown body of SOUL.md. May be empty. */
  soulMd: z.string(),
  provider: ProviderIdSchema.or(z.literal('')).optional(),
  capabilities: z.array(z.string()).optional(),
  mcp_servers: z.array(z.string()).optional(),
  plugins: z.array(z.string()).optional(),
  fs_reach: z
    .object({
      read: z.array(z.string()).optional(),
      write: z.array(z.string()).optional(),
      /** Declared working director(ies). Tokens (`${ETHOS_HOME}`, `${self}`,
       *  `${CWD}`) are stored verbatim and resolved at turn setup. A list
       *  declares several Documents roots; a bare string is one. */
      workdir: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .optional(),
  skill_evolution: z
    .object({
      enabled: z.boolean().optional(),
      min_tool_calls: z.number().int().min(1).max(20).optional(),
      cooldown_minutes: z.number().int().min(0).optional(),
      evolve_existing: z.boolean().optional(),
      promotion: z.enum(['review', 'auto']).optional(),
      scope: z.enum(['personality', 'shared']).optional(),
    })
    .optional(),
  /** Governed-learning approval dial. 'auto' applies evolved Expression
   *  automatically; 'user' holds it for human approval. */
  evolution_approval_mode: z.enum(['auto', 'user']).optional(),
  nightly: PersonalityNightlyInput,
  voice: PersonalityVoiceInput,
  /**
   * Per-personality network reach (Ch.7). Not a frozen-schema addition —
   * `safety.network` already exists on `PersonalityConfig`; this exposes it on
   * the create path, which had no way to express a network policy at all.
   *
   * It has to be settable in the FIRST write: a personality with no
   * `safety.network` resolves every `allowedHosts: ['*']` tool to an EMPTY host
   * set (`packages/core/src/capability-resolver.ts`), so `web_extract` denies
   * every host until someone edits config.yaml by hand.
   *
   * Narrowing only (ARCHITECTURE.md §V S6). Whatever is listed here sits UNDER
   * the non-overridable floor: cloud-metadata and private/RFC1918 ranges stay
   * blocked, and only http/https schemes are permitted.
   */
  safety: z
    .object({
      network: z
        .object({
          allow: z.array(z.string()).optional(),
          deny: z.array(z.string()).optional(),
          allow_private_urls: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});
const PersonalityCreateOutput = z.object({ personality: PersonalitySchema });

/** One `mcp_export.expose_tools` entry. Written verbatim onto one space-joined
 *  config.yaml line, so whitespace, quotes and newlines are refused here and
 *  again by the registry (`MCP_EXPORT_TOOL_NAME`, extensions/personalities). */
const McpExportToolNameInput = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/);

/** Every sub-key optional: the registry shallow-merges this onto the stored
 *  declaration, so `{ enabled: false }` turns export off and keeps the rest. */
const PersonalityMcpExportPatchInput = z.object({
  enabled: z.boolean().optional(),
  /** `'all'` is the personality's full reach, `'none'` conversation only; a
   *  list must name at least one tool. */
  expose_tools: z
    .union([z.literal('all'), z.literal('none'), z.array(McpExportToolNameInput).min(1).max(512)])
    .optional(),
  expose_memory: z.enum(['none', 'scoped', 'full']).optional(),
  expose_sessions: z.boolean().optional(),
  auth: z.enum(['localhost', 'bearer']).optional(),
});

const PersonalityUpdateInput = z.object({
  id: z.string().min(1),
  /** Patch — only present fields are written. */
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.union([z.string(), ModelTierConfigSchema]).optional(),
  toolset: z.array(z.string()).optional(),
  soulMd: z.string().optional(),
  mcp_servers: z.array(z.string()).optional(),
  /** Per-server MCP tool subsets, written to `mcp.yaml`. Maps a server name
   *  to the BARE tool names that server may expose. Only include a server
   *  here when it is a STRICT subset — a server with every tool selected
   *  should be omitted (that records "all tools allowed"). Servers attached
   *  via `mcp_servers` but absent here have any prior `tools` entry cleared.
   *  Ignored unless `mcp_servers` is also present. */
  mcp_tools: z.record(z.string(), z.array(z.string())).optional(),
  plugins: z.array(z.string()).optional(),
  capabilities: z.array(z.string()).optional(),
  provider: ProviderIdSchema.or(z.literal('')).optional(),
  /** Sub-keys are shallow-merged onto the stored block, so a patch carrying
   *  only `read`/`write` leaves an existing `workdir` in place. `''` (or an
   *  empty list) clears the workdir; a list declares several Documents roots. */
  fs_reach: z
    .object({
      read: z.array(z.string()).optional(),
      write: z.array(z.string()).optional(),
      workdir: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .optional(),
  /** Idle-time dreaming controls. `enable` toggles dreaming; idleMinutes /
   *  maxPerDay tune the cadence (kept at their persisted values when omitted). */
  dreaming: z
    .object({
      enable: z.boolean(),
      idleMinutes: z.number().int().min(0).optional(),
      maxPerDay: z.number().int().min(0).optional(),
    })
    .optional(),
  /** Governed-learning approval dial. 'auto' applies evolved Expression
   *  automatically; 'user' holds it for human approval. */
  evolution_approval_mode: z.enum(['auto', 'user']).optional(),
  /** Skill-evolution tuning. Retunable after creation. */
  skill_evolution: z
    .object({
      enabled: z.boolean().optional(),
      min_tool_calls: z.number().int().min(1).max(20).optional(),
      cooldown_minutes: z.number().int().min(0).optional(),
      model: z.string().optional(),
      evolve_existing: z.boolean().optional(),
      promotion: z.enum(['review', 'auto']).optional(),
      scope: z.enum(['personality', 'shared']).optional(),
    })
    .optional(),
  /** Per-personality safety dial. `approvalMode` and `network` are editable
   *  from the web; sibling safety fields are preserved by the registry merge.
   *
   *  `network` is narrowing only (ARCHITECTURE.md §V S6) — whatever is listed
   *  sits UNDER the non-overridable floor, and `allow` is intersected with each
   *  tool's own declared hosts. A `network` object with no lists clears the
   *  policy back to none. */
  safety: z
    .object({
      approvalMode: z.enum(['manual', 'smart', 'off']).optional(),
      network: z
        .object({
          allow: z.array(z.string()).optional(),
          deny: z.array(z.string()).optional(),
          allow_private_urls: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  /** Per-personality memory backend. Built-ins: 'markdown', 'vector'. */
  memory: z.object({ provider: z.string().optional() }).optional(),
  /** Sub-keys of the `display` identity block; `''` clears one back to unset.
   *  `avatar_url`: the avatar upload/delete routes are the usual way to change
   *  it, but a curated-icon pick goes through here directly (it's just a
   *  static URL, no bytes to upload). `emoji`: exactly one emoji grapheme
   *  (`isSingleEmojiGrapheme`), refused here with a 400 before the registry's
   *  own check in `FilePersonalityRegistry.update` would. */
  display: z
    .object({
      avatar_url: z.string().optional(),
      emoji: z
        .string()
        .refine((v) => v === '' || isSingleEmojiGrapheme(v), {
          message: "display.emoji must be exactly one emoji, or '' to clear it",
        })
        .optional(),
    })
    .optional(),
  /** Nightly governed-learning gates. The UI sends the FULL nightly object
   *  (including the full judge sub-object); the registry one-level-merges it. */
  nightly: PersonalityNightlyInput,
  /** Sub-keys are shallow-merged onto the stored `voice` block, so a patch
   *  carrying only `tts_voice` leaves a hand-written `languages` map alone.
   *  `''` clears that sub-key. */
  voice: PersonalityVoiceInput,
  /** `mcp_export.*` — see `PersonalityMcpExportPatchInput`. */
  mcp_export: PersonalityMcpExportPatchInput.optional(),
  /** `decisions.*` — see `PersonalityDecisionsInput`. */
  decisions: PersonalityDecisionsInput,
});
const PersonalityUpdateOutput = z.object({ personality: PersonalitySchema });

const PersonalityDeleteInput = z.object({ id: z.string().min(1) });
const PersonalityOkOutput = z.object({ ok: z.literal(true) });

const PersonalityDuplicateInput = z.object({
  id: z.string().min(1),
  newId: z.string().min(1).regex(PersonalityIdRegex),
});
const PersonalityDuplicateOutput = z.object({ personality: PersonalitySchema });

// Per-personality skills (gate 19).
const PersonalitySkillsListInput = z.object({ personalityId: z.string().min(1) });
const PersonalitySkillsListOutput = z.object({ skills: z.array(PersonalitySkillSchema) });

// Renderer capabilities (`ethos.renders`) declared by the personality's
// resolved skill set — `<renderer>@<spec-version>` entries a chat surface
// checks against its own curated registry before upgrading a fenced block
// from a code block. Empty array = code block, which is also the failure mode.
const PersonalityRenderersInput = z.object({ id: z.string().min(1) });
const PersonalityRenderersOutput = z.object({ renderers: z.array(z.string()) });

const PersonalitySkillsGetInput = z.object({
  personalityId: z.string().min(1),
  skillId: z.string().min(1),
});
const PersonalitySkillsGetOutput = z.object({ skill: PersonalitySkillSchema });

const PersonalitySkillsCreateInput = z.object({
  personalityId: z.string().min(1),
  skillId: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/),
  body: z.string(),
});
const PersonalitySkillsCreateOutput = z.object({ skill: PersonalitySkillSchema });

const PersonalitySkillsUpdateInput = z.object({
  personalityId: z.string().min(1),
  skillId: z.string().min(1),
  body: z.string(),
});
const PersonalitySkillsUpdateOutput = z.object({ skill: PersonalitySkillSchema });

const PersonalitySkillsDeleteInput = z.object({
  personalityId: z.string().min(1),
  skillId: z.string().min(1),
});

const PersonalitySkillsImportInput = z.object({
  personalityId: z.string().min(1),
  /** Global skill ids to copy from ~/.ethos/skills/<id>.md into the personality's skills/. */
  skillIds: z.array(z.string().min(1)),
});
const PersonalitySkillsImportOutput = z.object({ imported: z.array(PersonalitySkillSchema) });

// Pending skill-candidate review queue — a legacy adapter over the learning
// inbox (L-T8). Lists this personality's waiting skill candidates by the file
// each lands as; approve promotes one only when its replay passed (otherwise
// `INVALID_INPUT`, naming `ethos learning approve <id> --override`); reject marks
// it rejected.
const PersonalitySkillCandidateFileName = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_-]+\.md$/);
const PersonalitySkillCandidatesListInput = z.object({ personalityId: z.string().min(1) });
const PersonalitySkillCandidatesListOutput = z.object({
  candidates: z.array(z.object({ fileName: z.string(), content: z.string() })),
});
const PersonalitySkillCandidateActionInput = z.object({
  personalityId: z.string().min(1),
  fileName: PersonalitySkillCandidateFileName,
});
const PersonalitySkillCandidateApproveOutput = z.object({
  ok: z.literal(true),
  promotedTo: z.string(),
});

// Per-personality MCP bearer-token management (headless gap 4).
const PersonalityMcpSetTokenInput = z.object({
  personalityId: z.string().min(1),
  server: z.string().min(1),
  token: z.string().min(1),
});
const PersonalityMcpSetTokenOutput = z.object({ ok: z.literal(true) });

const PersonalityMcpDeleteTokenInput = z.object({
  personalityId: z.string().min(1),
  server: z.string().min(1),
});
const PersonalityMcpDeleteTokenOutput = z.object({ ok: z.literal(true) });

const LearningLogEntrySchema = z.object({
  revisionId: z.string(),
  at: z.string(),
  summary: z.string(),
  evidenceRef: z.string(),
  prevExpressionRef: z.string(),
});

const PersonalityJudgeSchema = z.object({
  alignmentScore: z.number(),
  signal: z.enum(['drift', 'underspecified_soul']).nullable(),
  lowStreak: z.number(),
  at: z.string().optional(),
  perDimension: z.array(z.object({ dimension: z.string(), score: z.number() })).optional(),
});

const PersonalityNightlySchema = z.object({
  windowEnd: z.string(),
  completed: z.array(z.string()),
});

const PersonalityLivingSoulInput = z.object({ id: z.string().min(1) });
const PersonalityLivingSoulOutput = z.object({
  core: z.string(),
  expression: z.string(),
  learningLog: z.array(LearningLogEntrySchema),
  /** Latest Personality-Judge alignment read from
   *  `.judge-history/state.json`. Omitted when no judge run is recorded. */
  judge: PersonalityJudgeSchema.optional(),
  /** Latest nightly-pass status read from `.nightly-state.json`. Omitted when
   *  no nightly pass has run (missing or malformed file). */
  nightly: PersonalityNightlySchema.optional(),
});

const PersonalityProposeExpressionInput = z.object({ id: z.string().min(1) });
const PersonalityProposeExpressionOutput = z.object({
  currentExpression: z.string(),
  newExpression: z.string(),
  rationale: z.string(),
  evidence: z.string(),
});

const PersonalityApplyExpressionInput = z.object({
  id: z.string().min(1),
  newExpression: z.string(),
  summary: z.string(),
  evidenceRef: z.string(),
  /**
   * Apply is an approval of a learning candidate that has not been replayed,
   * so it needs a human reason (plan `trust-before-reach.md` Design §6). Absent
   * → `OVERRIDE_REQUIRED`, the learning inbox's refusal code, mapped by
   * `learningRpcError` (`apps/web-api/src/rpc/learning.ts`) like every other
   * refusal (`STALE`, …). `summary` is the drafter's text and does not count.
   */
  overrideReason: z.string().trim().min(1).optional(),
});
const PersonalityApplyExpressionOutput = z.object({ revisionId: z.string() });

const PersonalityRevertExpressionInput = z.object({ id: z.string().min(1) });
const PersonalityRevertExpressionOutput = z.object({
  ok: z.literal(true),
  revertedTo: z.string(),
});

// M-T9 — the MCP export section. A read: mapped to `personalities:read`, so the
// output carries no secret (see `McpExportViewSchema`).
const PersonalityMcpExportInput = z.object({ id: z.string().min(1) });

const PersonalityProposeSoulSplitInput = z.object({ soulMd: z.string() });
const PersonalityProposeSoulSplitOutput = z.object({
  core: z.string(),
  expression: z.string(),
  rationale: z.string(),
});

/** @stable v1 */
export const personalities = {
  list: oc.input(PersonalityListInput).output(PersonalityListOutput),
  get: oc.input(PersonalityGetInput).output(PersonalityGetOutput),
  characterSheet: oc.input(PersonalityCharacterSheetInput).output(PersonalityCharacterSheetOutput),
  create: oc.input(PersonalityCreateInput).output(PersonalityCreateOutput),
  update: oc.input(PersonalityUpdateInput).output(PersonalityUpdateOutput),
  delete: oc.input(PersonalityDeleteInput).output(PersonalityOkOutput),
  duplicate: oc.input(PersonalityDuplicateInput).output(PersonalityDuplicateOutput),
  renderers: oc.input(PersonalityRenderersInput).output(PersonalityRenderersOutput),
  skillsList: oc.input(PersonalitySkillsListInput).output(PersonalitySkillsListOutput),
  skillsGet: oc.input(PersonalitySkillsGetInput).output(PersonalitySkillsGetOutput),
  skillsCreate: oc.input(PersonalitySkillsCreateInput).output(PersonalitySkillsCreateOutput),
  skillsUpdate: oc.input(PersonalitySkillsUpdateInput).output(PersonalitySkillsUpdateOutput),
  skillsDelete: oc.input(PersonalitySkillsDeleteInput).output(PersonalityOkOutput),
  skillsImportGlobal: oc.input(PersonalitySkillsImportInput).output(PersonalitySkillsImportOutput),
  skillCandidatesList: oc
    .input(PersonalitySkillCandidatesListInput)
    .output(PersonalitySkillCandidatesListOutput),
  skillCandidateApprove: oc
    .input(PersonalitySkillCandidateActionInput)
    .output(PersonalitySkillCandidateApproveOutput),
  skillCandidateReject: oc.input(PersonalitySkillCandidateActionInput).output(PersonalityOkOutput),
  mcpSetToken: oc.input(PersonalityMcpSetTokenInput).output(PersonalityMcpSetTokenOutput),
  mcpDeleteToken: oc.input(PersonalityMcpDeleteTokenInput).output(PersonalityMcpDeleteTokenOutput),
  livingSoul: oc.input(PersonalityLivingSoulInput).output(PersonalityLivingSoulOutput),
  mcpExport: oc.input(PersonalityMcpExportInput).output(McpExportViewSchema),
  proposeExpression: oc
    .input(PersonalityProposeExpressionInput)
    .output(PersonalityProposeExpressionOutput),
  applyExpression: oc
    .input(PersonalityApplyExpressionInput)
    .output(PersonalityApplyExpressionOutput),
  revertExpression: oc
    .input(PersonalityRevertExpressionInput)
    .output(PersonalityRevertExpressionOutput),
  proposeSoulSplit: oc
    .input(PersonalityProposeSoulSplitInput)
    .output(PersonalityProposeSoulSplitOutput),
};
