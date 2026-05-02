import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { WizardStepId } from '@ethosagent/tui/setup';
import { type EthosConfig, ethosDir, readConfig, writeConfig, writeKeys } from '../config';
import { getStorage } from '../wiring';

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

export async function runSetup(startAtStep?: WizardStepId): Promise<EthosConfig | null> {
  const storage = getStorage();
  const existingConfig = await readConfig(storage);

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { runSetupWizard } = await import('@ethosagent/tui/setup');

    const existingAnswers = existingConfig
      ? {
          provider: existingConfig.provider,
          model: existingConfig.model,
          apiKey: existingConfig.apiKey,
          baseUrl: existingConfig.baseUrl,
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

    const result = await runSetupWizard({ existing: existingAnswers, startAtStep });
    if (!result) return null;

    const { answers } = result;
    const config: EthosConfig = {
      provider: answers.provider ?? 'anthropic',
      model: answers.model ?? 'claude-opus-4-7',
      apiKey: answers.apiKey ?? '',
      personality: answers.personality ?? 'researcher',
      memory: answers.memory,
      baseUrl: answers.baseUrl,
      providers: answers.providers,
      telegramToken: answers.telegramToken,
      discordToken: answers.discordToken,
      slackBotToken: answers.slackBotToken,
      slackAppToken: answers.slackAppToken,
      slackSigningSecret: answers.slackSigningSecret,
      emailImapHost: answers.emailImapHost,
      emailImapPort: answers.emailImapPort,
      emailUser: answers.emailUser,
      emailPassword: answers.emailPassword,
      emailSmtpHost: answers.emailSmtpHost,
      emailSmtpPort: answers.emailSmtpPort,
    };

    await writeConfig(storage, config);
    await scaffoldEthosDir(storage);

    if (answers.rotationKeys && answers.rotationKeys.length > 0) {
      await writeKeys(storage, answers.rotationKeys);
    }

    return config;
  }

  return runReadlineFallback({ storage, existing: existingConfig });
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

  console.log(
    `${c.dim}Supported providers: anthropic, openai-compat (OpenRouter / Ollama / Gemini)${c.reset}`,
  );
  const provider = (await ask(rl, 'Provider (anthropic): ')).trim() || 'anthropic';

  const defaultModel = provider === 'anthropic' ? 'claude-opus-4-7' : 'openai/gpt-4o';
  const model = (await ask(rl, `Model (${defaultModel}): `)).trim() || defaultModel;

  const apiKey = (await ask(rl, 'API key: ')).trim();
  if (!apiKey) {
    console.log(
      `${c.yellow}Warning: no API key entered. Edit ~/.ethos/config.yaml to add one.${c.reset}`,
    );
  }

  let baseUrl: string | undefined;
  if (provider !== 'anthropic') {
    baseUrl =
      (await ask(rl, 'Base URL (https://openrouter.ai/api/v1): ')).trim() ||
      'https://openrouter.ai/api/v1';
  }

  console.log(
    `\n${c.dim}Personalities: researcher · engineer · reviewer · coach · operator${c.reset}`,
  );
  const personality = (await ask(rl, 'Default personality (researcher): ')).trim() || 'researcher';

  rl.close();

  const config: EthosConfig = { provider, model, apiKey, personality, baseUrl };
  await writeConfig(storage, config);
  await scaffoldEthosDir(storage);

  console.log(`\n${c.green}✓ Config saved to ~/.ethos/config.yaml${c.reset}`);
  console.log(`${c.green}✓ ~/.ethos/ directory ready${c.reset}`);
  console.log(
    `\n${c.dim}Run ${c.reset}${c.bold}ethos${c.reset}${c.dim} to start chatting.${c.reset}\n`,
  );

  return config;
}
