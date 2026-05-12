import { createHash } from 'node:crypto';
import type {
  BotBinding,
  PlatformId,
  PlatformStatus,
  SlackAppEntry,
  TelegramBotEntry,
} from '@ethosagent/web-contracts';
import type { ConfigRepository } from './config.repository';

// Per-platform connection inventory + setup over the same
// ~/.ethos/config.yaml the gateway reads. Keys are flat
// (telegramToken, slackBotToken, …); the repository owns the per-
// platform field-name mapping so the service never knows about it.
//
// Sensitive values never leave this layer — the repository only emits
// PlatformStatus { configured, fields: { name → bool } }. Plain
// secrets enter via `set` for writes and immediately land in the
// passthrough block of the YAML.

interface PlatformDefinition {
  /** Form field names the UI uses. */
  fields: readonly string[];
  /** Field name → flat key in config.yaml. */
  toConfigKey: Record<string, string>;
}

const PLATFORMS: Record<PlatformId, PlatformDefinition> = {
  telegram: {
    fields: ['token'],
    toConfigKey: { token: 'telegramToken' },
  },
  discord: {
    fields: ['token'],
    toConfigKey: { token: 'discordToken' },
  },
  slack: {
    fields: ['botToken', 'appToken', 'signingSecret'],
    toConfigKey: {
      botToken: 'slackBotToken',
      appToken: 'slackAppToken',
      signingSecret: 'slackSigningSecret',
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
  },
};

const ALL_PLATFORM_IDS: readonly PlatformId[] = ['telegram', 'slack', 'discord', 'email'] as const;

export interface PlatformsRepositoryOptions {
  config: ConfigRepository;
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
   * re-entering all the others). Returns the post-write status.
   */
  async set(id: PlatformId, fields: Record<string, string>): Promise<PlatformStatus> {
    const def = PLATFORMS[id];
    const passthroughPatch: Record<string, string> = {};

    for (const fieldName of def.fields) {
      const incoming = fields[fieldName];
      if (incoming === undefined || incoming === '') continue;
      const configKey = def.toConfigKey[fieldName];
      if (configKey) passthroughPatch[configKey] = incoming;
    }

    if (Object.keys(passthroughPatch).length > 0) {
      await this.opts.config.update({ passthrough: passthroughPatch });
    }
    return this.getStatus(id);
  }

  async clear(id: PlatformId): Promise<PlatformStatus> {
    const def = PLATFORMS[id];
    const keys = def.fields
      .map((f) => def.toConfigKey[f])
      .filter((k): k is string => typeof k === 'string');
    if (keys.length > 0) await this.opts.config.deletePassthroughKeys(keys);
    return this.getStatus(id);
  }

  private async passthrough(): Promise<Record<string, string>> {
    const raw = await this.opts.config.read();
    return raw?.passthrough ?? {};
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
    return fields['id'] ?? this.deriveBotKey(seed);
  }

  // ---------------------------------------------------------------------------
  // Multi-bot Telegram
  // ---------------------------------------------------------------------------

  async listTelegramBots(): Promise<TelegramBotEntry[]> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseTelegramIndices(passthrough);
    const result: TelegramBotEntry[] = [];
    for (const [, fields] of [...byIndex.entries()].sort(([a], [b]) => a - b)) {
      const bindType = fields['bind.type'];
      const bindName = fields['bind.name'];
      if (!bindName || (bindType !== 'personality' && bindType !== 'team')) continue;
      const token = fields['token'] ?? '';
      const botKey = this.entryToBotKey(fields, token);
      result.push({
        botKey,
        tokenConfigured: token.length > 0,
        bind: { type: bindType, name: bindName },
      });
    }
    return result;
  }

  async addTelegramBot(token: string, bind: BotBinding): Promise<TelegramBotEntry> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseTelegramIndices(passthrough);
    const nextIndex = byIndex.size > 0 ? Math.max(...byIndex.keys()) + 1 : 0;
    const botKey = this.deriveBotKey(token);
    await this.opts.config.update({
      passthrough: {
        [`telegram.bots.${nextIndex}.token`]: token,
        [`telegram.bots.${nextIndex}.bind.type`]: bind.type,
        [`telegram.bots.${nextIndex}.bind.name`]: bind.name,
      },
    });
    return { botKey, tokenConfigured: true, bind };
  }

  async removeTelegramBot(botKey: string): Promise<void> {
    const passthrough = await this.passthrough();
    const byIndex = this.parseTelegramIndices(passthrough);
    let targetIndex: number | undefined;
    for (const [idx, fields] of byIndex.entries()) {
      const token = fields['token'] ?? '';
      if (this.entryToBotKey(fields, token) === botKey) {
        targetIndex = idx;
        break;
      }
    }
    if (targetIndex === undefined) return;
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
    const passthrough = await this.passthrough();
    const byIndex = this.parseSlackIndices(passthrough);
    const result: SlackAppEntry[] = [];
    for (const [, fields] of [...byIndex.entries()].sort(([a], [b]) => a - b)) {
      const bindType = fields['bind.type'];
      const bindName = fields['bind.name'];
      if (!bindName || (bindType !== 'personality' && bindType !== 'team')) continue;
      const botToken = fields['botToken'] ?? '';
      const botKey = this.entryToBotKey(fields, botToken);
      result.push({
        botKey,
        botTokenConfigured: botToken.length > 0,
        appTokenConfigured: (fields['appToken'] ?? '').length > 0,
        signingSecretConfigured: (fields['signingSecret'] ?? '').length > 0,
        bind: { type: bindType, name: bindName },
      });
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
    await this.opts.config.update({
      passthrough: {
        [`slack.apps.${nextIndex}.botToken`]: tokens.botToken,
        [`slack.apps.${nextIndex}.appToken`]: tokens.appToken,
        [`slack.apps.${nextIndex}.signingSecret`]: tokens.signingSecret,
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
    const passthrough = await this.passthrough();
    const byIndex = this.parseSlackIndices(passthrough);
    let targetIndex: number | undefined;
    for (const [idx, fields] of byIndex.entries()) {
      const botToken = fields['botToken'] ?? '';
      if (this.entryToBotKey(fields, botToken) === botKey) {
        targetIndex = idx;
        break;
      }
    }
    if (targetIndex === undefined) return;
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
