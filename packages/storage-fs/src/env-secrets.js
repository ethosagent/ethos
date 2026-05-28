import { readFileSync } from 'node:fs';
// ---------------------------------------------------------------------------
// Recognition table: env var name → secret ref
// ---------------------------------------------------------------------------
export const ENV_TO_REF = {
  ANTHROPIC_API_KEY: 'providers/anthropic/apiKey',
  AZURE_API_KEY: 'providers/azure/apiKey',
  OPENAI_API_KEY: 'providers/openai/apiKey',
  OPENROUTER_API_KEY: 'providers/openrouter/apiKey',
  GEMINI_API_KEY: 'providers/gemini/apiKey',
  GROQ_API_KEY: 'providers/groq/apiKey',
  DEEPSEEK_API_KEY: 'providers/deepseek/apiKey',
  OLLAMA_HOST: 'providers/ollama/host',
  EXA_API_KEY: 'providers/exa/apiKey',
  REPLICATE_API_TOKEN: 'providers/replicate/apiToken',
  TELEGRAM_BOT_TOKEN: 'channels/telegram/default/botToken',
  SLACK_BOT_TOKEN: 'channels/slack/default/botToken',
  SLACK_APP_TOKEN: 'channels/slack/default/appToken',
  SLACK_SIGNING_SECRET: 'channels/slack/default/signingSecret',
  DISCORD_BOT_TOKEN: 'channels/discord/default/botToken',
  WHATSAPP_ACCESS_TOKEN: 'channels/whatsapp/default/accessToken',
  WHATSAPP_PHONE_NUMBER_ID: 'channels/whatsapp/default/phoneNumberId',
  SMTP_HOST: 'channels/email/default/smtp/host',
  SMTP_PORT: 'channels/email/default/smtp/port',
  SMTP_USER: 'channels/email/default/smtp/user',
  SMTP_PASSWORD: 'channels/email/default/smtp/password',
  IMAP_HOST: 'channels/email/default/imap/host',
  IMAP_USER: 'channels/email/default/imap/user',
  IMAP_PASSWORD: 'channels/email/default/imap/password',
};
// ---------------------------------------------------------------------------
// Pattern matchers for multi-bot env vars
// ---------------------------------------------------------------------------
export const ENV_PATTERNS = [
  {
    re: /^TELEGRAM_BOT_TOKEN_(?<botKey>[A-Za-z0-9_]+)$/,
    ref: (m) => `channels/telegram/${m.groups?.botKey ?? ''}/botToken`,
  },
  {
    re: /^SLACK_BOT_TOKEN_(?<botKey>[A-Za-z0-9_]+)$/,
    ref: (m) => `channels/slack/${m.groups?.botKey ?? ''}/botToken`,
  },
  {
    re: /^SLACK_APP_TOKEN_(?<botKey>[A-Za-z0-9_]+)$/,
    ref: (m) => `channels/slack/${m.groups?.botKey ?? ''}/appToken`,
  },
  {
    re: /^DISCORD_BOT_TOKEN_(?<botKey>[A-Za-z0-9_]+)$/,
    ref: (m) => `channels/discord/${m.groups?.botKey ?? ''}/botToken`,
  },
];
// ---------------------------------------------------------------------------
// Inverted index: secret ref → env var name (for fast lookups)
// ---------------------------------------------------------------------------
const REF_TO_ENV = new Map();
for (const [envKey, ref] of Object.entries(ENV_TO_REF)) {
  REF_TO_ENV.set(ref, envKey);
}

export { REF_TO_ENV };

// ---------------------------------------------------------------------------
// Reverse pattern matchers: secret ref → env var name
// ---------------------------------------------------------------------------
const REF_PATTERNS = [
  { re: /^channels\/telegram\/([^/]+)\/botToken$/, envKey: (m) => `TELEGRAM_BOT_TOKEN_${m[1]}` },
  { re: /^channels\/slack\/([^/]+)\/botToken$/, envKey: (m) => `SLACK_BOT_TOKEN_${m[1]}` },
  { re: /^channels\/slack\/([^/]+)\/appToken$/, envKey: (m) => `SLACK_APP_TOKEN_${m[1]}` },
  { re: /^channels\/discord\/([^/]+)\/botToken$/, envKey: (m) => `DISCORD_BOT_TOKEN_${m[1]}` },
];
// ---------------------------------------------------------------------------
// resolveEnvKey: env var name → secret ref (or null)
// ---------------------------------------------------------------------------
export function resolveEnvKey(envKey) {
  const literal = ENV_TO_REF[envKey];
  if (literal !== undefined) return literal;
  for (const pattern of ENV_PATTERNS) {
    const m = envKey.match(pattern.re);
    if (m) return pattern.ref(m);
  }
  return null;
}
// ---------------------------------------------------------------------------
// EnvSecretsResolver
// ---------------------------------------------------------------------------
export class EnvSecretsResolver {
  async get(ref) {
    // Check inverted index first
    const envKey = REF_TO_ENV.get(ref);
    if (envKey !== undefined) {
      const val = process.env[envKey];
      return val !== undefined ? val : null;
    }
    // Reverse pattern matching for multi-bot refs
    for (const pattern of REF_PATTERNS) {
      const m = ref.match(pattern.re);
      if (m) {
        const val = process.env[pattern.envKey(m)];
        return val !== undefined ? val : null;
      }
    }
    return null;
  }
  async set(_ref, _value) {
    throw new Error('EnvSecretsResolver is read-only — env-sourced values cannot be set');
  }
  async delete(_ref) {
    throw new Error('EnvSecretsResolver is read-only — env-sourced values cannot be deleted');
  }
  async list(prefix) {
    const refs = new Set();
    // Recognized refs from ENV_TO_REF that are set in process.env
    for (const [envKey, ref] of Object.entries(ENV_TO_REF)) {
      if (process.env[envKey] !== undefined) {
        refs.add(ref);
      }
    }
    // Pattern-matched refs for env vars matching multi-bot patterns
    for (const key of Object.keys(process.env)) {
      // Skip keys already in ENV_TO_REF
      if (ENV_TO_REF[key] !== undefined) continue;
      for (const pattern of ENV_PATTERNS) {
        const m = key.match(pattern.re);
        if (m) {
          refs.add(pattern.ref(m));
          break;
        }
      }
    }
    const all = [...refs];
    if (!prefix) return all;
    return all.filter((r) => r.startsWith(prefix));
  }
}
// ---------------------------------------------------------------------------
// MergedSecretsResolver — env wins, file is fallback
// ---------------------------------------------------------------------------
export class MergedSecretsResolver {
  readers;
  writer;
  constructor(opts) {
    this.readers = opts.readers;
    this.writer = opts.writer;
  }
  async get(ref) {
    for (const resolver of this.readers) {
      const val = await resolver.get(ref);
      if (val !== null) return val;
    }
    return null;
  }
  async set(ref, value) {
    return this.writer.set(ref, value);
  }
  async delete(ref) {
    return this.writer.delete(ref);
  }
  async list(prefix) {
    const results = await Promise.all(this.readers.map((r) => r.list(prefix)));
    return [...new Set(results.flat())];
  }
}
// ---------------------------------------------------------------------------
// loadDotEnv — inline .env parser (no dotenv dep)
// ---------------------------------------------------------------------------
export function loadDotEnv(path) {
  let content;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
