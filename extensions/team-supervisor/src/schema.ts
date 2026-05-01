import type { TeamManifest, TeamMember } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const TeamMemberSchema: z.ZodType<TeamMember> = z.object({
  personality: z.string().min(1),
  port: z.number().int().positive().optional(),
  capabilities: z.array(z.string()).optional(),
  auto_restart: z.boolean().optional(),
});

const TeamManifestSchema: z.ZodType<TeamManifest> = z
  .object({
    name: z.string().min(1),
    // Allow empty string so draft manifests (created by `ethos team create`)
    // pass parse; validate non-empty at start time via validateForStart().
    description: z.string(),
    // Same: allow empty array in drafts; validateForStart() enforces non-empty.
    domain_capabilities: z.array(z.string()),
    dispatch_mode: z.enum(['coordinator', 'self-routing', 'broadcast']).optional(),
    coordinator: z.string().optional(),
    coordinator_model: z.string().optional(),
    personality_models: z.record(z.string(), z.string()).optional(),
    mesh: z.string().optional(),
    members: z.array(TeamMemberSchema),
  })
  .superRefine((val, ctx) => {
    const mode =
      val.dispatch_mode ?? (val.coordinator !== undefined ? 'coordinator' : 'self-routing');
    if (mode === 'coordinator' && val.coordinator === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`coordinator` field is required when dispatch_mode is "coordinator"',
        path: ['coordinator'],
      });
    }
  });

function firstIssueMessage(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return 'unknown validation error';
  const path = issue.path.length > 0 ? `\`${issue.path.join('.')}\`: ` : '';
  return `${path}${issue.message}`;
}

/**
 * Parse and validate a team manifest from its raw YAML content.
 *
 * Throws `EthosError('TEAM_MANIFEST_INVALID', ...)` on any parse or
 * validation failure. Logs a warning (but does not fail) when
 * `dispatch_mode: self-routing` is set alongside a `coordinator:` field.
 */
export function parseTeamManifest(yamlContent: string): TeamManifest {
  let raw: unknown;
  try {
    raw = parseYaml(yamlContent);
  } catch (err) {
    throw new EthosError({
      code: 'TEAM_MANIFEST_INVALID',
      cause: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
      action: 'Fix the YAML syntax in team.yaml and re-run.',
    });
  }

  const result = TeamManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new EthosError({
      code: 'TEAM_MANIFEST_INVALID',
      cause: `team.yaml is invalid — ${firstIssueMessage(result.error)}`,
      action: 'Fix the offending field in team.yaml and re-run `ethos team start`.',
      details: result.error.issues,
    });
  }

  const manifest = result.data;

  // Effective dispatch mode (default resolution mirrors superRefine logic).
  const effectiveMode =
    manifest.dispatch_mode ?? (manifest.coordinator !== undefined ? 'coordinator' : 'self-routing');

  if (effectiveMode === 'self-routing' && manifest.coordinator !== undefined) {
    // Not fatal — coordinator field is ignored at runtime, but warn so the
    // author knows their intent doesn't match the configured mode.
    console.warn(
      `[team-supervisor] team.yaml: \`coordinator\` field is set but dispatch_mode is "self-routing" — the coordinator field will be ignored`,
    );
  }

  return manifest;
}

/**
 * Validate a parsed manifest is ready to be started.
 * `parseTeamManifest` allows draft manifests (empty members/capabilities);
 * this function enforces the runtime constraints that the supervisor needs.
 * Called by `ethos team start` before spawning the supervisor.
 */
export function validateForStart(manifest: TeamManifest): void {
  if (manifest.members.length === 0) {
    throw new EthosError({
      code: 'TEAM_MANIFEST_INVALID',
      cause: `Team "${manifest.name}" has no members`,
      action: `Add at least one personality: ethos team ${manifest.name} add <personality>`,
    });
  }

  // Phase 4: warn on unknown personality_models keys (explicit invalid override).
  if (manifest.personality_models) {
    const knownPersonalities = new Set(manifest.members.map((m) => m.personality));
    for (const key of Object.keys(manifest.personality_models)) {
      if (!knownPersonalities.has(key)) {
        console.warn(
          `[team] Warning: personality_models key "${key}" does not match any team member personality. ` +
            `Known personalities: ${[...knownPersonalities].join(', ') || '(none)'}`,
        );
      }
    }
  }
}
