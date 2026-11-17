import { join } from 'node:path';
import type { Logger, SecretsResolver, Storage } from '@ethosagent/types';
import { applyPlatformShim } from './bots';
import type { EthosConfig } from './config-types';
import {
  parseErrorsByConfig,
  parseWarningsByConfig,
  personalityDefaultedByConfig,
} from './notices';
import { parseConfigYaml } from './parse';
import { ethosDir } from './paths';
import { isProviderChainLine } from './provider-chain';
import { configLineKey } from './scalar';
import { validateNoPlaintextSecrets } from './secrets';
import { resolveConfigSecrets } from './secrets-config';
import { CURRENT_ETHOS_CONFIG_SCHEMA_VERSION } from './section-types';
import { serializeConfigLines } from './serialize';

/**
 * Set to true once per process after emitting the pre-versioned-config
 * deprecation warning so we don't spam stderr across repeated reads.
 */
let preVersionedConfigWarned = false;

/**
 * `opts.logger` receives the one-per-process pre-versioned-config warning
 * (Law 10 — library code is silent). The CLI passes one from its first config
 * read (`initSecrets` in apps/ethos/src/wiring.ts); a read without a logger
 * does not warn and does not use up the once-per-process warning.
 *
 * `opts.dir` reads `<dir>/config.yaml` instead of `ethosDir()`'s — for a host
 * that has pointed `ETHOS_STATE_DIR` at its own data folder but still reads
 * the operator's shared `~/.ethos/config.yaml` (the desktop backend,
 * `sharedEthosDir` in apps/desktop/src/main/serve.ts).
 */
export async function readRawConfig(
  storage: Storage,
  opts: { logger?: Logger; dir?: string } = {},
): Promise<EthosConfig | null> {
  const configPath = join(opts.dir ?? ethosDir(), 'config.yaml');
  const src = await storage.read(configPath);
  if (!src) return null;
  const parsed = parseConfigYaml(src);
  if (parsed.activeContext?.type === 'personality') {
    await migrateActiveContextPersonality(storage, configPath, src, parsed);
  }
  if (parsed.schemaVersion === undefined && !preVersionedConfigWarned && opts.logger) {
    preVersionedConfigWarned = true;
    opts.logger.warn(
      `\n[ethos] ~/.ethos/config.yaml is missing 'schemaVersion'. ` +
        `Treating as schemaVersion: ${CURRENT_ETHOS_CONFIG_SCHEMA_VERSION}. ` +
        `Re-running 'ethos setup' (or adding 'schemaVersion: ${CURRENT_ETHOS_CONFIG_SCHEMA_VERSION}' to the top of the file) ` +
        `will silence this warning and let future migrations key off the version.\n`,
    );
  }
  return parsed;
}

/**
 * UD1 Option A (plan ux-feedback-and-config-clarity §6.2) — `personality:` is
 * the ONE default-personality key; on disk `activeContext` keeps only the team
 * case. A file still carrying `activeContext.type: personality` is migrated on
 * load: in memory the entry is folded into `personality:` (so the legacy read
 * path `config.activeContext?.name ?? config.personality` yields the same id),
 * and the FILE is rewritten once, surgically — only the `activeContext.*` and
 * `personality:` lines change, so every comment and unmodelled line survives
 * without going through the serializer. A deprecation notice is recorded on
 * `parseWarningsByConfig` for one release. The in-process `activeContext`
 * personality override (`applyCliOverrides` for `--personality`) is untouched:
 * this migrates what the LOAD PATH read from disk, never a constructed config.
 *
 * Mutates `parsed` in place — the parse-notice side tables are keyed by object
 * identity, and a copy would silently drop `parseErrorsByConfig`.
 * Fail-open on the rewrite: if the write throws, this process still runs the
 * migrated config and the next load repeats the attempt.
 */
