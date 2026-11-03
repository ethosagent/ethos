import { z } from 'zod';

// ---------------------------------------------------------------------------
// Skills — learning pillar of v0.5
//
// The Library panel reads `~/.ethos/skills/*.md`. Each file is a markdown
// document with optional OpenClaw frontmatter. The wire schema preserves
// the parsed frontmatter as a record so the editor UI can surface it
// alongside the markdown body without round-tripping through YAML.
// ---------------------------------------------------------------------------

export const SkillSchema = z.object({
  /** Filename minus `.md`. Stable handle the client passes back on update/delete. */
  id: z.string(),
  /** Display name. Pulled from frontmatter `name` if present, otherwise derived from id. */
  name: z.string(),
  /** Frontmatter `description`, or null if absent. */
  description: z.string().nullable(),
  /** Frontmatter as a parsed key-value record. Empty when the file has none. */
  frontmatter: z.record(z.string(), z.unknown()),
  /** Markdown body without the frontmatter block. */
  body: z.string(),
  /** ISO-8601 mtime so the UI can show "edited 2h ago". */
  modifiedAt: z.string(),
  source: z.enum(['system', 'user', 'evolver', 'personality']),
  readonly: z.boolean(),
  /** Gap 11 — non-null when the skill failed an `ethos.requires` gate at load time. */
  unavailableReason: z.string().nullable().optional(),
});
export type Skill = z.infer<typeof SkillSchema>;

/**
 * A skill candidate waiting in the learning inbox, in the shape the Evolver
 * tab's approval queue has always rendered. `id` is the learning candidate id.
 * Approving goes through `LearningInbox.approve` and is refused unless the
 * candidate's replay passed (plan `trust-before-reach.md` Part 4, L-T8);
 * rejecting marks the candidate `rejected`.
 */
export const PendingSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  body: z.string(),
  /** ISO-8601 of when the candidate file was written. */
  proposedAt: z.string(),
});
export type PendingSkill = z.infer<typeof PendingSkillSchema>;

export const EvolveConfigSchema = z.object({
  rewriteThreshold: z.number().min(0).max(1),
  newSkillPatternThreshold: z.number().min(0).max(1),
  minRunsBeforeEvolve: z.number().int().nonnegative(),
  minPatternCount: z.number().int().nonnegative(),
  autoApprove: z.boolean(),
});
export type EvolveConfigWire = z.infer<typeof EvolveConfigSchema>;

export const EvolverRunSchema = z.object({
  /** ISO-8601 of when the run completed. */
  ranAt: z.string(),
  /** Source eval-output file the run analyzed. */
  evalOutputPath: z.string(),
  rewritesProposed: z.number().int().nonnegative(),
  newSkillsProposed: z.number().int().nonnegative(),
  /** Skipped candidates with their reason from the LLM. */
  skipped: z.array(
    z.object({
      kind: z.enum(['rewrite', 'new']),
      target: z.string(),
      reason: z.string(),
    }),
  ),
});
export type EvolverRun = z.infer<typeof EvolverRunSchema>;
