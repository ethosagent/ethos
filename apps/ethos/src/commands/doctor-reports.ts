import { join } from 'node:path';
import { ethosDir, nearestKey, readRawConfig } from '@ethosagent/config';
import { errorLogExists, errorLogPath, readRecentErrors } from '../error-log';
import { createLLM, getStorage } from '../wiring';
import { c } from './doctor-shared';

// ---------------------------------------------------------------------------
// --fix: auto-repair common issues
// ---------------------------------------------------------------------------

/**
 * B7 — the provider suggestion for `doctor --fix`'s unknown-provider repair.
 * Damerau-Levenshtein against the catalog ids (the same `nearestKey` helper
 * as B2's unknown-config-key suggestion), replacing the first-letter guess
 * that offered 'azure' for 'antropic'. Falls back to 'anthropic' when nothing
 * is within two edits. Exported for `__tests__/doctor-funnel.test.ts`.
 */
export function suggestProvider(input: string, knownIds: readonly string[]): string {
  return nearestKey(input, knownIds) ?? 'anthropic';
}

export async function runDoctorFix(): Promise<void> {
  // chmod stays raw node:fs — Storage has no permissions API (keys.json /
  // config.yaml owner-restriction is the whole point of this repair step).
  const { chmod } = await import('node:fs/promises');
  const storage = getStorage();
  const dir = ethosDir();
  let exitCode = 0;

  console.log('');
  console.log(`${c.bold}ethos doctor --fix${c.reset}`);
  console.log('');

  // 1. Ensure the directories every surface expects exist. `backups/` is where
  //    `ethos backup` and the scheduled job write; the rest are read by the
  //    personality registry, the skill scanner and the team supervisor.
  for (const name of ['personalities', 'skills', 'teams', 'backups']) {
    const path = join(dir, name);
    if (!(await storage.exists(path))) {
      await storage.mkdir(path);
      console.log(`  ${c.green}✓ Fixed:${c.reset}  Created ${path}`);
    } else {
      console.log(`  ${c.green}✓${c.reset}  ${path} exists`);
    }
  }

  // 2. Seed MEMORY.md and USER.md
  for (const filename of ['MEMORY.md', 'USER.md']) {
    const path = join(dir, filename);
    if (!(await storage.exists(path))) {
      await storage.write(path, '');
      console.log(`  ${c.green}✓ Fixed:${c.reset}  Created ${path}`);
    } else {
      console.log(`  ${c.green}✓${c.reset}  ${path} exists`);
    }
  }

  // 3. Fix keys.json permissions (should be 0o600)
  const keysPath = join(dir, 'keys.json');
  if (await storage.exists(keysPath)) {
    try {
      await chmod(keysPath, 0o600);
      console.log(`  ${c.green}✓ Fixed:${c.reset}  Set ${keysPath} to 0600`);
    } catch {
      console.log(`  ${c.yellow}⚠${c.reset}  Could not chmod ${keysPath}`);
      exitCode = 1;
    }
  }

  // 4. Fix config.yaml permissions (may contain secret refs; restrict to owner)
  const configPath = join(dir, 'config.yaml');
  if (await storage.exists(configPath)) {
    try {
      await chmod(configPath, 0o600);
      console.log(`  ${c.green}✓ Fixed:${c.reset}  Set ${configPath} to 0600`);
    } catch {
      console.log(`  ${c.yellow}⚠${c.reset}  Could not chmod ${configPath}`);
      exitCode = 1;
    }
  }

  // 5. Tighten ~/.ethos/secrets/ to 0700 (owner only)
  const secretsPath = join(dir, 'secrets');
  if (await storage.exists(secretsPath)) {
    try {
      await chmod(secretsPath, 0o700);
      console.log(`  ${c.green}✓ Fixed:${c.reset}  Set ${secretsPath} to 0700`);
    } catch {
      console.log(`  ${c.yellow}⚠${c.reset}  Could not chmod ${secretsPath}`);
      exitCode = 1;
    }
  }

  // 6. Validate provider in config
  const config = await readRawConfig(storage);
  if (config) {
    const { PROVIDER_CATALOG } = await import('@ethosagent/wiring/provider-catalog');
    const knownIds = PROVIDER_CATALOG.map((p) => p.id);
    if (!knownIds.includes(config.provider)) {
      const closest = suggestProvider(config.provider, knownIds);
      console.log(
        `  ${c.yellow}→ Action needed:${c.reset}  Unknown provider '${config.provider}'. Did you mean '${closest}'?`,
      );
      console.log(`  ${c.dim}  Edit ~/.ethos/config.yaml and set provider: ${closest}${c.reset}`);
      exitCode = 1;
    } else {
      console.log(`  ${c.green}✓${c.reset}  Provider '${config.provider}' is valid`);
    }
  } else {
    console.log(
      `  ${c.yellow}→ Action needed:${c.reset}  No config found. Run: ${c.cyan}ethos setup${c.reset}`,
    );
    exitCode = 1;
  }

  console.log('');
  if (exitCode === 0) {
    console.log(`${c.green}✓ All auto-repairs complete.${c.reset}`);
  } else {
    console.log(
      `${c.yellow}⚠ Some issues need manual action. Try: ${c.cyan}ethos doctor --fix → ethos setup auth → ethos setup model${c.reset}`,
    );
    process.exit(exitCode);
  }
}

