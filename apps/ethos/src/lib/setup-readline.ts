import { createInterface } from 'node:readline';
import { type EthosConfig, ethosDir, writeConfig } from '@ethosagent/config';
import { type KeylessPath, probeProvider } from '@ethosagent/wiring';
import {
  belowFloorHint,
  CODEX_IMPORT_CONSENT,
  importExternalLogin,
  type KeylessProbeResult,
  runCodexDeviceLogin,
} from '@ethosagent/wiring/keyless-probe';
import {
  detectLocalRuntime,
  fetchLocalModels,
  probeServedWindowCached,
  windowProbeCachePath,
} from '@ethosagent/wiring/local-models';
import { getDefaultModel } from '@ethosagent/wiring/model-catalog';
import { getProvider, PROVIDER_CATALOG } from '@ethosagent/wiring/provider-catalog';
import { redactErrorMessage } from '../redact-error';
import { getSecretsResolver, getStorage } from '../wiring';
import { probeThisMachine, runFirstRunExtras, runInstallOfferFromProbe } from './first-run';
import {
  askRl,
  c,
  codexPreset,
  describeCandidate,
  type KeylessPreset,
  LOCAL_API_KEY,
  LOCAL_PROVIDERS,
  localPreset,
  scaffoldEthosDir,
  storeSecret,
} from './setup-shared';

/** Lane 5 — the setup hint derives from the provider catalog (non-comingSoon
 *  entries) so it can never drift from what wiring actually supports.
 *  Exported for the drift test. */
export function supportedProvidersHint(): string {
  return PROVIDER_CATALOG.filter((p) => !p.comingSoon)
    .map((p) => p.id)
    .join(', ');
}

/** D9 — the readline wizard's base-URL default for non-local, non-Azure
 *  providers. Returns the catalog `defaultBaseUrl` when the provider carries
 *  one; otherwise the historical OpenRouter literal, unchanged. Exported for
 *  the regression test that pins both halves. */
export function resolveWizardBaseUrl(provider: string): string {
  return getProvider(provider)?.defaultBaseUrl ?? 'https://openrouter.ai/api/v1';
}

/** Seams for the readline path; every one defaults to the real thing. */
export interface ReadlineDeps {
  /** Replaces the terminal prompt (tests, scripted runs). */
  ask?: (question: string) => Promise<string>;
  probe?: () => Promise<KeylessProbeResult>;
  /** Whether a person is at a terminal: gates the install offer, the device
   *  sign-in and every first-run prompt. Default: `process.stdin.isTTY`. */
  interactive?: boolean;
}

export interface ReadlineOutcome {
  config: EthosConfig;
  keylessPath?: KeylessPath;
  initialMessage?: string;
}

/**
 * Numbered keyless prompts at the top of a fresh readline setup (plan §3.5).
 * Returns null when the person pastes a key (or nothing else worked).
 */
