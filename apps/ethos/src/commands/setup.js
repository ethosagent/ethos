import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ethosDir, readRawConfig, writeConfig, writeKeys } from '../config';
import { getSecretsResolver, getStorage } from '../wiring';
const c = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
};
function ask(rl, question) {
    return new Promise((resolve) => rl.question(question, resolve));
}
export async function runSetup(startAtStep) {
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
        if (!result)
            return null;
        const { answers } = result;
        const secrets = await getSecretsResolver();
        const provider = answers.provider ?? 'anthropic';
        let apiKeyRef = '';
        if (answers.apiKey) {
            const ref = `providers/${provider}/apiKey`;
            await secrets.set(ref, answers.apiKey);
            apiKeyRef = `\${secrets:${ref}}`;
        }
        const config = {
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
async function scaffoldEthosDir(storage) {
    const dir = ethosDir();
    await storage.mkdir(join(dir, 'personalities'));
    for (const filename of ['MEMORY.md', 'USER.md']) {
        const path = join(dir, filename);
        if (!(await storage.exists(path))) {
            await storage.write(path, '');
        }
    }
}
async function runReadlineFallback({ storage, existing, }) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (existing) {
        const ans = await ask(rl, `${c.yellow}Config already exists at ~/.ethos/config.yaml. Overwrite? (y/N)${c.reset} `);
        if (ans.trim().toLowerCase() !== 'y') {
            console.log(`${c.dim}Keeping existing config.${c.reset}`);
            rl.close();
            return existing;
        }
    }
    console.log(`\n${c.cyan}${c.bold}ethos setup${c.reset}\n`);
    console.log(`${c.dim}Supported providers: anthropic, openai-compat (OpenRouter / Ollama / Gemini), azure${c.reset}`);
    const provider = (await ask(rl, 'Provider (anthropic): ')).trim() || 'anthropic';
    const defaultModel = provider === 'anthropic'
        ? 'claude-opus-4-7'
        : provider === 'azure'
            ? 'gpt-5.4'
            : 'openai/gpt-4o';
    const modelPrompt = provider === 'azure'
        ? `Azure deployment name (${defaultModel}): `
        : `Model (${defaultModel}): `;
    const model = (await ask(rl, modelPrompt)).trim() || defaultModel;
    const apiKey = (await ask(rl, 'API key: ')).trim();
    if (!apiKey) {
        console.log(`${c.yellow}Warning: no API key entered. Edit ~/.ethos/config.yaml to add one.${c.reset}`);
    }
    let baseUrl;
    let apiVersion;
    if (provider === 'azure') {
        baseUrl = (await ask(rl, 'Azure endpoint (e.g. https://my-resource.openai.azure.com): ')).trim();
        if (!baseUrl) {
            console.log(`${c.yellow}Warning: no Azure endpoint entered. Edit ~/.ethos/config.yaml to add one.${c.reset}`);
        }
        apiVersion = (await ask(rl, 'API version (2024-10-21): ')).trim() || undefined;
    }
    else if (provider !== 'anthropic') {
        baseUrl =
            (await ask(rl, 'Base URL (https://openrouter.ai/api/v1): ')).trim() ||
                'https://openrouter.ai/api/v1';
    }
    console.log(`\n${c.dim}Personalities: researcher · engineer · reviewer · coach · operator${c.reset}`);
    const personality = (await ask(rl, 'Default personality (researcher): ')).trim() || 'researcher';
    rl.close();
    let apiKeyRef = '';
    if (apiKey) {
        const secrets = await getSecretsResolver();
        const ref = `providers/${provider}/apiKey`;
        await secrets.set(ref, apiKey);
        apiKeyRef = `\${secrets:${ref}}`;
    }
    const config = {
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
    console.log(`\n${c.dim}Run ${c.reset}${c.bold}ethos${c.reset}${c.dim} to start chatting.${c.reset}\n`);
    return config;
}
async function storeSecret(secrets, ref, value) {
    await secrets.set(ref, value);
    return `\${secrets:${ref}}`;
}
async function storeProviderSecrets(providers, secrets) {
    return Promise.all(providers.map(async (p, i) => ({
        ...p,
        apiKey: p.apiKey
            ? await storeSecret(secrets, `providers/${i}/${p.provider}/apiKey`, p.apiKey)
            : '',
    })));
}
