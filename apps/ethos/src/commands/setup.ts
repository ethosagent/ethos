import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type EthosConfig,
  ethosDir,
  readRawConfig,
  writeConfig,
  writeKeys,
} from '@ethosagent/config';
import type { WizardStepId } from '@ethosagent/tui/setup';
import { fetchLocalModels } from '@ethosagent/wiring/local-models';
import { getProvider } from '@ethosagent/wiring/provider-catalog';
import { getSecretsResolver, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

export interface SetupResult {
  config: EthosConfig;
  launchChat: boolean;
}

/** Providers that run against a local OpenAI-compatible endpoint: default the
 *  base URL to localhost, skip the API-key prompt, and offer the served model
 *  list from `GET /v1/models`. */
const LOCAL_PROVIDERS = new Set(['ollama', 'vllm']);

/** Placeholder API key written for local endpoints, which ignore it. */
const LOCAL_API_KEY = 'local';

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
          telegramToken: existingConfig.telegramToken,
          discordToken: existingConfig.discordToken,
          slackBotToken: existingConfig.slackBotToken,
          slackAppToken: existingConfig.slackAppToken,
          slackSigningSecret: existingConfig.slackSigningSecret,
          emailImapHost: existingConfig.emailImapHost,
          emailImapPort: existingConfig.emailImapPort,
          emailUser: existingConfig.emailUser,
          emailPassword: existingConfig.emailPassword,
          emailSmtpHost: existingConfig.emailSmtpHost,
          emailSmtpPort: existingConfig.emailSmtpPort,
          providers: existingConfig.providers,
        }
      : null;

    const result = await runSetupWizard({
      existing: existingAnswers,
      startAtStep,
      singleStep: !!startAtStep,
    });
    if (!result) return null;

    const { answers } = result;
    const secrets = await getSecretsResolver();
    const provider = answers.provider ?? 'anthropic';

    let apiKeyRef = '';
    if (answers.apiKey) {
      const ref = `providers/${provider}/apiKey`;
      await secrets.set(ref, answers.apiKey);
      apiKeyRef = `\${secrets:${ref}}`;
    }

    const config: EthosConfig = {
      provider,
      model: answers.model ?? 'claude-opus-4-7',
      apiKey: apiKeyRef,
      personality: answers.personality ?? 'researcher',
      memory: answers.memory,
      baseUrl: answers.baseUrl,
      apiVersion: answers.apiVersion,
      providers: answers.providers
        ? await storeProviderSecrets(answers.providers, secrets)
        : undefined,
      telegramToken: answers.telegramToken
        ? await storeSecret(secrets, 'telegram/token', answers.telegramToken)
        : undefined,
      discordToken: answers.discordToken
        ? await storeSecret(secrets, 'discord/token', answers.discordToken)
        : undefined,
      slackBotToken: answers.slackBotToken
        ? await storeSecret(secrets, 'slack/botToken', answers.slackBotToken)
        : undefined,
      slackAppToken: answers.slackAppToken
        ? await storeSecret(secrets, 'slack/appToken', answers.slackAppToken)
        : undefined,
      slackSigningSecret: answers.slackSigningSecret
        ? await storeSecret(secrets, 'slack/signingSecret', answers.slackSigningSecret)
        : undefined,
      emailImapHost: answers.emailImapHost,
      emailImapPort: answers.emailImapPort,
      emailUser: answers.emailUser,
      emailPassword: answers.emailPassword
        ? await storeSecret(secrets, 'email/password', answers.emailPassword)
        : undefined,
      emailSmtpHost: answers.emailSmtpHost,
      emailSmtpPort: answers.emailSmtpPort,
    };

    await writeConfig(storage, config);
    await scaffoldEthosDir(storage);

    if (answers.rotationKeys && answers.rotationKeys.length > 0) {
      await writeKeys(storage, answers.rotationKeys);
    }

    return { config, launchChat: result.launchChat };
  }

  const config = await runReadlineFallback({ storage, existing: existingConfig });
  return config ? { config, launchChat: false } : null;
}

async function scaffoldEthosDir(storage: ReturnType<typeof getStorage>) {
  const dir = ethosDir();
  await storage.mkdir(join(dir, 'personalities'));
  for (const filename of ['MEMORY.md', 'USER.md']) {
    const path = join(dir, filename);
    if (!(await storage.exists(path))) {
      await storage.write(path, '');
    }
  }
}

