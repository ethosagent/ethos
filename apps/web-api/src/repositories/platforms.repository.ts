import { createHash } from 'node:crypto';
import type { SecretsResolver } from '@ethosagent/types';
import type {
  BotBinding,
  PlatformId,
  PlatformStatus,
  SlackAppEntry,
  TelegramBotEntry,
} from '@ethosagent/web-contracts';
import type { ConfigRepository, RawConfig } from './config.repository';

// Per-platform connection inventory + setup over the same
// ~/.ethos/config.yaml the gateway reads. Keys are flat
// (telegramToken, slackBotToken, …); the repository owns the per-
// platform field-name mapping so the service never knows about it.
//
// Secret-shaped fields (tokens, passwords, signing secrets) round
// through the injected SecretsResolver: the plaintext lands in
// ~/.ethos/secrets/<ref>, and the passthrough YAML stores only
// `${secrets:<ref>}`. The gateway's resolveConfigSecrets() inlines
// these at boot. Non-secret fields (imap host/port, user) stay as
// plaintext in passthrough — they aren't sensitive.
//
// Sensitive values never leave this layer — the repository only emits
// PlatformStatus { configured, fields: { name → bool } } and never
// returns raw token values to callers.

interface PlatformDefinition {
  /** Form field names the UI uses. */
  fields: readonly string[];
  /** Field name → flat key in config.yaml. */
  toConfigKey: Record<string, string>;
  /** Field name → secret ref path (under ~/.ethos/secrets/). Fields
   *  not listed here are stored as plaintext in passthrough. */
  secretRef: Record<string, string>;
}

const PLATFORMS: Record<PlatformId, PlatformDefinition> = {
  telegram: {
    fields: ['token'],
    toConfigKey: { token: 'telegramToken' },
    secretRef: { token: 'telegram/token' },
  },
  discord: {
    fields: ['token'],
    toConfigKey: { token: 'discordToken' },
    secretRef: { token: 'discord/token' },
  },
  slack: {
    fields: ['botToken', 'appToken', 'signingSecret'],
    toConfigKey: {
      botToken: 'slackBotToken',
      appToken: 'slackAppToken',
      signingSecret: 'slackSigningSecret',
    },
    secretRef: {
      botToken: 'slack/botToken',
      appToken: 'slack/appToken',
      signingSecret: 'slack/signingSecret',
    },
  },
  email: {
    fields: ['imapHost', 'imapPort', 'user', 'password', 'smtpHost', 'smtpPort'],
    toConfigKey: {
      imapHost: 'emailImapHost',
      imapPort: 'emailImapPort',
      user: 'emailUser',
      password: 'emailPassword',
      smtpHost: 'emailSmtpHost',
      smtpPort: 'emailSmtpPort',
    },
    secretRef: {
      password: 'email/password',
    },
  },
};

const ALL_PLATFORM_IDS: readonly PlatformId[] = ['telegram', 'slack', 'discord', 'email'] as const;

// Sentinel botKey for the synthesized legacy single-bot entries
// (telegramToken / slack*Token triple). The Communications tab can
// pass this through removeTelegramBot / removeSlackApp and the
// repository routes it back to the legacy `clear()` path. Distinct
// from any sha256 prefix (length ≠ 24).
const LEGACY_TELEGRAM_BOT_KEY = 'legacy-telegram';
const LEGACY_SLACK_BOT_KEY = 'legacy-slack';

/** Parse `${secrets:<ref>}` from a passthrough value. Returns the ref
 *  path, or null if the value isn't a secret reference. */
function extractSecretRef(value: string): string | null {
  const m = value.match(/^\$\{secrets:([^}]+)\}$/);
  return m?.[1] ?? null;
}

export interface PlatformsRepositoryOptions {
  config: ConfigRepository;
  secrets: SecretsResolver;
}

export class PlatformsRepository {
  constructor(private readonly opts: PlatformsRepositoryOptions) {}

  async listStatus(): Promise<PlatformStatus[]> {
    const passthrough = await this.passthrough();
    return ALL_PLATFORM_IDS.map((id) => this.statusFor(id, passthrough));
  }

  async getStatus(id: PlatformId): Promise<PlatformStatus> {
    return this.statusFor(id, await this.passthrough());
  }

