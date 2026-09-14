// `ethos models` — the model registry from the terminal.
//
// Today it has exactly one subcommand: `test`, the D19 probe path unwrapped
// (T1.23). One real one-token completion against the model an alias names, and
// either a latency or the vendor's own refusal, verbatim.
//
// No cache, no TTL, no scheduling, and nothing probed at boot — a user asked,
// one probe ran, its outcome is printed (D28). D18's boot verification wraps
// this same path later, as T2.13.

import { type EthosConfig, readRawConfig } from '@ethosagent/config';
import type { SecretsResolver } from '@ethosagent/types';
import {
  type ModelTestOutcome,
  type ModelTestProbe,
  type ModelTestRateLimiter,
  providerEntryProbes,
  testModelAlias,
} from '@ethosagent/wiring';
import { getSecretsResolver, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const USAGE = [
  'Usage: ethos models test <alias>',
  '       ethos models test --all',
  '',
  '  <alias>  a `modelRegistry.<alias>` entry from ~/.ethos/config.yaml',
  '  --all    test one entry per PROVIDER ENTRY the registry references —',
  '           the credential belongs to the entry, so six aliases on one key',
  '           are one check',
].join('\n');

/** Seams. Every one of them is defaulted; tests supply doubles so no test
 *  touches the network, a real key or the user's config. */
export interface ModelsCommandDeps {
  loadConfig?: () => Promise<EthosConfig | null>;
  secrets?: SecretsResolver;
  probe?: ModelTestProbe;
  limiter?: ModelTestRateLimiter;
  out?: (line: string) => void;
}

/**
 * The rows one outcome prints, in order. Exported so the acceptance tests read
 * the same strings the terminal does.
 *
 * `covers` is the other aliases a `--all` sweep folded into this one check.
 */
export function renderModelTest(outcome: ModelTestOutcome, covers?: string[]): string[] {
  const also =
    covers && covers.length > 1 ? ` ${c.dim}· covers ${covers.join(', ')}${c.reset}` : '';
  switch (outcome.state) {
    case 'ok': {
      const lines = [
        `${c.green}✓${c.reset} ${outcome.modelId} · ${c.cyan}${outcome.providerKey}${c.reset} · ${outcome.latencyMs} ms${also}`,
      ];
      // Only when it DIFFERS: printing the same id twice is noise (D19).
      if (outcome.echoedModel && outcome.echoedModel !== outcome.modelId) {
        lines.push(`  ${c.dim}responded as ${outcome.echoedModel}${c.reset}`);
      }
      return lines;
    }
    case 'rejected':
      return [
        `${c.red}✗${c.reset} ${outcome.modelId} · ${c.cyan}${outcome.providerKey}${c.reset} — the key was rejected.${also}`,
        // The vendor's own body, verbatim and untruncated. V8 exists because a
        // bare vendor error was the whole experience; the answer is to keep the
        // vendor's words AND add the sentence around them.
        `  ${outcome.error}`,
        `  ${c.yellow}Fix:${c.reset} ${outcome.fix}`,
      ];
    case 'unreachable':
      return [
        `${c.yellow}?${c.reset} ${outcome.modelId} · ${c.cyan}${outcome.providerKey}${c.reset} — could not reach ${outcome.provider} (${outcome.error}). This is not a bad key — try again.${also}`,
      ];
    case 'unconfigured': {
      const lines = [`${c.red}✗${c.reset} ${subjectOf(outcome)} — ${outcome.reason}`];
      if (outcome.fix) lines.push(`  ${c.yellow}Fix:${c.reset} ${outcome.fix}`);
      return lines;
    }
    case 'rate_limited':
      return [
        `${c.red}✗${c.reset} ${subjectOf(outcome)} — tested moments ago. Wait ${outcome.retryAfterSeconds}s before testing it again.`,
      ];
  }
}

/** What an outcome is about: its alias, or — for an unsaved model, which only
 *  the RPC can test — its `providerKey/modelId` pair. */
function subjectOf(outcome: { alias?: string; providerKey?: string; modelId?: string }): string {
  return outcome.alias ?? `${outcome.providerKey ?? '?'}/${outcome.modelId ?? '?'}`;
}

/** An outcome that means the command did not do what was asked. An
 *  `unreachable` result is NOT one of them — it is not a verdict on the key. */
function isFailure(outcome: ModelTestOutcome): boolean {
  return outcome.state !== 'ok' && outcome.state !== 'unreachable';
}

export async function runModels(args: string[], deps: ModelsCommandDeps = {}): Promise<void> {
  const out = deps.out ?? ((line: string) => console.log(line));

  if (args[0] !== 'test') {
    out(USAGE);
    process.exitCode = 1;
    return;
  }

  const rest = args.slice(1);
  const all = rest.includes('--all');
  const alias = rest.find((a) => !a.startsWith('-'));
  if (!all && alias === undefined) {
    out(USAGE);
    process.exitCode = 1;
    return;
  }

  const config = await (deps.loadConfig ?? (() => readRawConfig(getStorage())))();
  if (!config) {
    out(
      `${c.red}✗${c.reset} No config found at ~/.ethos/config.yaml — run ${c.cyan}ethos setup${c.reset}.`,
    );
    process.exitCode = 1;
    return;
  }
  const secrets = deps.secrets ?? (await getSecretsResolver());

  const targets = all
    ? providerEntryProbes(config.modelRegistry)
    : [{ providerKey: '', alias: alias ?? '', aliases: [alias ?? ''] }];

  if (all && targets.length === 0) {
    out(
      `${c.red}✗${c.reset} No model registry entries are configured, so there is nothing to test.`,
    );
    out(
      `  ${c.yellow}Fix:${c.reset} add one with \`modelRegistry.<alias>.provider\` / \`.modelId\` in ~/.ethos/config.yaml.`,
    );
    process.exitCode = 1;
    return;
  }

  if (all) {
    out(
      `${c.bold}Testing ${targets.length} provider ${targets.length === 1 ? 'entry' : 'entries'} the registry references.${c.reset}`,
    );
  }

  let failed = false;
  for (const target of targets) {
    const outcome = await testModelAlias({
      alias: target.alias,
      config,
      secrets,
      caller: 'cli',
      ...(deps.probe ? { probe: deps.probe } : {}),
      ...(deps.limiter ? { limiter: deps.limiter } : {}),
    });
    for (const line of renderModelTest(outcome, all ? target.aliases : undefined)) out(line);
    if (isFailure(outcome)) failed = true;
  }

  if (failed) process.exitCode = 1;
}
