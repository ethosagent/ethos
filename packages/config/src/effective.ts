import { homedir } from 'node:os';
import { join } from 'node:path';
import { REF_TO_ENV } from '@ethosagent/storage-fs';
import type { EthosConfig } from './config-types';
import { configParseNotices, personalityDefaultedByConfig } from './notices';
import { isSecretRef, SINGLE_SECRET_REF_RE, secretRefForConfigKey } from './secrets';
import { DEFAULT_PERSONALITY_ID } from './section-types';

/**
 * B3 (plan ux-feedback-and-config-clarity §6.2–6.3) — the one answer to
 * "which configuration is in effect". `ethos status`, `ethos doctor` and the
 * web Settings header all render this instead of re-deriving their own.
 */
export interface EffectiveConfig {
  /** `ETHOS_STATE_DIR` when set, else `~/.ethos`. */
  stateDir: string;
  /** `<stateDir>/config.yaml`. */
  configPath: string;
  personality: {
    id: string;
    /**
     * Which key decided it. Post-UD1-migration a personality-typed
     * `activeContext` exists only in-process (`--personality`); `default`
     * means neither key was set and the parser's fallback applies.
     */
    source: 'activeContext' | 'personality' | 'default';
    /** The `personality:` value an in-process `activeContext` outranked. */
    shadowed?: string;
  };
  model: {
    id: string;
    /** The config-level rung that decided `id` — see the caveat on
     *  {@link resolveEffectiveConfig}. */
    rung: string;
  };
  apiKey: {
    provider: string;
    /**
     * `missing` = no env var supplies `ref` AND the caller's `opts.vaultRefs`
     * listing was provided and does not hold it — nothing on this machine
     * serves the key. Without a vault listing an env miss still reads
     * `vault`, an unverified claim by design (never a false alarm when the
     * caller could not look).
     */
    source: 'env' | 'vault' | 'inline' | 'missing';
    /** The vault ref consulted (absent for `inline`). */
    ref?: string;
    /** The environment variable that supplies `ref` (source `env`). */
    envVar?: string;
    /** Set when the env var wins AND `opts.vaultRefs` says the vault also
     *  holds the ref — the silent-precedence case worth printing. */
    overrides?: 'vault';
  };
  /** The parse-time warnings for this config (`configParseNotices`). */
  warnings: string[];
}

/**
 * Resolve what this config ACTUALLY selects, from config + environment alone.
 *
 * Scope caveats, deliberate at this layer:
 * - `model.rung` knows only the CONFIG-level ladder: a `modelRouting.<id>`
 *   override for the effective personality, else the global `model:` key. The
 *   full turn-time ladder (`resolveTurnModel` in `@ethosagent/core`) also
 *   reads the personality's own declaration and the model-registry roles,
 *   which need personality FILES — not resolvable from config alone, so a
 *   registry deployment's turn can land on a different rung than reported
 *   here. The rung string names the config key that decided the id.
 * - A team-typed `activeContext` selects a team, not a personality; wiring
 *   dispatches it before the personality fallback, so this reports the
 *   `personality:` key exactly as the non-team path would use it.
 * - Vault contents are I/O this pure function does not perform: pass the
 *   vault's ref listing as `opts.vaultRefs` to get `overrides: 'vault'` and
 *   the `source: 'missing'` verdict (env unset AND the listing lacks the
 *   ref); without it an env hit is reported as `source: 'env'` with no
 *   overrides claim, and an env miss as `source: 'vault'` unverified.
 */
export function resolveEffectiveConfig(
  config: EthosConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
  opts: { vaultRefs?: Iterable<string> } = {},
): EffectiveConfig {
  const stateDir = env.ETHOS_STATE_DIR || join(homedir(), '.ethos');
  const configPath = join(stateDir, 'config.yaml');

  let personality: EffectiveConfig['personality'];
  if (config.activeContext?.type === 'personality') {
    const shadowed =
      config.personality && config.personality !== config.activeContext.name
        ? config.personality
        : undefined;
    personality = {
      id: config.activeContext.name,
      source: 'activeContext',
      ...(shadowed !== undefined ? { shadowed } : {}),
    };
  } else if (config.personality && !personalityDefaultedByConfig.has(config)) {
    personality = { id: config.personality, source: 'personality' };
  } else {
    // Either no personality at all (a constructed config) or a parsed config
    // whose file never set the key (`personalityDefaultedByConfig`).
    personality = { id: config.personality || DEFAULT_PERSONALITY_ID, source: 'default' };
  }

  const routed =
    config.modelRouting && Object.hasOwn(config.modelRouting, personality.id)
      ? config.modelRouting[personality.id]?.trim()
      : undefined;
  const model: EffectiveConfig['model'] = routed
    ? { id: routed, rung: `modelRouting.${personality.id}` }
    : { id: config.model, rung: 'model:' };

  const provider = config.provider;
  let apiKey: EffectiveConfig['apiKey'];
  if (config.apiKey && !isSecretRef(config.apiKey)) {
    apiKey = { provider, source: 'inline' };
  } else {
    let ref = secretRefForConfigKey('apiKey', { provider }) ?? `providers/${provider}/apiKey`;
    const explicit = config.apiKey?.match(SINGLE_SECRET_REF_RE);
    if (explicit?.[1]) ref = explicit[1];
    const envVar = REF_TO_ENV.get(ref);
    const envSet = envVar !== undefined && (env[envVar] ?? '') !== '';
    const vaultRefsProvided = opts.vaultRefs !== undefined;
    const vaultHasRef = [...(opts.vaultRefs ?? [])].includes(ref);
    apiKey = {
      provider,
      // `missing` only when the caller LOOKED (`opts.vaultRefs` provided) and
      // the vault does not hold the ref; without a listing an env miss stays
      // the unverified `vault` claim — never overclaim, never false-alarm.
      source: envSet ? 'env' : vaultRefsProvided && !vaultHasRef ? 'missing' : 'vault',
      ref,
      ...(envSet && envVar !== undefined ? { envVar } : {}),
      ...(envSet && vaultHasRef ? { overrides: 'vault' as const } : {}),
    };
  }

  return {
    stateDir,
    configPath,
    personality,
    model,
    apiKey,
    warnings: configParseNotices(config).warnings,
  };
}