async function runReadlineFallback({
  storage,
  existing,
}: {
  storage: ReturnType<typeof getStorage>;
  existing: EthosConfig | null;
}): Promise<EthosConfig | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  if (existing) {
    const ans = await ask(
      rl,
      `${c.yellow}Config already exists at ~/.ethos/config.yaml. Overwrite? (y/N)${c.reset} `,
    );
    if (ans.trim().toLowerCase() !== 'y') {
      console.log(`${c.dim}Keeping existing config.${c.reset}`);
      rl.close();
      return existing;
    }
  }

  console.log(`\n${c.cyan}${c.bold}ethos setup${c.reset}\n`);

  console.log(`${c.dim}Supported providers: anthropic, openrouter, ollama, vllm, azure${c.reset}`);
  const provider = (await ask(rl, 'Provider (anthropic): ')).trim() || 'anthropic';

  let model: string;
  let apiKey: string;
  let baseUrl: string | undefined;
  let apiVersion: string | undefined;

  if (LOCAL_PROVIDERS.has(provider)) {
    // Local OpenAI-compatible endpoint (Ollama / vLLM): localhost base URL,
    // no API-key prompt, model list offered from GET /v1/models when reachable.
    const defaultBaseUrl = getProvider(provider)?.defaultBaseUrl ?? 'http://localhost:11434/v1';
    baseUrl = (await ask(rl, `Base URL (${defaultBaseUrl}): `)).trim() || defaultBaseUrl;
    apiKey = LOCAL_API_KEY;

    console.log(`${c.dim}Checking ${baseUrl} for available models…${c.reset}`);
    const { reachable, models } = await fetchLocalModels(baseUrl);
    if (reachable) {
      console.log(`${c.dim}Available models:${c.reset}`);
      for (const [i, m] of models.entries()) {
        console.log(`  ${c.bold}${i + 1}${c.reset}. ${m}`);
      }
      const firstModel = models[0] ?? '';
      const choice = (
        await ask(rl, `Model (1-${models.length}, or name) [${firstModel}]: `)
      ).trim();
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
      model = (await ask(rl, 'Model: ')).trim();
    }
  } else {
    const defaultModel =
      provider === 'anthropic'
        ? 'claude-opus-4-7'
        : provider === 'azure'
          ? 'gpt-5.4'
          : 'openai/gpt-4o';
    const modelPrompt =
      provider === 'azure'
        ? `Azure deployment name (${defaultModel}): `
        : `Model (${defaultModel}): `;
    model = (await ask(rl, modelPrompt)).trim() || defaultModel;

    apiKey = (await ask(rl, 'API key: ')).trim();
    if (!apiKey) {
      console.log(
        `${c.yellow}Warning: no API key entered. Edit ~/.ethos/config.yaml to add one.${c.reset}`,
      );
    }

    if (provider === 'azure') {
      baseUrl = (
        await ask(rl, 'Azure endpoint (e.g. https://my-resource.openai.azure.com): ')
      ).trim();
      if (!baseUrl) {
        console.log(
          `${c.yellow}Warning: no Azure endpoint entered. Edit ~/.ethos/config.yaml to add one.${c.reset}`,
        );
      }
      apiVersion = (await ask(rl, 'API version (2024-10-21): ')).trim() || undefined;
    } else if (provider !== 'anthropic') {
      baseUrl =
        (await ask(rl, 'Base URL (https://openrouter.ai/api/v1): ')).trim() ||
        'https://openrouter.ai/api/v1';
    }
  }

  console.log(
    `\n${c.dim}Personalities: researcher · engineer · reviewer · coach · operator${c.reset}`,
  );
  const personality = (await ask(rl, 'Default personality (researcher): ')).trim() || 'researcher';

  rl.close();

  let apiKeyRef = '';
  if (apiKey) {
    const secrets = await getSecretsResolver();
    const ref = `providers/${provider}/apiKey`;
    await secrets.set(ref, apiKey);
    apiKeyRef = `\${secrets:${ref}}`;
  }

  const config: EthosConfig = {
    provider,
    model,
    apiKey: apiKeyRef,
    personality,
    baseUrl,
    apiVersion,
  };
  await writeConfig(storage, config);
  await scaffoldEthosDir(storage);

  console.log(`\n${c.green}✓ Config saved to ~/.ethos/config.yaml${c.reset}`);
  console.log(`${c.green}✓ ~/.ethos/ directory ready${c.reset}`);
  console.log(
    `\n${c.dim}Run ${c.reset}${c.bold}ethos${c.reset}${c.dim} to start chatting.${c.reset}\n`,
  );

  return config;
}

async function storeSecret(
  secrets: import('@ethosagent/types').SecretsResolver,
  ref: string,
  value: string,
): Promise<string> {
  await secrets.set(ref, value);
  return `\${secrets:${ref}}`;
}

async function storeProviderSecrets(
  providers: Array<{ provider: string; apiKey: string; model?: string; baseUrl?: string }>,
  secrets: import('@ethosagent/types').SecretsResolver,
): Promise<Array<{ provider: string; apiKey: string; model?: string; baseUrl?: string }>> {
  return Promise.all(
    providers.map(async (p, i) => ({
      ...p,
      apiKey: p.apiKey
        ? await storeSecret(secrets, `providers/${i}/${p.provider}/apiKey`, p.apiKey)
        : '',
    })),
  );
}