// ---------------------------------------------------------------------------
// --check-provider: live connectivity probe against the configured LLM
// ---------------------------------------------------------------------------

export interface ProviderProbeResult {
  provider: string;
  model: string;
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
  exit: number;
}

export async function runProviderProbe(jsonMode: boolean): Promise<void> {
  const storage = getStorage();
  const config = await readRawConfig(storage);

  if (!config) {
    const result: ProviderProbeResult = {
      provider: 'unknown',
      model: 'unknown',
      reachable: false,
      latencyMs: null,
      error: 'No config found — run ethos setup',
      exit: 1,
    };
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      console.log(
        `Provider connectivity: ${c.red}✗${c.reset} No config found — run ${c.cyan}ethos setup${c.reset}`,
      );
    }
    process.exit(1);
  }

  const provider = config.provider;
  const model = config.model;

  let reachable = false;
  let latencyMs: number | null = null;
  let error: string | null = null;

  try {
    // Lane 0 (D16) — doctor probes the served window LIVE and rewrites the
    // probe cache, so its numbers are never stale.
    const llm = await createLLM(config, { probeWindowRefresh: true });
    const start = performance.now();
    // Consume the async iterable — we only need to confirm the provider responds.
    // Using max 1 token keeps the call as cheap as possible.
    for await (const _chunk of llm.complete([{ role: 'user', content: 'ping' }], [], {
      maxTokens: 1,
    })) {
      // drain
    }
    latencyMs = Math.round(performance.now() - start);
    reachable = true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const exit = reachable ? 0 : 1;
  const result: ProviderProbeResult = { provider, model, reachable, latencyMs, error, exit };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (reachable) {
    console.log(
      `Provider connectivity: ${c.green}✓${c.reset} ${provider} (${model}) — ${latencyMs}ms`,
    );
  } else {
    console.log(`Provider connectivity: ${c.red}✗${c.reset} ${provider} (${model}) — ${error}`);
  }

  if (exit > 0) process.exit(exit);
}

// ---------------------------------------------------------------------------
// --funnel: local adoption-funnel report (W4.2)
// ---------------------------------------------------------------------------