  /**
   * Apply per-field updates. Empty-string / missing fields preserve
   * the existing value (so users can rotate one secret without
   * re-entering all the others). Secret-shaped fields go through the
   * resolver; non-secret fields land directly in passthrough.
   * Returns the post-write status.
   */
  async set(id: PlatformId, fields: Record<string, string>): Promise<PlatformStatus> {
    const def = PLATFORMS[id];
    const passthroughPatch: Record<string, string> = {};

    for (const fieldName of def.fields) {
      const incoming = fields[fieldName];
      if (incoming === undefined || incoming === '') continue;
      const configKey = def.toConfigKey[fieldName];
      if (!configKey) continue;
      const secretRef = def.secretRef[fieldName];
      if (secretRef) {
        await this.opts.secrets.set(secretRef, incoming);
        passthroughPatch[configKey] = `\${secrets:${secretRef}}`;
      } else {
        passthroughPatch[configKey] = incoming;
      }
    }

    if (Object.keys(passthroughPatch).length > 0) {
      await this.opts.config.update({ passthrough: passthroughPatch });
    }
    return this.getStatus(id);
  }

  async clear(id: PlatformId): Promise<PlatformStatus> {
    const def = PLATFORMS[id];
    const passthrough = await this.passthrough();
    const keys = def.fields
      .map((f) => def.toConfigKey[f])
      .filter((k): k is string => typeof k === 'string');
    // Delete the underlying secrets too — config refs would otherwise
    // dangle and the resolver list would mislead a future audit.
    for (const fieldName of def.fields) {
      const configKey = def.toConfigKey[fieldName];
      if (!configKey) continue;
      const value = passthrough[configKey];
      if (!value) continue;
      const ref = extractSecretRef(value);
      if (ref) await this.opts.secrets.delete(ref);
    }
    if (keys.length > 0) await this.opts.config.deletePassthroughKeys(keys);
    return this.getStatus(id);
  }

  private async passthrough(): Promise<Record<string, string>> {
    const raw = await this.opts.config.read();
    return raw?.passthrough ?? {};
  }

  private async rawConfig(): Promise<RawConfig | null> {
    return this.opts.config.read();
  }

  /** Derive a stable botKey — same algorithm as apps/ethos/src/config.ts deriveBotKey. */
  private deriveBotKey(seed: string): string {
    return createHash('sha256').update(seed).digest('hex').slice(0, 24);
  }

  /** Parse all `telegram.bots.N.*` passthrough keys into grouped entries. */
  private parseTelegramIndices(
    passthrough: Record<string, string>,
  ): Map<number, Record<string, string>> {
    const byIndex = new Map<number, Record<string, string>>();
    for (const [key, value] of Object.entries(passthrough)) {
      const m = key.match(/^telegram\.bots\.(\d+)\.(.+)$/);
      if (!m) continue;
      const idx = Number(m[1]);
      const sub = m[2] as string;
      const entry = byIndex.get(idx) ?? {};
      entry[sub] = value;
      byIndex.set(idx, entry);
    }
    return byIndex;
  }

  /** Parse all `slack.apps.N.*` passthrough keys into grouped entries. */
  private parseSlackIndices(
    passthrough: Record<string, string>,
  ): Map<number, Record<string, string>> {
    const byIndex = new Map<number, Record<string, string>>();
    for (const [key, value] of Object.entries(passthrough)) {
      const m = key.match(/^slack\.apps\.(\d+)\.(.+)$/);
      if (!m) continue;
      const idx = Number(m[1]);
      const sub = m[2] as string;
      const entry = byIndex.get(idx) ?? {};
      entry[sub] = value;
      byIndex.set(idx, entry);
    }
    return byIndex;
  }

  private entryToBotKey(fields: Record<string, string>, seed: string): string {
    return fields.id ?? this.deriveBotKey(seed);
  }

  // ---------------------------------------------------------------------------
  // Multi-bot Telegram
  // ---------------------------------------------------------------------------

  async listTelegramBots(): Promise<TelegramBotEntry[]> {
    const raw = await this.rawConfig();
    const passthrough = raw?.passthrough ?? {};
    const byIndex = this.parseTelegramIndices(passthrough);
    const result: TelegramBotEntry[] = [];
    for (const [, fields] of [...byIndex.entries()].sort(([a], [b]) => a - b)) {
      const bindType = fields['bind.type'];
      const bindName = fields['bind.name'];
      if (!bindName || (bindType !== 'personality' && bindType !== 'team')) continue;
      const token = fields.token ?? '';
      const botKey = this.entryToBotKey(fields, token);
      result.push({
        botKey,
        tokenConfigured: token.length > 0,
        bind: { type: bindType, name: bindName },
      });
    }
    // Legacy single-bot shim — mirrors applyPlatformShim() in
    // apps/ethos/src/config.ts. Surfaces a CLI-set `telegramToken`
    // alongside multi-bot entries so the web Communications tab sees
    // what the gateway sees. Only synthesizes when no multi-bot
    // entries exist (gateway's shim has the same condition).
    if (result.length === 0) {
      const legacyToken = passthrough.telegramToken ?? '';
      if (legacyToken.length > 0) {
        result.push({
          botKey: LEGACY_TELEGRAM_BOT_KEY,
          tokenConfigured: true,
          bind: { type: 'personality', name: raw?.personality ?? '' },
        });
      }
    }
    return result;
  }

