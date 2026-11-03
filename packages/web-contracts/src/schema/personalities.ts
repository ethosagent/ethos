import { z } from 'zod';
import { DecisionSiteModeSchema, DecisionSiteViewSchema, ModelTierConfigSchema } from './_shared';

// ---------------------------------------------------------------------------
// Personalities
//
// `id` / `name` / `description` / `model` / `streamingTimeoutMs`
// are user-facing fields from PersonalityConfig. `soulFile` / `skillsDirs`
// (server filesystem paths) are intentionally NOT in the wire schema.
// ---------------------------------------------------------------------------

export const PersonalitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  model: z.union([z.string(), ModelTierConfigSchema]).nullable(),
  provider: z.string().nullable(),
  toolset: z.array(z.string()).nullable(),
  capabilities: z.array(z.string()).nullable(),
  streamingTimeoutMs: z.number().int().positive().nullable(),
  /** Allowed MCP server names. null = not configured (no access). */
  mcp_servers: z.array(z.string()).nullable(),
  /** Attached plugin ids. null = not configured (default-deny). */
  plugins: z.array(z.string()).nullable(),
  fs_reach: z
    .object({
      read: z.array(z.string()).nullable(),
      write: z.array(z.string()).nullable(),
      /**
       * Every declared working directory, substitution tokens unresolved, in
       * declaration order. `null` = undeclared.
       *
       * A LIST, not a string, because `fs_reach.workdir` accepts several roots
       * (the Documents surface browses each as its own root) and this is the
       * shape the config editor round-trips. Surfacing only the first entry
       * here made saving a multi-root personality from the web UI collapse it
       * to one root — the editor writes back what it was given.
       */
      workdir: z.array(z.string()).nullable(),
    })
    .nullable(),
  /** Idle-time dreaming state. Optional (omitted when unset) so the editor
   *  can read the current toggle and cadence without affecting other surfaces. */
  dreaming: z
    .object({
      enable: z.boolean(),
      idleMinutes: z.number().int().optional(),
      maxPerDay: z.number().int().optional(),
    })
    .optional(),
  /** Governed-learning approval dial. Optional (omitted when unset) so the
   *  editor can read the current value to populate its form. */
  evolution_approval_mode: z.enum(['auto', 'user']).optional(),
  /** Skill-evolution tuning. Optional (omitted when unset) so the editor can
   *  read the current values to populate its form. */
  skill_evolution: z
    .object({
      enabled: z.boolean().optional(),
      min_tool_calls: z.number().int().optional(),
      cooldown_minutes: z.number().int().optional(),
      model: z.string().optional(),
      evolve_existing: z.boolean().optional(),
      promotion: z.enum(['review', 'auto']).optional(),
      scope: z.enum(['personality', 'shared']).optional(),
    })
    .optional(),
  /** Per-personality safety dial. Optional (omitted when unset) so the editor
   *  can read the current approval mode and network reach to populate its
   *  form. A sub-key the editor can WRITE but not READ is one a save wipes. */
  safety: z
    .object({
      approvalMode: z.enum(['manual', 'smart', 'off']).optional(),
      /** Declared network reach (Ch.7), read back for the allowed-hosts editor.
       *  Sits UNDER the non-overridable floor: cloud-metadata and private
       *  ranges stay blocked whatever is listed here. */
      network: z
        .object({
          allow: z.array(z.string()).optional(),
          deny: z.array(z.string()).optional(),
          allow_private_urls: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  /** Per-personality memory backend. Optional (omitted when unset) so the
   *  editor can read the current provider to populate its form. */
  memory: z.object({ provider: z.string().optional() }).optional(),
  /** How this personality looks across identity surfaces — a custom avatar
   *  image URL and one emoji shown beside the name. Each optional (omitted
   *  when unset) so surfaces fall back to the generated mark and a bare name. */
  display: z.object({ avatar_url: z.string().optional(), emoji: z.string().optional() }).optional(),
  /** Nightly governed-learning gates. Optional (omitted when unset) so the
   *  editor can read the current toggles to populate its form. */
  nightly: z
    .object({
      enabled: z.boolean().optional(),
      judge: z
        .object({
          enabled: z.boolean().optional(),
          minInteractions: z.number().int().optional(),
        })
        .optional(),
      expression: z.boolean().optional(),
    })
    .optional(),
  /** How this personality sounds, listens, and looks on a call — the sub-keys
   *  the editor writes: `voice.tts_provider` / `voice.stt_provider` /
   *  `voice.realtime_provider` (roster labels), `voice.tts_voice`,
   *  `voice.call_style`, `voice.tier`, `voice.model` and the
   *  `voice.languages.<tag>` map. Read back so the editor can populate its form
   *  — a field the editor cannot READ is a field a save silently erases.
   *  Omitted when the personality declares no voice. */
  voice: z
    .object({
      tts_provider: z.string().optional(),
      stt_provider: z.string().optional(),
      realtime_provider: z.string().optional(),
      tts_voice: z.string().optional(),
      call_style: z.enum(['liquid', 'orb', 'rings']).optional(),
      tier: z.enum(['pipeline', 'realtime']).optional(),
      model: z.string().optional(),
      languages: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  /** Which decision model this personality uses and where
   *  (`PersonalityConfig.decisions`, plan decision-provider-personality §9).
   *  `provider` and `sites` are the declaration as stored — `provider` verbatim,
   *  even when this machine has not configured it — read back so the editor can
   *  populate its form. `resolved` is the same resolution the character
   *  sheet's `## Decisions` section prints: whether the operator configured the
   *  named provider, whether its key is stored (set only when configured), and
   *  every site. Absent when the server was not given the global config.
   *  Omitted when the personality declares no `decisions`. */
  decisions: z
    .object({
      provider: z.string().optional(),
      sites: z
        .object({
          injection: DecisionSiteModeSchema.optional(),
          approver: DecisionSiteModeSchema.optional(),
          router: DecisionSiteModeSchema.optional(),
        })
        .optional(),
      resolved: z
        .object({
          configured: z.boolean(),
          apiKeyPresent: z.boolean().optional(),
          sites: z.array(DecisionSiteViewSchema),
        })
        .optional(),
    })
    .optional(),
  system: z.boolean(),
  /** True when the personality lives in the package's built-in data directory
   *  (read-only). User-created personalities under `~/.ethos/personalities/`
   *  are mutable. */
  builtin: z.boolean(),
  /** Optimistic-concurrency version. v1 always returns 1. */
  version: z.number().int(),
});
export type Personality = z.infer<typeof PersonalitySchema>;

// ---------------------------------------------------------------------------
// Personality skills — v1
//
// Per-personality skills/*.md files (under
// ~/.ethos/personalities/<id>/skills/). Same shape as the global
// SkillSchema but scoped to one personality. Surfaces under the
// Personalities tab's editor.
// ---------------------------------------------------------------------------

export const PersonalitySkillSchema = z.object({
  /** Filename minus `.md`. */
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  body: z.string(),
  /** ISO-8601 mtime. */
  modifiedAt: z.string(),
});
export type PersonalitySkill = z.infer<typeof PersonalitySkillSchema>;
