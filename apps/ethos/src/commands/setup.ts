import { createInterface } from 'node:readline';
import {
  type BotBinding,
  type EthosConfig,
  ethosDir,
  externalizeProviderChain,
  isProviderChainSecretRef,
  readRawConfig,
  secretRefFromValue,
  writeConfig,
  writeKeys,
} from '@ethosagent/config';
import type { WizardStepId } from '@ethosagent/tui/setup';
import type { KeylessPath } from '@ethosagent/wiring';
import type { KeylessProbeResult } from '@ethosagent/wiring/keyless-probe';
import { getDefaultModel } from '@ethosagent/wiring/model-catalog';
import {
  type FirstRunOutcome,
  type Prompter,
  probeThisMachine,
  runFirstRunExtras,
  runInstallOfferFromProbe,
} from '../lib/first-run';
import { runReadlineFallback } from '../lib/setup-readline';
import {
  askRl,
  c,
  codexPreset,
  describeCandidate,
  localPreset,
  scaffoldEthosDir,
  storeSecret,
} from '../lib/setup-shared';
import { getFunnelTracker, getSecretsResolver, getStorage } from '../wiring';

// Importers (tests, index.ts) still read these names from './setup'.
export {
  type ReadlineDeps,
  type ReadlineOutcome,
  resolveWizardBaseUrl,
  runReadlineFallback,
  supportedProvidersHint,
} from '../lib/setup-readline';
export { scaffoldEthosDir } from '../lib/setup-shared';

export interface SetupResult {
  config: EthosConfig;
  /** W2.5 three-way close outcome from the TUI LaunchStep. The readline
   *  fallback has no launch step, so it always returns 'done'. */
  launch: 'gateway' | 'chat' | 'done';
  /** Validated Telegram `@username`, reused in the gateway success block. */
  telegramUsername?: string;
  /** A first task the user picked after setup (D16); the chat starts with it. */
  initialMessage?: string;
}