  async addTelegramBot(token: string, bind: BotBinding): Promise<TelegramBotEntry> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseTelegramIndices(passthrough);
    const nextIndex = byIndex.size > 0 ? Math.max(...byIndex.keys()) + 1 : 0;
    const botKey = this.deriveBotKey(token);
    const secretRef = `telegram/bots/${botKey}/token`;
    await this.opts.secrets.set(secretRef, token);
    await this.opts.config.update({
      passthrough: {
        [`telegram.bots.${nextIndex}.id`]: botKey,
        [`telegram.bots.${nextIndex}.token`]: `\${secrets:${secretRef}}`,
        [`telegram.bots.${nextIndex}.bind.type`]: bind.type,
        [`telegram.bots.${nextIndex}.bind.name`]: bind.name,
      },
    });
    return { botKey, tokenConfigured: true, bind };
  }

  async removeTelegramBot(botKey: string): Promise<void> {
    if (botKey === LEGACY_TELEGRAM_BOT_KEY) {
      await this.clear('telegram');
      return;
    }
    const passthrough = await this.passthrough();
    const byIndex = this.parseTelegramIndices(passthrough);
    let targetIndex: number | undefined;
    let targetFields: Record<string, string> | undefined;
    for (const [idx, fields] of byIndex.entries()) {
      const token = fields.token ?? '';
      if (this.entryToBotKey(fields, token) === botKey) {
        targetIndex = idx;
        targetFields = fields;
        break;
      }
    }
    if (targetIndex === undefined || !targetFields) return;
    const tokenValue = targetFields.token ?? '';
    const ref = extractSecretRef(tokenValue);
    if (ref) await this.opts.secrets.delete(ref);
    const toDelete = Object.keys(passthrough).filter((k) =>
      k.startsWith(`telegram.bots.${targetIndex}.`),
    );
    await this.opts.config.deletePassthroughKeys(toDelete);
    await this.reindexTelegramBots();
  }

  private async reindexTelegramBots(): Promise<void> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseTelegramIndices(passthrough);
    const allKeys = Object.keys(passthrough).filter((k) => k.startsWith('telegram.bots.'));
    if (allKeys.length > 0) await this.opts.config.deletePassthroughKeys(allKeys);
    const sorted = [...byIndex.entries()].sort(([a], [b]) => a - b);
    const newPassthrough: Record<string, string> = {};
    for (const [newIdx, [, fields]] of sorted.entries()) {
      for (const [sub, value] of Object.entries(fields)) {
        newPassthrough[`telegram.bots.${newIdx}.${sub}`] = value;
      }
    }
    if (Object.keys(newPassthrough).length > 0) {
      await this.opts.config.update({ passthrough: newPassthrough });
    }
  }

  // ---------------------------------------------------------------------------
  // Multi-bot Slack
  // ---------------------------------------------------------------------------

  async listSlackApps(): Promise<SlackAppEntry[]> {
    const raw = await this.rawConfig();
    const passthrough = raw?.passthrough ?? {};
    const byIndex = this.parseSlackIndices(passthrough);
    const result: SlackAppEntry[] = [];
    for (const [, fields] of [...byIndex.entries()].sort(([a], [b]) => a - b)) {
      const bindType = fields['bind.type'];
      const bindName = fields['bind.name'];
      if (!bindName || (bindType !== 'personality' && bindType !== 'team')) continue;
      const botToken = fields.botToken ?? '';
      const botKey = this.entryToBotKey(fields, botToken);
      result.push({
        botKey,
        botTokenConfigured: botToken.length > 0,
        appTokenConfigured: (fields.appToken ?? '').length > 0,
        signingSecretConfigured: (fields.signingSecret ?? '').length > 0,
        bind: { type: bindType, name: bindName },
      });
    }
    // Legacy single-app shim — synthesizes one entry from the CLI's
    // slack*Token triple when no multi-app entries exist. Matches
    // applyPlatformShim()'s three-field guard: all three must be
    // present.
    if (result.length === 0) {
      const botToken = passthrough.slackBotToken ?? '';
      const appToken = passthrough.slackAppToken ?? '';
      const signingSecret = passthrough.slackSigningSecret ?? '';
      if (botToken.length > 0 && appToken.length > 0 && signingSecret.length > 0) {
        result.push({
          botKey: LEGACY_SLACK_BOT_KEY,
          botTokenConfigured: true,
          appTokenConfigured: true,
          signingSecretConfigured: true,
          bind: { type: 'personality', name: raw?.personality ?? '' },
        });
      }
    }
    return result;
  }

  async addSlackApp(
    tokens: { botToken: string; appToken: string; signingSecret: string },
    bind: BotBinding,
  ): Promise<SlackAppEntry> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseSlackIndices(passthrough);
    const nextIndex = byIndex.size > 0 ? Math.max(...byIndex.keys()) + 1 : 0;
    const botKey = this.deriveBotKey(tokens.botToken);
    const botTokenRef = `slack/apps/${botKey}/botToken`;
    const appTokenRef = `slack/apps/${botKey}/appToken`;
    const signingSecretRef = `slack/apps/${botKey}/signingSecret`;
    await this.opts.secrets.set(botTokenRef, tokens.botToken);
    await this.opts.secrets.set(appTokenRef, tokens.appToken);
    await this.opts.secrets.set(signingSecretRef, tokens.signingSecret);
    await this.opts.config.update({
      passthrough: {
        [`slack.apps.${nextIndex}.id`]: botKey,
        [`slack.apps.${nextIndex}.botToken`]: `\${secrets:${botTokenRef}}`,
        [`slack.apps.${nextIndex}.appToken`]: `\${secrets:${appTokenRef}}`,
        [`slack.apps.${nextIndex}.signingSecret`]: `\${secrets:${signingSecretRef}}`,
        [`slack.apps.${nextIndex}.bind.type`]: bind.type,
        [`slack.apps.${nextIndex}.bind.name`]: bind.name,
      },
    });
    return {
      botKey,
      botTokenConfigured: true,
      appTokenConfigured: true,
      signingSecretConfigured: true,
      bind,
    };
  }

  async removeSlackApp(botKey: string): Promise<void> {
    if (botKey === LEGACY_SLACK_BOT_KEY) {
      await this.clear('slack');
      return;
    }
    const passthrough = await this.passthrough();
    const byIndex = this.parseSlackIndices(passthrough);
    let targetIndex: number | undefined;
    let targetFields: Record<string, string> | undefined;
    for (const [idx, fields] of byIndex.entries()) {
      const botToken = fields.botToken ?? '';
      if (this.entryToBotKey(fields, botToken) === botKey) {
        targetIndex = idx;
        targetFields = fields;
        break;
      }
    }
    if (targetIndex === undefined || !targetFields) return;
    for (const fieldName of ['botToken', 'appToken', 'signingSecret']) {
      const value = targetFields[fieldName] ?? '';
      const ref = extractSecretRef(value);
      if (ref) await this.opts.secrets.delete(ref);
    }
    const toDelete = Object.keys(passthrough).filter((k) =>
      k.startsWith(`slack.apps.${targetIndex}.`),
    );
    await this.opts.config.deletePassthroughKeys(toDelete);
    await this.reindexSlackApps();
  }

  private async reindexSlackApps(): Promise<void> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseSlackIndices(passthrough);
    const allKeys = Object.keys(passthrough).filter((k) => k.startsWith('slack.apps.'));
    if (allKeys.length > 0) await this.opts.config.deletePassthroughKeys(allKeys);
    const sorted = [...byIndex.entries()].sort(([a], [b]) => a - b);
    const newPassthrough: Record<string, string> = {};
    for (const [newIdx, [, fields]] of sorted.entries()) {
      for (const [sub, value] of Object.entries(fields)) {
        newPassthrough[`slack.apps.${newIdx}.${sub}`] = value;
      }
    }
    if (Object.keys(newPassthrough).length > 0) {
      await this.opts.config.update({ passthrough: newPassthrough });
    }
  }

  private statusFor(id: PlatformId, passthrough: Record<string, string>): PlatformStatus {
    const def = PLATFORMS[id];
    const fields: Record<string, boolean> = {};
    for (const fieldName of def.fields) {
      const configKey = def.toConfigKey[fieldName];
      const value = configKey ? passthrough[configKey] : undefined;
      fields[fieldName] = typeof value === 'string' && value.length > 0;
    }
    const configured = def.fields.every((f) => fields[f]);
    return { id, configured, fields };
  }
}
