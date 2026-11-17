import type { SecretsResolver } from '@ethosagent/types';
import type { WebhookHookConfig } from './builders/webhooks';
import type { EthosConfig } from './config-types';
import { adoptConfigNotices } from './notices';
import { resolveSecretValue } from './secrets';

export async function resolveConfigSecrets(
  config: EthosConfig,
  secrets: SecretsResolver,
): Promise<EthosConfig> {
  const r = { ...config };
  // This clone sits on the `readConfig` path every CLI command uses, so the
  // identity-keyed parse notices must travel with it — without this, chat
  // printed zero B2 warnings while status/doctor (readRawConfig, original
  // object) showed them.
  adoptConfigNotices(r, config);
  r.apiKey = await resolveSecretValue(r.apiKey, secrets);
  if (r.baseUrl) r.baseUrl = await resolveSecretValue(r.baseUrl, secrets);
  if (r.telegramToken) r.telegramToken = await resolveSecretValue(r.telegramToken, secrets);
  if (r.discordToken) r.discordToken = await resolveSecretValue(r.discordToken, secrets);
  if (r.slackBotToken) r.slackBotToken = await resolveSecretValue(r.slackBotToken, secrets);
  if (r.slackAppToken) r.slackAppToken = await resolveSecretValue(r.slackAppToken, secrets);
  if (r.slackSigningSecret)
    r.slackSigningSecret = await resolveSecretValue(r.slackSigningSecret, secrets);
  if (r.emailPassword) r.emailPassword = await resolveSecretValue(r.emailPassword, secrets);
  if (r.providers) {
    r.providers = await Promise.all(
      r.providers.map(async (p) => ({
        ...p,
        apiKey: await resolveSecretValue(p.apiKey, secrets),
      })),
    );
  }
  if (r.telegram?.bots) {
    r.telegram = {
      ...r.telegram,
      bots: await Promise.all(
        r.telegram.bots.map(async (bot) => ({
          ...bot,
          token: await resolveSecretValue(bot.token, secrets),
          ...(bot.webhookSecretToken !== undefined
            ? { webhookSecretToken: await resolveSecretValue(bot.webhookSecretToken, secrets) }
            : {}),
        })),
      ),
    };
  }
  if (r.slack?.apps) {
    r.slack = {
      ...r.slack,
      apps: await Promise.all(
        r.slack.apps.map(async (app) => ({
          ...app,
          botToken: await resolveSecretValue(app.botToken, secrets),
          // `appToken` is optional now (HTTP-mode apps have none), so it is
          // only resolved when present.
          ...(app.appToken !== undefined
            ? { appToken: await resolveSecretValue(app.appToken, secrets) }
            : {}),
          signingSecret: await resolveSecretValue(app.signingSecret, secrets),
        })),
      ),
    };
  }
  if (r.auxiliary?.compression?.apiKey) {
    r.auxiliary = {
      ...r.auxiliary,
      compression: {
        ...r.auxiliary.compression,
        apiKey: await resolveSecretValue(r.auxiliary.compression.apiKey, secrets),
      },
    };
  }
  if (r.auxiliary?.vision?.apiKey) {
    r.auxiliary = {
      ...r.auxiliary,
      vision: {
        ...r.auxiliary.vision,
        apiKey: await resolveSecretValue(r.auxiliary.vision.apiKey, secrets),
      },
    };
  }
  if (r.auxiliary?.web?.apiKey) {
    r.auxiliary = {
      ...r.auxiliary,
      web: {
        ...r.auxiliary.web,
        apiKey: await resolveSecretValue(r.auxiliary.web.apiKey, secrets),
      },
    };
  }
  if (r.auxiliary?.asr?.apiKey) {
    r.auxiliary = {
      ...r.auxiliary,
      asr: {
        ...r.auxiliary.asr,
        apiKey: await resolveSecretValue(r.auxiliary.asr.apiKey, secrets),
      },
    };
  }
  if (r.auxiliary?.tts?.apiKey) {
    r.auxiliary = {
      ...r.auxiliary,
      tts: {
        ...r.auxiliary.tts,
        apiKey: await resolveSecretValue(r.auxiliary.tts.apiKey, secrets),
      },
    };
  }
  if (r.voice?.livekit) {
    r.voice = {
      ...r.voice,
      livekit: {
        ...r.voice.livekit,
        apiKey: await resolveSecretValue(r.voice.livekit.apiKey, secrets),
        apiSecret: await resolveSecretValue(r.voice.livekit.apiSecret, secrets),
      },
    };
  }
  if (r.voice?.trunk) {
    const trunk = r.voice.trunk;
    r.voice = {
      ...r.voice,
      trunk: {
        ...trunk,
        ...(trunk.password ? { password: await resolveSecretValue(trunk.password, secrets) } : {}),
        ...(trunk.webhookSecret
          ? { webhookSecret: await resolveSecretValue(trunk.webhookSecret, secrets) }
          : {}),
      },
    };
  }
  const resolveRoster = async <E extends { apiKey?: string }>(
    roster: Record<string, E>,
  ): Promise<Record<string, E>> => {
    const out: Record<string, E> = {};
    for (const [name, entry] of Object.entries(roster)) {
      out[name] = entry.apiKey
        ? { ...entry, apiKey: await resolveSecretValue(entry.apiKey, secrets) }
        : entry;
    }
    return out;
  };
  if (r.voice?.tts?.providers) {
    r.voice = { ...r.voice, tts: { providers: await resolveRoster(r.voice.tts.providers) } };
  }
  if (r.voice?.stt?.providers) {
    r.voice = { ...r.voice, stt: { providers: await resolveRoster(r.voice.stt.providers) } };
  }
  if (r.voice?.realtime?.providers) {
    r.voice = {
      ...r.voice,
      realtime: {
        ...r.voice.realtime,
        providers: await resolveRoster(r.voice.realtime.providers),
      },
    };
  }
  if (r.webhooks) {
    const hooks: Record<string, WebhookHookConfig> = {};
    for (const [id, hook] of Object.entries(r.webhooks)) {
      hooks[id] = {
        ...hook,
        secret: await resolveSecretValue(hook.secret, secrets),
        ...(hook.hmac
          ? {
              hmac: {
                ...hook.hmac,
                secret: await resolveSecretValue(hook.hmac.secret, secrets),
                ...(hook.hmac.previousSecret
                  ? { previousSecret: await resolveSecretValue(hook.hmac.previousSecret, secrets) }
                  : {}),
              },
            }
          : {}),
      };
    }
    r.webhooks = hooks;
  }
  if (r.telemetry?.export?.langfuse?.secretKey) {
    const lf = r.telemetry.export.langfuse;
    const secretKey = r.telemetry.export.langfuse.secretKey;
    r.telemetry = {
      ...r.telemetry,
      export: {
        ...r.telemetry.export,
        langfuse: { ...lf, secretKey: await resolveSecretValue(secretKey, secrets) },
      },
    };
  }
  if (r.telemetry?.export?.otlp?.headers) {
    const otlp = r.telemetry.export.otlp;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(otlp.headers ?? {})) {
      headers[name] = await resolveSecretValue(value, secrets);
    }
    r.telemetry = {
      ...r.telemetry,
      export: { ...r.telemetry.export, otlp: { ...otlp, headers } },
    };
  }
  if (r.memoryCapture?.apiKey) {
    r.memoryCapture = {
      ...r.memoryCapture,
      apiKey: await resolveSecretValue(r.memoryCapture.apiKey, secrets),
    };
  }
  if (r.pauseLifecycle?.http?.token) {
    const http = r.pauseLifecycle.http;
    const token = r.pauseLifecycle.http.token;
    r.pauseLifecycle = {
      ...r.pauseLifecycle,
      http: { ...http, token: await resolveSecretValue(token, secrets) },
    };
  }
  if (r.browser?.proxy?.password) {
    const proxy = r.browser.proxy;
    const password = r.browser.proxy.password;
    r.browser = {
      ...r.browser,
      proxy: { ...proxy, password: await resolveSecretValue(password, secrets) },
    };
  }
  return r;
}
