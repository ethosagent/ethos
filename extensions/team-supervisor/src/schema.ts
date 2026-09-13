import { noopLogger } from '@ethosagent/logger';
import { isSafePathSegment } from '@ethosagent/storage-fs';
import type { Logger, TeamManifest, TeamMember } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

const TeamMemberSchema = z.object({
  personality: z.string().min(1).refine(isSafePathSegment, {
    message: 'personality must not contain path separators, "..", or start with "."',
  }),
  port: z.number().int().positive().optional(),
  capabilities: z.array(z.string()).optional(),
  auto_restart: z.boolean().optional(),
  role: z.enum(['coordinator', 'member']).optional(),
});

const TeamManifestSchema = z
  .object({
    name: z.string().min(1).refine(isSafePathSegment, {
      message: 'team name must not contain path separators, "..", or start with "."',
    }),
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
    dispatch_prefer_reliable: z.boolean().optional(),
    dispatch_as_background_job: z.boolean().optional(),
    postmortems: z.boolean().optional(),
    trust_policy: z
      .object({
        mode: z.enum(['flat', 'tiered']),
        thresholds: z
          .object({
            standard_min_completed: z.number().int().nonnegative().optional(),
            standard_min_ratio: z.number().min(0).max(1).optional(),
            trusted_min_completed: z.number().int().nonnegative().optional(),
            trusted_min_ratio: z.number().min(0).max(1).optional(),
          })
          .optional(),
      })
      .optional(),
    members: z.array(TeamMemberSchema),
    channels: z
      .array(
        z.object({
          platform: z.string().min(1),
          botKey: z.string().min(1),
          config: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional(),
    kanban: z
      .object({
        stale_ms: z.number().int().positive().optional(),
        poll_ms: z.number().int().positive().optional(),
        staleness_threshold_ms: z.number().int().positive().optional(),
      })
      .optional(),
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

    // Plan B — if dispatch_mode is coordinator, the manifest must declare exactly
    // one member with role: coordinator, and that member's personality must match
    // the top-level coordinator field. Zero coordinators is rejected so the role
    // gate cannot silently disappear — fail-closed.
    if (mode === 'coordinator' && val.coordinator !== undefined && val.members.length > 0) {
      const coordinators = val.members.filter((m) => m.role === 'coordinator');
      if (coordinators.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `dispatch_mode=coordinator requires exactly one member with role=coordinator (found ${coordinators.length}). Add 'role: coordinator' to the ${val.coordinator} member.`,
          path: ['members'],
        });
      } else {
        const coord = coordinators[0];
        if (coord && coord.personality !== val.coordinator) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `member with role=coordinator (${coord.personality}) does not match top-level coordinator (${val.coordinator})`,
            path: ['members'],
          });
        }
      }
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
 *
 * `source` names the file in those messages. It defaults to `team.yaml`, the
 * wording every loader of an on-disk manifest has always shown; a caller that
 * validates a manifest it is about to write under another name (`scaffold_team`
 * writes `<name>.yaml`) passes that name so the error points at a real file.
 */
export function parseTeamManifest(
  yamlContent: string,
  opts: { logger?: Logger; source?: string } = {},
): TeamManifest {
  const logger = opts.logger ?? noopLogger;
  const source = opts.source ?? 'team.yaml';
  let raw: unknown;
  try {
    raw = parseYaml(yamlContent);
  } catch (err) {
    throw new EthosError({
      code: 'TEAM_MANIFEST_INVALID',
      cause: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
      action: `Fix the YAML syntax in ${source} and re-run.`,
    });
  }

  const result = TeamManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new EthosError({
      code: 'TEAM_MANIFEST_INVALID',
      cause: `${source} is invalid — ${firstIssueMessage(result.error)}`,
      action: `Fix the offending field in ${source} and re-run \`ethos team start\`.`,
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
    logger.warn(
      `[team-supervisor] ${source}: \`coordinator\` field is set but dispatch_mode is "self-routing" — the coordinator field will be ignored`,
      { component: 'team-supervisor', team: manifest.name },
    );
  }

  return manifest;
}

// Emission order for `serializeTeamManifest`. Typed as a complete record of the
// contract's keys, so a field added to `TeamManifest` or `TeamMember` fails the
// typecheck here until the serializer emits it — the drift that let the CLI
// rewrite drop `role`, `kanban`, `trust_policy` and `channels` on every
// `ethos team <name> add|remove`.
const MANIFEST_KEYS: Record<keyof TeamManifest, true> = {
  name: true,
  description: true,
  domain_capabilities: true,
  dispatch_mode: true,
  coordinator: true,
  coordinator_model: true,
  personality_models: true,
  mesh: true,
  dispatch_prefer_reliable: true,
  dispatch_as_background_job: true,
  postmortems: true,
  trust_policy: true,
  members: true,
  channels: true,
  kanban: true,
};

const MEMBER_KEYS: Record<keyof TeamMember, true> = {
  personality: true,
  role: true,
  auto_restart: true,
  port: true,
  capabilities: true,
};

function pickDefined<T extends object>(
  value: T,
  keys: Record<keyof T, true>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(keys) as (keyof T & string)[]) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

/**
 * Serialize a team manifest to the YAML `parseTeamManifest` reads — the one
 * writer of the format, used by `ethos team` (apps/ethos/src/commands/team.ts)
 * and the `scaffold_team` tool (extensions/tools-personality-design). Scalars
 * are quoted by the `yaml` library, so a value carrying a newline or `key:`
 * cannot inject a sibling field. `parseTeamManifest(serializeTeamManifest(m))`
 * deep-equals `m` — pinned by `schema.test.ts` ("serializeTeamManifest").
 */
export function serializeTeamManifest(manifest: TeamManifest): string {
  const doc = pickDefined(manifest, MANIFEST_KEYS);
  doc.members = manifest.members.map((member) => pickDefined(member, MEMBER_KEYS));
  return stringifyYaml(doc, { aliasDuplicateObjects: false, lineWidth: 0 });
}

/**
 * Validate a parsed manifest is ready to be started.
 * `parseTeamManifest` allows draft manifests (empty members/capabilities);
 * this function enforces the runtime constraints that the supervisor needs.
 * Called by `ethos team start` before spawning the supervisor.
 */
export function validateForStart(manifest: TeamManifest, opts: { logger?: Logger } = {}): void {
  const logger = opts.logger ?? noopLogger;
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
        logger.warn(
          `[team] Warning: personality_models key "${key}" does not match any team member personality. ` +
            `Known personalities: ${[...knownPersonalities].join(', ') || '(none)'}`,
          { component: 'team-supervisor', team: manifest.name, key },
        );
      }
    }
  }
}