async function runKeylessReadline(
  askFn: (q: string) => Promise<string>,
  deps: {
    probe: () => Promise<KeylessProbeResult>;
    interactive: boolean;
    secrets: import('@ethosagent/types').SecretsResolver;
  },
): Promise<KeylessPreset | null> {
  let installed = false;
  let result = await deps.probe();
  for (;;) {
    const rec = result.candidates[result.recommended];
    const ordered = (
      rec
        ? [rec, ...result.candidates.filter((_, i) => i !== result.recommended)]
        : result.candidates
    ).filter((cand) => !(cand.kind === 'install-offer' && installed));
    console.log(`${c.dim}Ways to start without typing a key:${c.reset}`);
    for (const [i, cand] of ordered.entries()) {
      console.log(
        `  ${c.bold}${i + 1}${c.reset}. ${describeCandidate(cand)}${i === 0 ? ' (recommended)' : ''}`,
      );
    }
    const raw = (await askFn(`Choose 1-${ordered.length} [1]: `)).trim();
    const n = raw === '' ? 1 : Number.parseInt(raw, 10);
    const pick = Number.isInteger(n) ? ordered[n - 1] : undefined;
    if (!pick || pick.kind === 'paste-key') return null;

    if (pick.kind === 'local' && pick.belowContextFloor) {
      // Nothing is written: this candidate would fail on the first turn.
      console.log(`${c.yellow}${belowFloorHint(pick)}${c.reset}\n`);
      continue;
    }
    if (pick.kind === 'local') {
      let model = pick.models[0] ?? '';
      if (pick.models.length > 1) {
        for (const [i, m] of pick.models.entries())
          console.log(`  ${c.bold}${i + 1}${c.reset}. ${m}`);
        const mc = Number.parseInt(
          (await askFn(`Model (1-${pick.models.length}) [1]: `)).trim(),
          10,
        );
        model = Number.isInteger(mc) ? (pick.models[mc - 1] ?? model) : model;
      }
      return localPreset(pick, model, installed ? 'installed' : 'local');
    }
    if (pick.kind === 'ethos-login') return codexPreset('ethos-login');

    if (pick.kind === 'external-login') {
      console.log(`\n${CODEX_IMPORT_CONSENT}\n`);
      // The default is the separate grant; only a literal `yes` imports.
      const yes =
        (
          await askFn(
            'Import my Codex sign-in? Type "yes" to import, Enter to sign in with ChatGPT instead: ',
          )
        ).trim() === 'yes';
      if (yes) {
        const r = await importExternalLogin({ secrets: deps.secrets, source: pick.source });
        if (r.ok) return codexPreset('external-login');
        console.log(`${c.yellow}Could not import (${r.reason}).${c.reset}`);
        return null;
      }
      if (!deps.interactive) {
        console.log(
          `${c.dim}Sign in with ChatGPT needs a terminal; falling back to a pasted key.${c.reset}`,
        );
        return null;
      }
      try {
        await runCodexDeviceLogin({
          secrets: deps.secrets,
          onUserCode: (code, url) => {
            console.log(
              `  1. Open ${url}\n  2. Enter this one-time code: ${c.bold}${code}${c.reset}\n  Waiting for authorization...`,
            );
          },
        });
        return codexPreset('ethos-login');
      } catch (err) {
        console.log(
          `${c.yellow}Sign-in failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
        );
        return null;
      }
    }

    // install-offer: only a person at a terminal is asked; otherwise the
    // command is printed and setup continues to the key prompt.
    const outcome = await runInstallOfferFromProbe(
      { candidates: [pick], recommended: 0 },
      { ask: askFn, print: (line) => console.log(line) },
      deps.interactive,
    );
    if (outcome?.status === 'installed' || outcome?.status === 'pulled') {
      installed = true;
      result = await deps.probe();
      continue;
    }
    return null;
  }
}

export async function runReadlineFallback({
  storage,
  existing,
  deps = {},
}: {
  storage: ReturnType<typeof getStorage>;
  existing: EthosConfig | null;
  deps?: ReadlineDeps;
}): Promise<ReadlineOutcome | null> {
  const rl = deps.ask ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = deps.ask ?? ((q: string) => askRl(rl as ReturnType<typeof createInterface>, q));
  const interactive = deps.interactive ?? process.stdin.isTTY === true;

  if (existing) {
    const ans = await ask(
      `${c.yellow}Config already exists at ~/.ethos/config.yaml. Overwrite? (y/N)${c.reset} `,
    );
    if (ans.trim().toLowerCase() !== 'y') {
      console.log(`${c.dim}Keeping existing config.${c.reset}`);
      rl?.close();
      return { config: existing };
    }
  }

  console.log(`\n${c.cyan}${c.bold}ethos setup${c.reset}\n`);

  const secrets = await getSecretsResolver();
  // D13: the keyless prompts open a fresh setup only.
  const preset = existing
    ? null
    : await runKeylessReadline(ask, {
        probe: deps.probe ?? (() => probeThisMachine(secrets)),
        interactive,
        secrets,
      });

  let provider: string;
  let model: string;
  let apiKey: string;
  let baseUrl: string | undefined;
  let apiVersion: string | undefined;

  if (preset) {
    provider = preset.provider;
    model = preset.model;
    apiKey = preset.apiKey;
    baseUrl = preset.baseUrl;
  } else {
    console.log(`${c.dim}Supported providers: ${supportedProvidersHint()}${c.reset}`);
    provider = (await ask('Provider (anthropic): ')).trim() || 'anthropic';

    if (LOCAL_PROVIDERS.has(provider)) {
      // Local OpenAI-compatible endpoint (Ollama / vLLM): localhost base URL,
      // no API-key prompt, model list offered from GET /v1/models when reachable.
      const defaultBaseUrl = getProvider(provider)?.defaultBaseUrl ?? 'http://localhost:11434/v1';
      baseUrl = (await ask(`Base URL (${defaultBaseUrl}): `)).trim() || defaultBaseUrl;
      apiKey = LOCAL_API_KEY;

      console.log(`${c.dim}Checking ${baseUrl} for available models…${c.reset}`);
      const { reachable, models } = await fetchLocalModels(baseUrl);
      if (reachable) {
        console.log(`${c.dim}Available models:${c.reset}`);
        for (const [i, m] of models.entries()) {
          console.log(`  ${c.bold}${i + 1}${c.reset}. ${m}`);
        }
        const firstModel = models[0] ?? '';
        const choice = (await ask(`Model (1-${models.length}, or name) [${firstModel}]: `)).trim();
        const n = Number.parseInt(choice, 10);
        if (choice === '') {
          model = firstModel;
        } else if (Number.isInteger(n) && n >= 1 && n <= models.length) {
          model = models[n - 1] ?? firstModel;
        } else {
          model = choice;
        }
      } else {
        console.log(`${c.yellow}Endpoint not reachable — enter a model name manually.${c.reset}`);
        model = (await ask('Model: ')).trim();
      }

      // Lane 0 (D16) — setup probes the SERVED context window live and warms
      // the probe cache. Fail-soft: an unreachable probe prints a diagnostic
      // and setup continues.
      const runtime = detectLocalRuntime(provider, baseUrl);
      if (runtime && model) {
        const probe = await probeServedWindowCached({
          runtime,
          baseUrl,
          model,
          storage: getStorage(),
          cachePath: windowProbeCachePath(ethosDir()),
          forceRefresh: true,
        });
        if (probe.contextWindow !== undefined) {
          console.log(
            `${c.dim}Served context window: ${probe.contextWindow.toLocaleString('en-US')} tokens${c.reset}`,
          );
        } else if (probe.diagnostic) {
          console.log(`${c.yellow}${probe.diagnostic}${c.reset}`);
        }
      }
    } else {
      const defaultModel = getDefaultModel(provider)?.modelId ?? 'claude-opus-5-5';
      const modelPrompt =
        provider === 'azure'
          ? `Azure deployment name (${defaultModel}): `
          : `Model (${defaultModel}): `;
      model = (await ask(modelPrompt)).trim() || defaultModel;

      apiKey = (await ask('API key: ')).trim();
      if (!apiKey) {
        console.log(
          `${c.yellow}Warning: no API key entered. Edit ~/.ethos/config.yaml to add one.${c.reset}`,
        );
      }

      if (provider === 'azure') {
        baseUrl = (
          await ask('Azure endpoint (e.g. https://my-resource.openai.azure.com): ')
        ).trim();
        if (!baseUrl) {
          console.log(
            `${c.yellow}Warning: no Azure endpoint entered. Edit ~/.ethos/config.yaml to add one.${c.reset}`,
          );
        }
        apiVersion = (await ask('API version (2024-10-21): ')).trim() || undefined;
      } else if (provider !== 'anthropic') {
        // D9 — consult the catalog before falling back to the OpenRouter literal:
        // probeProvider live-validates the key against this URL before config is
        // written, so a non-OpenRouter key sent to openrouter.ai is rejected and
        // setup exits non-zero. PARTIAL BY CONSTRUCTION: `openai`, `anthropic`,
        // `codex`, `azure` and `bedrock` carry no `defaultBaseUrl`, so the literal
        // still applies to them. This is not a fix for every non-local provider.
        const defaultBaseUrl = resolveWizardBaseUrl(provider);
        baseUrl = (await ask(`Base URL (${defaultBaseUrl}): `)).trim() || defaultBaseUrl;
      }
    }
  }

  // W2.2 — validate the provider key with a live 1-token probe before writing
  // config. A DEFINITIVELY rejected key (401/403) never reaches disk: re-prompt
  // up to 3 times, then exit non-zero (non-TTY stdin can't loop forever). An
  // unreachable endpoint (timeout/DNS/5xx/429) warns and proceeds (W1.2).
  if (apiKey && !LOCAL_PROVIDERS.has(provider)) {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      console.log(`${c.dim}Validating ${provider} key…${c.reset}`);
      const outcome = await probeProvider({ provider, model, apiKey, baseUrl, apiVersion });
      if (outcome.ok) {
        console.log(`${c.green}✓ API key validated${c.reset}`);
        break;
      }
      if (outcome.reason === 'unreachable') {
        console.log(
          `${c.yellow}⚠ Couldn't reach ${provider} — saved unverified.${c.reset} ${c.dim}(${redactErrorMessage(
            outcome.error,
            apiKey,
          )})${c.reset}`,
        );
        break;
      }
      if (attempt >= MAX_ATTEMPTS) {
        rl?.close();
        console.error(
          'API key rejected after 3 attempts — get a key at console.anthropic.com and re-run ethos setup.',
        );
        process.exit(1);
      }
      console.log(
        `${c.yellow}✗ API key rejected (attempt ${attempt}/${MAX_ATTEMPTS}).${c.reset} ${c.dim}Re-enter it.${c.reset}`,
      );
      apiKey = (await ask('API key: ')).trim();
    }
  }

  console.log(
    `\n${c.dim}Personalities: researcher · engineer · reviewer · coach · operator${c.reset}`,
  );
  const builtin = (await ask('Default personality (researcher): ')).trim() || 'researcher';

  // D15: a user-owned born copy of the chosen built-in; prompts only for a person.
  await scaffoldEthosDir(storage);
  const extras = await runFirstRunExtras({
    storage,
    dataDir: ethosDir(),
    builtinId: builtin,
    prompt: { ask, print: (line) => console.log(line) },
    interactive,
  });
  const personality = extras.personality;

  rl?.close();

  const apiKeyRef = apiKey
    ? await storeSecret(secrets, `providers/${provider}/apiKey`, apiKey)
    : '';

  // Everything this prompt sequence did NOT ask about is carried over: the
  // `providers:` chain above all, which `writeConfig` deliberately does not
  // preserve as unexpressible lines (`parseProviderChain` owns that namespace),
  // so building a fresh object here deleted the whole chain and orphaned its
  // vault secrets. The TUI path has always round-tripped; these two agree now.
  const config: EthosConfig = {
    ...(existing ?? {}),
    provider,
    model,
    apiKey: apiKeyRef,
    personality,
    baseUrl,
    apiVersion,
  };
  await writeConfig(storage, config, secrets);
  await scaffoldEthosDir(storage);

  console.log(`\n${c.green}✓ Config saved to ~/.ethos/config.yaml${c.reset}`);
  console.log(`${c.green}✓ ~/.ethos/ directory ready${c.reset}`);
  console.log(
    `\n${c.dim}Run ${c.reset}${c.bold}ethos${c.reset}${c.dim} to start chatting.${c.reset}\n`,
  );

  return {
    config,
    keylessPath: preset?.keylessPath ?? (existing ? undefined : 'key'),
    ...(extras.initialMessage ? { initialMessage: extras.initialMessage } : {}),
  };
}