export async function runSetup(startAtStep?: WizardStepId): Promise<SetupResult | null> {
  const storage = getStorage();
  const existingConfig = await readRawConfig(storage);

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { runSetupWizard } = await import('@ethosagent/tui/setup');

    const existingAnswers = existingConfig
      ? {
          provider: existingConfig.provider,
          model: existingConfig.model,
          apiKey: existingConfig.apiKey,
          baseUrl: existingConfig.baseUrl,
          apiVersion: existingConfig.apiVersion,
          personality: existingConfig.personality,
          memory: existingConfig.memory,
          // Seed from the list form first (what setup now writes, B4); the
          // legacy scalars remain readable for configs written before it.
          // Values are secret refs, which `storeSecret` passes through.
          telegramToken: existingConfig.telegram?.bots?.[0]?.token ?? existingConfig.telegramToken,
          discordToken: existingConfig.discordToken,
          slackBotToken: existingConfig.slack?.apps?.[0]?.botToken ?? existingConfig.slackBotToken,
          slackAppToken: existingConfig.slack?.apps?.[0]?.appToken ?? existingConfig.slackAppToken,
          slackSigningSecret:
            existingConfig.slack?.apps?.[0]?.signingSecret ?? existingConfig.slackSigningSecret,
          emailImapHost: existingConfig.emailImapHost,
          emailImapPort: existingConfig.emailImapPort,
          emailUser: existingConfig.emailUser,
          emailPassword: existingConfig.emailPassword,
          emailSmtpHost: existingConfig.emailSmtpHost,
          emailSmtpPort: existingConfig.emailSmtpPort,
          providers: existingConfig.providers,
        }
      : null;

    const secrets = await getSecretsResolver();
    let result = await runSetupWizard({
      existing: existingAnswers,
      startAtStep,
      singleStep: !!startAtStep,
    });
    // The keyless step ends the wizard to run the Ollama install offer here,
    // after Ink has unmounted, because the install child inherits stdio. The
    // wizard then restarts once, without the install row, and finds the server.
    let installedOllama = false;
    if (result?.answers.keylessInstall) {
      installedOllama = await runInstallOfferInTerminal(secrets);
      result = await runSetupWizard({
        existing: existingAnswers,
        startAtStep,
        singleStep: !!startAtStep,
        offerInstall: false,
      });
    }
    if (!result) return null;

    const { answers } = result;
    const provider = answers.provider ?? 'anthropic';

    const apiKeyRef = answers.apiKey
      ? await storeSecret(secrets, `providers/${provider}/apiKey`, answers.apiKey)
      : '';

    // D15: setup ends with a user-owned born copy of the chosen built-in. A
    // single-step re-entry (`ethos setup messaging`) leaves personalities alone.
    await scaffoldEthosDir(storage);
    let extras: FirstRunOutcome | null = null;
    if (!startAtStep) {
      extras = await withTerminalPrompter((prompt) =>
        runFirstRunExtras({
          storage,
          dataDir: ethosDir(),
          builtinId: answers.personality ?? 'researcher',
          prompt,
          interactive: true,
        }),
      );
    }
    const personality = extras?.personality ?? answers.personality ?? 'researcher';
    const config: EthosConfig = {
      provider,
      model: answers.model ?? getDefaultModel(provider)?.modelId ?? 'claude-opus-5-5',
      apiKey: apiKeyRef,
      personality,
      memory: answers.memory,
      baseUrl: answers.baseUrl,
      apiVersion: answers.apiVersion,
      // Collision-free vault names, and a stored reference passes through.
      providers: answers.providers
        ? await externalizeProviderChain(answers.providers, secrets)
        : undefined,
      // B4 — the list forms the gateway reads natively; the legacy scalar
      // keys (`telegramToken`, `slackBotToken`, …) are the ones
      // `applyPlatformShim` deprecates on every boot.
      ...(await channelListConfig(answers, existingConfig, secrets, {
        type: 'personality',
        name: personality,
      })),
      discordToken: answers.discordToken
        ? await storeSecret(secrets, 'discord/token', answers.discordToken)
        : undefined,
      emailImapHost: answers.emailImapHost,
      emailImapPort: answers.emailImapPort,
      emailUser: answers.emailUser,
      emailPassword: answers.emailPassword
        ? await storeSecret(secrets, 'email/password', answers.emailPassword)
        : undefined,
      emailSmtpHost: answers.emailSmtpHost,
      emailSmtpPort: answers.emailSmtpPort,
      // Not a wizard question, but dropping it on a re-run would silently
      // turn every email sender unverified (`resolveEmailSender`).
      emailTrustedAuthservId: existingConfig?.emailTrustedAuthservId,
    };

    await writeConfig(storage, config, secrets);
    await sweepReplacedChainSecrets(existingConfig, config, secrets);
    await scaffoldEthosDir(storage);

    if (answers.rotationKeys && answers.rotationKeys.length > 0) {
      await writeKeys(storage, answers.rotationKeys, secrets);
    }

    let keylessPath: KeylessPath | undefined = answers.keylessPath;
    if (keylessPath === 'local' && installedOllama) keylessPath = 'installed';
    await recordSetupFunnel(config, 'tui', keylessPath);

    return {
      config,
      launch: result.launch,
      telegramUsername: answers.telegramUsername,
      // A task needs a chat; the gateway close keeps its own flow.
      ...(extras?.initialMessage && result.launch !== 'gateway'
        ? { initialMessage: extras.initialMessage, launch: 'chat' as const }
        : {}),
    };
  }

  const outcome = await runReadlineFallback({ storage, existing: existingConfig });
  if (outcome) await recordSetupFunnel(outcome.config, 'readline', outcome.keylessPath);
  if (!outcome) return null;
  return {
    config: outcome.config,
    launch: outcome.initialMessage ? 'chat' : 'done',
    ...(outcome.initialMessage ? { initialMessage: outcome.initialMessage } : {}),
  };
}

export type KeylessSetupResult =
  | { ok: true; config: EthosConfig; keylessPath: KeylessPath }
  | { ok: false; summary: string };

/**
 * `ethos setup --keyless` (plan §6.3, D23): non-interactive. Takes the first
 * `local` or `ethos-login` candidate and writes config through `writeConfig`.
 * It never imports an external login, never installs, never pulls (the only
 * calls are the probe and writeConfig; pinned by
 * __tests__/setup-keyless.test.ts "--keyless ... never imports"). With no such
 * candidate it returns the probe summary and writes nothing.
 *
 * Decision: it also creates the born copy under the default name ("My
 * Researcher") so the smoke script's first reply goes through the same agent a
 * person gets; no connectors, no first task.
 */