/** Format a millisecond delta as a compact human duration, e.g. "2m 8s". */
export function formatFunnelDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec > 0 ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${hours}h ${min}m` : `${hours}h`;
}

export async function runFunnelReport(jsonMode: boolean): Promise<void> {
  // Local palette honoring NO_COLOR (plan requirement for all funnel surfaces).
  const noColor = Boolean(process.env.NO_COLOR);
  const fc = noColor
    ? { reset: '', dim: '', bold: '', green: '' }
    : { reset: c.reset, dim: c.dim, bold: c.bold, green: c.green };

  // `readFunnelState`, not `getFunnelTracker().readState()`: the tracker's
  // constructor opens the observability store, whose constructor migrates
  // observability.db (plan openclaw-9.5-adoption D24).
  const { readFunnelState } = await import('@ethosagent/wiring');
  const state = await readFunnelState(getStorage(), ethosDir());

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(state ?? {})}\n`);
    return;
  }

  console.log(`\n${fc.bold}ethos doctor --funnel${fc.reset}\n`);

  // Legacy / pre-tracking install: no setup stamp means every recorded time
  // is meaningless for TTFM — say so instead of printing garbage numbers.
  if (!state || state.setupCompletedAt === undefined) {
    console.log('No funnel data — this install predates funnel tracking (legacy).');
    if (state?.firstReplyAt !== undefined) {
      console.log(
        `${fc.dim}(a first reply was recorded on ${new Date(state.firstReplyAt).toLocaleString()} after upgrading — excluded from TTFM stats)${fc.reset}`,
      );
    }
    console.log('');
    return;
  }

  const setupAt = state.setupCompletedAt;
  const setupMeta = [
    state.setupWizardPath ? `${state.setupWizardPath} wizard` : null,
    state.setupProvider ? `provider ${state.setupProvider}` : null,
    state.setupChannels && state.setupChannels.length > 0
      ? `channels: ${state.setupChannels.join(', ')}`
      : 'no channels configured',
  ]
    .filter(Boolean)
    .join(', ');

  console.log(
    `Setup completed:      ${fc.green}✓${fc.reset} ${new Date(setupAt).toLocaleString()} ${fc.dim}(${setupMeta})${fc.reset}`,
  );

  if (state.firstReplyAt !== undefined) {
    console.log(
      `First reply:          ${fc.green}✓${fc.reset} ${new Date(state.firstReplyAt).toLocaleString()} ${fc.dim}(+${formatFunnelDuration(state.firstReplyAt - setupAt)} after setup)${fc.reset}`,
    );
  } else {
    console.log(`First reply:          ${fc.dim}not yet recorded${fc.reset}`);
  }

  // Plan keyless-first-run D22: the headline metric is first launch → first answer.
  if (state.firstLaunchAt !== undefined && state.firstReplyAt !== undefined) {
    console.log(
      `First launch → first answer: ${fc.green}✓${fc.reset} ${formatFunnelDuration(state.firstReplyAt - state.firstLaunchAt)}`,
    );
  }
  if (state.keylessPath !== undefined) {
    console.log(`Keyless path:         ${state.keylessPath}`);
  }

  const channels = Object.entries(state.channelFirstReplyAt ?? {});
  if (channels.length > 0) {
    for (const [platform, ts] of channels) {
      console.log(
        `First channel reply:  ${fc.green}✓${fc.reset} ${platform} — ${new Date(ts).toLocaleString()} ${fc.dim}(+${formatFunnelDuration(ts - setupAt)} after setup)${fc.reset}`,
      );
    }
  } else {
    console.log(`First channel reply:  ${fc.dim}not yet recorded${fc.reset}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// --recent-errors: grouped summary of ~/.ethos/logs/errors.jsonl
// ---------------------------------------------------------------------------

export function runRecentErrorsReport(): void {
  console.log('');
  console.log(`${c.bold}ethos doctor${c.reset}  ${c.dim}recent errors${c.reset}`);
  console.log('');

  if (!errorLogExists()) {
    console.log(`  ${c.dim}No error log yet (${errorLogPath()}).${c.reset}`);
    console.log(`  ${c.dim}This is a healthy state — nothing has failed.${c.reset}`);
    console.log('');
    return;
  }

  const recent = readRecentErrors(50);
  if (recent.length === 0) {
    console.log(`  ${c.dim}Log file is present but empty: ${errorLogPath()}${c.reset}`);
    console.log('');
    return;
  }

  // Group by code, count, keep newest occurrence per code for the timestamp.
  const byCode = new Map<string, { count: number; latest: string; sample: string }>();
  for (const e of recent) {
    const existing = byCode.get(e.code);
    if (existing) {
      existing.count += 1;
      // recent[] is newest-first; keep the first timestamp seen.
    } else {
      byCode.set(e.code, { count: 1, latest: e.ts, sample: e.cause });
    }
  }

  const rows = [...byCode.entries()].sort((a, b) => b[1].count - a[1].count);

  console.log(`  ${c.dim}From ${errorLogPath()} (last ${recent.length} entries)${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}${'Count'.padStart(5)}  ${'Code'.padEnd(28)}  Most-recent at${c.reset}`);
  for (const [code, info] of rows) {
    const count = String(info.count).padStart(5);
    const codeCol = code.padEnd(28);
    console.log(`  ${count}  ${c.cyan}${codeCol}${c.reset}  ${c.dim}${info.latest}${c.reset}`);
    console.log(`         ${c.dim}↳ ${info.sample}${c.reset}`);
  }
  console.log('');
  console.log(`  ${c.dim}File a bug? Attach the relevant lines from ${errorLogPath()}.${c.reset}`);
  console.log('');
}