async function migrateActiveContextPersonality(
  storage: Storage,
  configPath: string,
  src: string,
  parsed: EthosConfig,
): Promise<void> {
  const ctx = parsed.activeContext;
  if (ctx?.type !== 'personality') return;
  parsed.personality = ctx.name;
  // The migration sets an explicit personality, so the parser's "key absent"
  // record no longer describes this config (see `personalityDefaultedByConfig`).
  personalityDefaultedByConfig.delete(parsed);
  parsed.activeContext = undefined;
  const exLines = src.split('\n');
  const hasPersonalityLine = exLines.some((l) => configLineKey(l) === 'personality');
  const out: string[] = [];
  let inserted = false;
  for (const line of exLines) {
    const key = configLineKey(line);
    if (key === 'personality') {
      out.push(`personality: ${ctx.name}`);
      continue;
    }
    if (key === 'activeContext.type' || key === 'activeContext.name') {
      if (!hasPersonalityLine && !inserted) {
        out.push(`personality: ${ctx.name}`);
        inserted = true;
      }
      continue;
    }
    out.push(line);
  }
  // Atomic on purpose: config.yaml is exactly the "partial write corrupts
  // state" case the Storage contract reserves `writeAtomic` for.
  let rewriteError: string | null = null;
  try {
    await storage.writeAtomic(configPath, out.join('\n'), { mode: 0o600 });
  } catch (err) {
    // Read-only mount, permissions — the in-memory migration above still
    // holds for this process, and the next load repeats the attempt.
    rewriteError = err instanceof Error ? err.message : String(err);
  }
  // The notice is honest about which of the two states the file is in: it is
  // pushed AFTER the write attempt, never before.
  const warnings = parseWarningsByConfig.get(parsed) ?? [];
  warnings.push(
    `activeContext.type: personality is deprecated — migrated to 'personality: ${ctx.name}' ` +
      `(activeContext now only names a team). ` +
      (rewriteError === null
        ? `The file was rewritten automatically; no action needed.`
        : `The file could not be rewritten (${rewriteError}); this run uses the migrated ` +
          `value in memory, and the rewrite will be retried on the next load.`),
  );
  parseWarningsByConfig.set(parsed, warnings);
}

export async function readConfig(
  storage: Storage,
  secrets: SecretsResolver,
  opts: { dir?: string } = {},
): Promise<EthosConfig | null> {
  const raw = await readRawConfig(storage, opts);
  if (!raw) return null;
  return resolveConfigSecrets(raw, secrets);
}

/** The heading orphaned comment blocks are kept under (B5, §6.6). */
const UNATTACHED_COMMENTS_MARKER = '# --- unattached ---';

/**
 * B5 (plan ux-feedback-and-config-clarity §6.6) — re-attach the existing
 * file's comments and blank lines to the freshly serialized key lines, BY KEY,
 * never by position (§9: positional attachment misplaces a comment when a key
 * moves between sections).
 *
 * Shape: everything above the first key line is the file header and stays at
 * the top; the contiguous run of comment/blank lines immediately above each
 * later key line is that key's block and is re-emitted above the key wherever
 * it now sits; comment/blank lines after the last key line stay at the end;
 * blocks whose key no longer exists keep their COMMENT lines under a
 * `# --- unattached ---` tail (a blank-only block above a deleted key is
 * dropped — there is nothing to preserve). A double write is byte-identical:
 * the tail written by the first write parses as trailing lines on the second.
 * Pinned by `__tests__/config-write-preserves-keys.test.ts`.
 */
export function weaveComments(existing: string, lines: readonly string[]): string[] {
  const exLines = existing.split('\n');
  // The artifact of the file's final newline, not a real blank line.
  if (exLines.at(-1) === '') exLines.pop();
  const header: string[] = [];
  const blocks = new Map<string, string[]>();
  let pending: string[] = [];
  let sawKey = false;
  for (const line of exLines) {
    const key = configLineKey(line);
    if (key === null) {
      pending.push(line);
      continue;
    }
    if (!sawKey) header.push(...pending);
    else if (pending.length > 0 && !blocks.has(key)) blocks.set(key, pending);
    sawKey = true;
    pending = [];
  }
  const trailing = sawKey ? pending : [];
  if (!sawKey) header.push(...pending);

  const out: string[] = [...header];
  const consumed = new Set<string>();
  for (const line of lines) {
    const key = configLineKey(line);
    if (key !== null && !consumed.has(key)) {
      const block = blocks.get(key);
      if (block) {
        out.push(...block);
        blocks.delete(key);
      }
      consumed.add(key);
    }
    out.push(line);
  }
  out.push(...trailing);
  const orphans: string[] = [];
  for (const block of blocks.values()) {
    orphans.push(...block.filter((l) => l.trimStart().startsWith('#')));
  }
  if (orphans.length > 0) out.push(UNATTACHED_COMMENTS_MARKER, ...orphans);
  return out;
}