export async function runSetupKeyless(
  deps: { probe?: () => Promise<KeylessProbeResult>; builtinId?: string } = {},
): Promise<KeylessSetupResult> {
  const storage = getStorage();
  const secrets = await getSecretsResolver();
  const probe = await (deps.probe ?? (() => probeThisMachine(secrets)))();
  // A below-floor local candidate would throw at provider init (floor check in
  // extensions/llm-openai-compat/src/index.ts), so it is skipped here; its
  // summary line carries the served-vs-required tokens. Pinned by
  // setup-keyless.test.ts ("refuses a machine whose only local model is below the floor").
  const pick = probe.candidates.find(
    (cand) => (cand.kind === 'local' && !cand.belowContextFloor) || cand.kind === 'ethos-login',
  );
  if (!pick || (pick.kind !== 'local' && pick.kind !== 'ethos-login')) {
    const lines = probe.candidates.map((cand) => `  - ${describeCandidate(cand)}`);
    return {
      ok: false,
      summary: `No keyless model is ready (needs a running local model server or an existing ChatGPT sign-in).\n${lines.join('\n')}`,
    };
  }
  const preset =
    pick.kind === 'local'
      ? localPreset(pick, pick.models[0] ?? '', 'local')
      : codexPreset('ethos-login');

  const existing = await readRawConfig(storage);
  await scaffoldEthosDir(storage);
  if (!existing) {
    // Release smoke (§6.3) reads firstLaunchAt after `setup --keyless`, so a
    // first-ever run stamps it here too. Earliest-wins; fail-open.
    try {
      await getFunnelTracker().recordFirstLaunch();
    } catch {
      // telemetry must never fail setup
    }
  }
  const extras = await runFirstRunExtras({
    storage,
    dataDir: ethosDir(),
    builtinId: deps.builtinId ?? existing?.personality ?? 'researcher',
    prompt: { ask: async () => '', print: () => {} },
    interactive: false,
  });
  const config: EthosConfig = {
    ...(existing ?? {}),
    provider: preset.provider,
    model: preset.model,
    apiKey: preset.apiKey,
    personality: extras.personality,
    baseUrl: preset.baseUrl,
    apiVersion: undefined,
  };
  await writeConfig(storage, config, secrets);
  await recordSetupFunnel(config, 'readline', preset.keylessPath);
  return { ok: true, config, keylessPath: preset.keylessPath };
}

/** A readline prompter over the process terminal, closed when `fn` settles. */
async function withTerminalPrompter<T>(fn: (prompt: Prompter) => Promise<T>): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await fn({ ask: (q) => askRl(rl, q), print: (line) => console.log(line) });
  } finally {
    rl.close();
  }
}

/** Probe, run the install offer, report whether Ollama ended up usable. */
async function runInstallOfferInTerminal(
  secrets: import('@ethosagent/types').SecretsResolver,
): Promise<boolean> {
  const probe = await probeThisMachine(secrets);
  const outcome = await withTerminalPrompter((prompt) =>
    runInstallOfferFromProbe(probe, prompt, process.stdin.isTTY === true),
  );
  return outcome?.status === 'installed' || outcome?.status === 'pulled';
}

/** W4.1 — funnel.setup_completed fires at the end of runSetup. Best-effort. */
async function recordSetupFunnel(
  config: EthosConfig,
  wizardPath: 'tui' | 'readline',
  keylessPath?: KeylessPath,
) {
  try {
    await getFunnelTracker().recordSetupCompleted({
      provider: config.provider,
      channels: configuredChannels(config),
      wizardPath,
      ...(keylessPath ? { keylessPath } : {}),
    });
  } catch {
    // Funnel instrumentation must never fail setup.
  }
}

