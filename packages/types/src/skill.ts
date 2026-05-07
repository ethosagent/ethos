export type IngestMode = 'capability' | 'tags' | 'explicit' | 'none';

/** E2 — single env-var reference with a human-readable description. */
export interface SkillEnvRef {
  name: string;
  description?: string;
}

export interface SkillPermissions {
  fs_read?: string[];
  fs_write?: string[];
  network?: string[];
  tools_required?: string[];
  mcp_env_passthrough?: string[];
}
export type FallbackBehavior = 'deny' | 'warn' | 'allow';

export interface IngestConfig {
  global_ingest?: {
    mode?: IngestMode;
    accept_tags?: string[];
    reject_tags?: string[];
    allow?: string[];
    deny?: string[];
    /** What to do when a skill has no `required_tools` in capability mode. Default: 'allow'. */
    fallback_unknown?: FallbackBehavior;
  };
}

export interface SkillIngestConfig extends IngestConfig {
  /**
   * Controls how global-pool skills are injected into the system prompt.
   *
   * - `'index'` (default): inject a compact table of name + description.
   *   The LLM calls `get_skill(name)` to load the full body on demand.
   * - `'full'`: inject every matching skill's full body (original behavior).
   *   Suitable only for small collections (< ~20 skills).
   */
  injection_mode?: 'full' | 'index';
}

/** A skill parsed from any source directory. */
export interface Skill {
  /** Qualified name: `<source>/<name>` (e.g. `claude-code/citation-formatter`). */
  qualifiedName: string;
  /** Display name from frontmatter `name` field, or derived from file path. */
  name: string;
  /** Source label (e.g. `ethos`, `claude-code`, `openclaw`, `hermes`). */
  source: string;
  /** Absolute path to the skill file. */
  filePath: string;
  /** Markdown body with frontmatter stripped. */
  body: string;
  /** Tags from frontmatter. */
  tags?: string[];
  /** Tools required by this skill, from frontmatter `required_tools`. */
  required_tools?: string[];
  /**
   * Fallback activation: skill is included only when ALL listed tools are
   * absent from the personality's effective tool reach. From frontmatter
   * `ethos.fallback_for_tools`. Mutually orthogonal with `required_tools`
   * (a skill MAY declare both — both gates must pass).
   */
  fallback_for_tools?: string[];
  /**
   * E2 — environment dependencies declared by the skill. Hard requirements:
   * skill is filtered out when any listed name is unset in `process.env`.
   * From frontmatter `ethos.env_required`.
   */
  env_required?: SkillEnvRef[];
  /**
   * E2 — informational env hints surfaced by `ethos doctor`. Never blocks
   * skill activation. From frontmatter `ethos.env_optional`.
   */
  env_optional?: SkillEnvRef[];
  /**
   * E2 — at least ONE of these external CLIs must be discoverable on PATH
   * for the skill to load. From frontmatter `ethos.external_cli_alternatives`.
   */
  external_cli_alternatives?: string[];
  /** Raw parsed frontmatter object. */
  rawFrontmatter: Record<string, unknown>;
  /** Which frontmatter dialect was detected. */
  dialect: 'agentskills' | 'openclaw' | 'hermes' | 'legacy';
  /** mtime for cache invalidation. */
  mtimeMs: number;
  /** Declared permissions from SKILL.md frontmatter `ethos.permissions`. */
  permissions?: SkillPermissions;
}
