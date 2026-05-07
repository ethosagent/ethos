// E2 — environment dependency resolver. Reads `env_required` and
// `external_cli_alternatives` from a parsed skill and reports whether the
// host environment satisfies them. Pure function: takes the env map and a
// `which` lookup as arguments so tests can drive both deterministically.

import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Skill } from '@ethosagent/types';

export interface EnvResolutionResult {
  ok: boolean;
  /** Names of `env_required` entries that are unset. */
  missingEnv: string[];
  /** Full list of CLI alternatives (when none resolved). Empty when at least
   *  one resolves OR the skill declares no alternatives. */
  missingCli: string[];
}

export interface EnvResolverOptions {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to a real PATH-walking implementation. */
  which?: (cmd: string) => boolean;
}

/**
 * Returns `{ ok: true }` when every `env_required` entry is set AND (when
 * `external_cli_alternatives` is declared) at least one CLI is on PATH.
 *
 * Pure validation — does not consult `env_optional`; that's surfaced in
 * `ethos doctor` only.
 */
export function checkSkillEnv(skill: Skill, opts: EnvResolverOptions = {}): EnvResolutionResult {
  const env = opts.env ?? process.env;
  const which = opts.which ?? defaultWhich;

  const missingEnv: string[] = [];
  for (const ref of skill.env_required ?? []) {
    const v = env[ref.name];
    if (v === undefined || v === '') missingEnv.push(ref.name);
  }

  const cliAlts = skill.external_cli_alternatives ?? [];
  let missingCli: string[] = [];
  if (cliAlts.length > 0) {
    const anyResolved = cliAlts.some((cmd) => which(cmd));
    if (!anyResolved) missingCli = [...cliAlts];
  }

  const ok = missingEnv.length === 0 && missingCli.length === 0;
  return { ok, missingEnv, missingCli };
}

/**
 * Walk PATH looking for an executable named `cmd`. Mirrors the existing
 * `skill-compat.ts` PATH walk so we don't import from there (avoids a
 * cycle: env-resolver is consumed by ingest-filter).
 */
export function defaultWhich(cmd: string): boolean {
  const PATH = process.env.PATH ?? '';
  if (!PATH || cmd.length === 0) return false;
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try {
      if (existsSync(candidate)) {
        const stat = statSync(candidate);
        if (stat.isFile()) return true;
      }
    } catch {
      // Skip unreadable entries — broken PATH entries are common and not fatal.
    }
  }
  return false;
}