function configuredChannels(config: EthosConfig): string[] {
  const channels: string[] = [];
  if ((config.telegram?.bots?.length ?? 0) > 0 || config.telegramToken) channels.push('telegram');
  if (config.discordToken) channels.push('discord');
  if ((config.slack?.apps?.length ?? 0) > 0 || config.slackBotToken) channels.push('slack');
  if (config.emailImapHost && config.emailUser) channels.push('email');
  return channels;
}

/**
 * B4 — build the `telegram.bots.0.*` / `slack.apps.0.*` list forms from the
 * wizard's channel answers, so the serializer emits the keys the gateway
 * reads natively and a fresh `ethos setup` + `ethos gateway start` prints
 * zero deprecations. Tokens are externalized to the vault (idempotent — a
 * re-run hands back the stored reference). An answer left blank carries the
 * existing list over unchanged. Slack needs the botToken + signingSecret
 * pair at minimum (`SlackAppConfig`); a partial trio is not written.
 * Discord has no list form in the schema — `discordToken` is not deprecated
 * and stays a scalar. Exported for the B4 setup tests.
 *
 * Multi-bot guard: the wizard asks for ONE bot per platform, so its answer
 * can only ever describe a single-bot list. An existing list with more than
 * one entry, or any entry carrying an explicit `id:` (a stable botKey someone
 * chose on purpose), was hand-built for the gateway — a re-run must preserve
 * that platform's list untouched rather than flatten it to the one answer.
 */
export async function channelListConfig(
  answers: {
    telegramToken?: string;
    slackBotToken?: string;
    slackAppToken?: string;
    slackSigningSecret?: string;
  },
  existing: Pick<EthosConfig, 'telegram' | 'slack'> | null,
  secrets: import('@ethosagent/types').SecretsResolver,
  bind: BotBinding,
): Promise<Pick<EthosConfig, 'telegram' | 'slack'>> {
  const handBuilt = (list: readonly { id?: string }[] | undefined): boolean =>
    (list?.length ?? 0) > 1 || (list ?? []).some((entry) => entry.id !== undefined);

  const telegram =
    answers.telegramToken && !handBuilt(existing?.telegram?.bots)
      ? {
          bots: [
            { token: await storeSecret(secrets, 'telegram/token', answers.telegramToken), bind },
          ],
        }
      : existing?.telegram;
  const slack =
    answers.slackBotToken && answers.slackSigningSecret && !handBuilt(existing?.slack?.apps)
      ? {
          apps: [
            {
              botToken: await storeSecret(secrets, 'slack/botToken', answers.slackBotToken),
              ...(answers.slackAppToken
                ? { appToken: await storeSecret(secrets, 'slack/appToken', answers.slackAppToken) }
                : {}),
              signingSecret: await storeSecret(
                secrets,
                'slack/signingSecret',
                answers.slackSigningSecret,
              ),
              bind,
            },
          ],
        }
      : existing?.slack;
  return { ...(telegram ? { telegram } : {}), ...(slack ? { slack } : {}) };
}

/**
 * Vault entries the chain the wizard just replaced was the only holder of.
 * Index-named (`isProviderChainSecretRef`) only — a canonical
 * `providers/<provider>/apiKey` is read by name by the provider factories and
 * tools, so config.yaml not naming it says nothing. Runs AFTER the write, so a
 * failed write leaves the vault intact; a failed delete is reported, never
 * fatal (the config change already landed).
 */
async function sweepReplacedChainSecrets(
  before: EthosConfig | null,
  after: EthosConfig,
  secrets: import('@ethosagent/types').SecretsResolver,
): Promise<void> {
  if (!before?.providers?.length) return;
  const kept = new Set<string>();
  for (const value of [after.apiKey, ...(after.providers ?? []).map((p) => p.apiKey)]) {
    const ref = value ? secretRefFromValue(value) : null;
    if (ref) kept.add(ref);
  }
  for (const entry of before.providers) {
    const ref = secretRefFromValue(entry.apiKey);
    if (!ref || kept.has(ref) || !isProviderChainSecretRef(ref)) continue;
    try {
      await secrets.delete(ref);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `${c.yellow}⚠ Stored key material for the replaced fallback chain was not deleted:${c.reset} ${msg}\n` +
          `${c.dim}  Remove it with: ethos secrets remove ${ref}${c.reset}`,
      );
    }
  }
}