/**
 * The lines of `existing` that `serializeConfigLines` cannot produce, returned
 * verbatim so a write that changes one key keeps the rest of the operator's
 * file. Two classes reach here: keys this module models nowhere (`approvalMode`,
 * `debugMode`, `contextLayering` and the `display.voice_*` block are written by
 * `apps/web-api`'s ConfigRepository, which round-trips unknown keys through its
 * own `passthrough` map; operators hand-write more), and keys it parses but
 * only serializes at their non-default value (`display.resume_hint: true`,
 * `logs.rotation.enabled: true`). Both used to be deleted by every command that
 * persists config — `ethos personality set`, `ethos set`, `ethos retention`,
 * `ethos fallback` and the rest.
 *
 * The comparison is against a round-trip of the file ITSELF, not a fixed key
 * list: a key the serializer WOULD have emitted for the on-disk config but did
 * not emit for this one is a key the caller cleared on purpose, so
 * `writeConfig(storage, { ...cfg, retention: undefined })` still deletes it.
 * Pinned by `packages/config/src/__tests__/config-write-preserves-keys.test.ts`.
 *
 * `providers.<n>.*` lines are never kept here: `parseProviderChain` carries an
 * unmodelled field on its entry's `passthrough`, so the field is re-emitted at
 * the entry's CURRENT index — a verbatim copy would stay at the old index and
 * attach to whichever entry moved into it. Pinned by
 * `packages/config/src/__tests__/config-provider-chain.test.ts`.
 *
 * Comments and blank lines are handled by `weaveComments` (B5), not here — this
 * function returns KEY lines only. Remaining limit, pre-existing: a preserved
 * credential is not externalized into the vault (nothing parses the key, so
 * `externalizeConfigSecrets` never sees it) — it stays exactly as the writer
 * that put it there left it.
 */
export function unexpressibleLines(existing: string, emitted: readonly string[]): string[] {
  const covered = new Set<string>();
  for (const line of emitted) {
    const key = configLineKey(line);
    if (key) covered.add(key);
  }
  let baseline: string[];
  try {
    baseline = serializeConfigLines(parseConfigYaml(existing));
  } catch {
    // The file on disk does not parse — `parseConfigYaml` rejects a handful of
    // out-of-range values (`backup.keep: 0`), and `ethos setup` over such a
    // file is the reachable case, since every other caller read it first and
    // would have thrown already. Nothing can then be said about which of its
    // keys this serializer expresses, so preserve none rather than block the
    // write: that is exactly what happened before anything was preserved.
    return [];
  }
  for (const line of baseline) {
    const key = configLineKey(line);
    if (key) covered.add(key);
  }
  const kept: string[] = [];
  for (const line of existing.split('\n')) {
    const key = configLineKey(line);
    if (key === null || covered.has(key) || isProviderChainLine(line)) continue;
    kept.push(line);
  }
  return kept;
}

/**
 * Strict loader used by the gateway boot path. Returns the parsed config
 * along with any deprecation messages — from the legacy → list-shape shim and
 * from the parse itself — AND any parse-time errors for malformed bot entries.
 * Boot prints both and exits non-zero on errors so a typo never silently boots
 * zero bots. A deprecation is never fatal; a parse error always is, which is
 * why a value the parse quietly repaired belongs in `deprecations`.
 */
export interface LoadedConfig {
  config: EthosConfig;
  parseErrors: string[];
  deprecations: string[];
}

export async function loadConfigStrict(
  storage: Storage,
  secrets?: SecretsResolver,
): Promise<LoadedConfig | null> {
  const parsed = await readRawConfig(storage);
  if (!parsed) return null;
  if (secrets) validateNoPlaintextSecrets(parsed);
  const parseErrors = parseErrorsByConfig.get(parsed) ?? [];
  const parseWarnings = parseWarningsByConfig.get(parsed) ?? [];
  const resolved = secrets ? await resolveConfigSecrets(parsed, secrets) : parsed;
  const { config, deprecations } = applyPlatformShim(resolved);
  return { config, parseErrors, deprecations: [...parseWarnings, ...deprecations] };
}
