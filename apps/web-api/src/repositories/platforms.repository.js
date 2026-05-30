import { join } from 'node:path';
import { deriveBotKey } from '@ethosagent/core';

const PLATFORMS = {
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
  // WhatsApp pairs via QR code, not config-form fields — so it has no settable
  // secret fields here. listStatus() special-cases it; this stub exists only so
  // statusFor() can index PLATFORMS[id] for it.
  whatsapp: {
    fields: [],
    toConfigKey: {},
    secretRef: {},
  },
};
const ALL_PLATFORM_IDS = ['telegram', 'slack', 'discord', 'email', 'whatsapp'];
// Sentinel botKey for the synthesized legacy single-bot entries
// (telegramToken / slack*Token triple). The Communications tab can
// pass this through removeTelegramBot / removeSlackApp and the
// repository routes it back to the legacy `clear()` path. Distinct
// from any sha256 prefix (length ≠ 24).
const LEGACY_TELEGRAM_BOT_KEY = 'legacy-telegram';
const LEGACY_SLACK_BOT_KEY = 'legacy-slack';
/** Parse `${secrets:<ref>}` from a passthrough value. Returns the ref
 *  path, or null if the value isn't a secret reference. */
function extractSecretRef(value) {
  const m = value.match(/^\$\{secrets:([^}]+)\}$/);
  return m?.[1] ?? null;
}
// Mirrors sanitizeBotKey in extensions/platform-whatsapp/src/session-store.ts —
// the Baileys session dir for a bot is `<sessionDir>/<sanitized botKey>/`.
function sanitizeBotKey(key) {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}
export class PlatformsRepository {
  opts;
  constructor(opts) {
    this.opts = opts;
  }
  async listStatus() {
    const passthrough = await this.passthrough();
    const statuses = ALL_PLATFORM_IDS.map((id) => {
      const status = this.statusFor(id, passthrough);
      // Multi-bot platforms: also configured when indexed bot entries exist,
      // even when the legacy single-token key is absent.
      if (id === 'telegram' && !status.configured) {
        if (Object.keys(passthrough).some((k) => k.startsWith('telegram.bots.'))) {
          return { ...status, configured: true };
        }
      }
      if (id === 'slack' && !status.configured) {
        if (Object.keys(passthrough).some((k) => k.startsWith('slack.apps.'))) {
          return { ...status, configured: true };
        }
      }
      return status;
    });
    // WhatsApp's PlatformDefinition has no settable fields (it pairs via QR,
    // not config-form tokens), so statusFor() always reports configured=false.
    // Special-case it: configured when any `whatsapp.<n>` entry exists, and
    // surface a `paired` indicator (any configured bot has a non-empty
    // Baileys session dir) on the fields map — the only boolean channel the
    // frozen PlatformStatus schema offers.
    const wa = statuses.find((s) => s.id === 'whatsapp');
    if (wa) {
      const entries = await this.listWhatsApp();
      wa.configured = entries.length > 0;
      wa.fields = { paired: entries.some((e) => e.paired) };
    }
    return statuses;
  }
  async getStatus(id) {
    return this.statusFor(id, await this.passthrough());
  }
  /**
   * Apply per-field updates. Empty-string / missing fields preserve
   * the existing value (so users can rotate one secret without
   * re-entering all the others). Secret-shaped fields go through the
   * resolver; non-secret fields land directly in passthrough.
   * Returns the post-write status.
   */
  async set(id, fields) {
    const def = PLATFORMS[id];
    const passthroughPatch = {};
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
  async clear(id) {
    const def = PLATFORMS[id];
    const passthrough = await this.passthrough();
    const keys = def.fields.map((f) => def.toConfigKey[f]).filter((k) => typeof k === 'string');
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
  async passthrough() {
    const raw = await this.opts.config.read();
    return raw?.passthrough ?? {};
  }
  async rawConfig() {
    return this.opts.config.read();
  }
  /** Parse all `telegram.bots.N.*` passthrough keys into grouped entries. */
  parseTelegramIndices(passthrough) {
    const byIndex = new Map();
    for (const [key, value] of Object.entries(passthrough)) {
      const m = key.match(/^telegram\.bots\.(\d+)\.(.+)$/);
      if (!m) continue;
      const idx = Number(m[1]);
      const sub = m[2];
      const entry = byIndex.get(idx) ?? {};
      entry[sub] = value;
      byIndex.set(idx, entry);
    }
    return byIndex;
  }
  /** Parse all `slack.apps.N.*` passthrough keys into grouped entries. */
  parseSlackIndices(passthrough) {
    const byIndex = new Map();
    for (const [key, value] of Object.entries(passthrough)) {
      const m = key.match(/^slack\.apps\.(\d+)\.(.+)$/);
      if (!m) continue;
      const idx = Number(m[1]);
      const sub = m[2];
      const entry = byIndex.get(idx) ?? {};
      entry[sub] = value;
      byIndex.set(idx, entry);
    }
    return byIndex;
  }
  entryToBotKey(fields, seed) {
    return fields.id ?? deriveBotKey(seed);
  }
  // ---------------------------------------------------------------------------
  // Multi-bot Telegram
  // ---------------------------------------------------------------------------
  async listTelegramBots() {
    const raw = await this.rawConfig();
    const passthrough = raw?.passthrough ?? {};
    const byIndex = this.parseTelegramIndices(passthrough);
    const result = [];
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
        username: fields.username,
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
  async addTelegramBot(token, bind, username) {
    const passthrough = await this.passthrough();
    const byIndex = this.parseTelegramIndices(passthrough);
    const nextIndex = byIndex.size > 0 ? Math.max(...byIndex.keys()) + 1 : 0;
    const botKey = deriveBotKey(token);
    const secretRef = `telegram/bots/${botKey}/token`;
    await this.opts.secrets.set(secretRef, token);
    await this.opts.config.update({
      passthrough: {
        [`telegram.bots.${nextIndex}.id`]: botKey,
        [`telegram.bots.${nextIndex}.token`]: `\${secrets:${secretRef}}`,
        [`telegram.bots.${nextIndex}.bind.type`]: bind.type,
        [`telegram.bots.${nextIndex}.bind.name`]: bind.name,
        ...(username ? { [`telegram.bots.${nextIndex}.username`]: username } : {}),
      },
    });
    return { botKey, tokenConfigured: true, bind, username };
  }
  async removeTelegramBot(botKey) {
    if (botKey === LEGACY_TELEGRAM_BOT_KEY) {
      await this.clear('telegram');
      return;
    }
    const passthrough = await this.passthrough();
    const byIndex = this.parseTelegramIndices(passthrough);
    let targetIndex;
    let targetFields;
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
  async reindexTelegramBots() {
    const passthrough = await this.passthrough();
    const byIndex = this.parseTelegramIndices(passthrough);
    const allKeys = Object.keys(passthrough).filter((k) => k.startsWith('telegram.bots.'));
    if (allKeys.length > 0) await this.opts.config.deletePassthroughKeys(allKeys);
    const sorted = [...byIndex.entries()].sort(([a], [b]) => a - b);
    const newPassthrough = {};
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
  async listSlackApps() {
    const raw = await this.rawConfig();
    const passthrough = raw?.passthrough ?? {};
    const byIndex = this.parseSlackIndices(passthrough);
    const result = [];
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
  async addSlackApp(tokens, bind) {
    const passthrough = await this.passthrough();
    const byIndex = this.parseSlackIndices(passthrough);
    const nextIndex = byIndex.size > 0 ? Math.max(...byIndex.keys()) + 1 : 0;
    const botKey = deriveBotKey(tokens.botToken);
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
  async removeSlackApp(botKey) {
    if (botKey === LEGACY_SLACK_BOT_KEY) {
      await this.clear('slack');
      return;
    }
    const passthrough = await this.passthrough();
    const byIndex = this.parseSlackIndices(passthrough);
    let targetIndex;
    let targetFields;
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
  async reindexSlackApps() {
    const passthrough = await this.passthrough();
    const byIndex = this.parseSlackIndices(passthrough);
    const allKeys = Object.keys(passthrough).filter((k) => k.startsWith('slack.apps.'));
    if (allKeys.length > 0) await this.opts.config.deletePassthroughKeys(allKeys);
    const sorted = [...byIndex.entries()].sort(([a], [b]) => a - b);
    const newPassthrough = {};
    for (const [newIdx, [, fields]] of sorted.entries()) {
      for (const [sub, value] of Object.entries(fields)) {
        newPassthrough[`slack.apps.${newIdx}.${sub}`] = value;
      }
    }
    if (Object.keys(newPassthrough).length > 0) {
      await this.opts.config.update({ passthrough: newPassthrough });
    }
  }
  // ---------------------------------------------------------------------------
  // Multi-bot WhatsApp
  //
  // Unlike Telegram/Slack, WhatsApp has no tokens/secrets and no bind. An
  // entry is just routing knobs (`id`, `default_mode`, `allowed_numbers`,
  // `session_dir`) written as flat `whatsapp.<n>.*` passthrough keys — the
  // exact shape apps/ethos/src/config.ts serializes and parses. Pairing is
  // out-of-band (QR via setup-whatsapp); `paired` is derived from whether the
  // Baileys session dir on disk holds saved credentials.
  // ---------------------------------------------------------------------------
  /** Parse all `whatsapp.<n>.*` passthrough keys into grouped entries. */
  parseWhatsAppIndices(passthrough) {
    const byIndex = new Map();
    for (const [key, value] of Object.entries(passthrough)) {
      const m = key.match(/^whatsapp\.(\d+)\.(.+)$/);
      if (!m) continue;
      const idx = Number(m[1]);
      const sub = m[2];
      const entry = byIndex.get(idx) ?? {};
      entry[sub] = value;
      byIndex.set(idx, entry);
    }
    return byIndex;
  }
  /** Default base session dir when an entry sets no `session_dir`, matching the
   *  gateway's `waCfg.session_dir ?? join(ethosDir(), 'whatsapp')`. */
  whatsAppBaseSessionDir(fields) {
    return fields.session_dir ?? join(this.opts.dataDir ?? '', 'whatsapp');
  }
  /** botKey derivation matching the adapter:
   *  `id ?? wa-<sanitized session-dir tail>`. */
  whatsAppBotKey(fields) {
    if (fields.id) return fields.id;
    const baseDir = this.whatsAppBaseSessionDir(fields);
    return `wa-${baseDir.replace(/[^a-zA-Z0-9]/g, '').slice(-16)}`;
  }
  /** True when the Baileys per-bot session dir holds saved credentials.
   *  Requires a Storage; without one (unit tests), always false. */
  async whatsAppPaired(fields, botKey) {
    const storage = this.opts.storage;
    if (!storage) return false;
    const dir = join(this.whatsAppBaseSessionDir(fields), sanitizeBotKey(botKey));
    return (await storage.list(dir)).length > 0;
  }
  async listWhatsApp() {
    const passthrough = await this.passthrough();
    const byIndex = this.parseWhatsAppIndices(passthrough);
    const result = [];
    for (const [, fields] of [...byIndex.entries()].sort(([a], [b]) => a - b)) {
      const botKey = this.whatsAppBotKey(fields);
      const allowedRaw = fields.allowed_numbers ?? '';
      result.push({
        botKey,
        defaultMode: fields.default_mode === 'all' ? 'all' : 'mention_only',
        allowedNumbers: allowedRaw
          ? allowedRaw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
        paired: await this.whatsAppPaired(fields, botKey),
      });
    }
    return result;
  }
  async addWhatsApp(input) {
    const passthrough = await this.passthrough();
    const byIndex = this.parseWhatsAppIndices(passthrough);
    const nextIndex = byIndex.size > 0 ? Math.max(...byIndex.keys()) + 1 : 0;
    // `id` is required to disambiguate multi-bot routing (without it the
    // adapter derives the same `wa-<dir tail>` botKey for every entry sharing
    // a session dir). Generate a stable random one when absent.
    const id = input.id ?? `wa-${Math.random().toString(36).slice(2, 10)}`;
    const defaultMode = input.defaultMode ?? 'mention_only';
    const allowedNumbers = (input.allowedNumbers ?? []).map((s) => s.trim()).filter(Boolean);
    const patch = {
      [`whatsapp.${nextIndex}.id`]: id,
      [`whatsapp.${nextIndex}.default_mode`]: defaultMode,
    };
    if (allowedNumbers.length > 0) {
      patch[`whatsapp.${nextIndex}.allowed_numbers`] = allowedNumbers.join(',');
    }
    await this.opts.config.update({ passthrough: patch });
    return {
      botKey: id,
      defaultMode,
      allowedNumbers,
      paired: await this.whatsAppPaired({ id }, id),
    };
  }
  async removeWhatsApp(botKey) {
    const passthrough = await this.passthrough();
    const byIndex = this.parseWhatsAppIndices(passthrough);
    let targetIndex;
    for (const [idx, fields] of byIndex.entries()) {
      if (this.whatsAppBotKey(fields) === botKey) {
        targetIndex = idx;
        break;
      }
    }
    if (targetIndex === undefined) return;
    const toDelete = Object.keys(passthrough).filter((k) =>
      k.startsWith(`whatsapp.${targetIndex}.`),
    );
    await this.opts.config.deletePassthroughKeys(toDelete);
    await this.reindexWhatsApp();
  }
  async reindexWhatsApp() {
    const passthrough = await this.passthrough();
    const byIndex = this.parseWhatsAppIndices(passthrough);
    const allKeys = Object.keys(passthrough).filter((k) => k.startsWith('whatsapp.'));
    if (allKeys.length > 0) await this.opts.config.deletePassthroughKeys(allKeys);
    const sorted = [...byIndex.entries()].sort(([a], [b]) => a - b);
    const newPassthrough = {};
    for (const [newIdx, [, fields]] of sorted.entries()) {
      for (const [sub, value] of Object.entries(fields)) {
        newPassthrough[`whatsapp.${newIdx}.${sub}`] = value;
      }
    }
    if (Object.keys(newPassthrough).length > 0) {
      await this.opts.config.update({ passthrough: newPassthrough });
    }
  }
  async getChannelFilter(platform) {
    const passthrough = await this.passthrough();
    const enabled = passthrough[`channel_filter.${platform}.enable`];
    const ownerUserId = passthrough[`channel_filter.${platform}.ownerUserId`] ?? '';
    const allowlistRaw = passthrough[`channel_filter.${platform}.recipientAllowlist`] ?? '';
    return {
      enabled: enabled !== 'false',
      ownerUserId,
      allowlist: allowlistRaw
        ? allowlistRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    };
  }
  async setChannelFilter(platform, filter) {
    const prefix = `channel_filter.${platform}`;
    const patch = {};
    const toDelete = [];
    if (!filter.enabled) {
      patch[`${prefix}.enable`] = 'false';
    } else {
      toDelete.push(`${prefix}.enable`);
    }
    if (filter.ownerUserId.trim()) {
      patch[`${prefix}.ownerUserId`] = filter.ownerUserId.trim();
    } else {
      toDelete.push(`${prefix}.ownerUserId`);
    }
    const cleaned = filter.allowlist.map((s) => s.trim()).filter(Boolean);
    if (cleaned.length > 0) {
      patch[`${prefix}.recipientAllowlist`] = cleaned.join(',');
    } else {
      toDelete.push(`${prefix}.recipientAllowlist`);
    }
    if (Object.keys(patch).length > 0) await this.opts.config.update({ passthrough: patch });
    if (toDelete.length > 0) await this.opts.config.deletePassthroughKeys(toDelete);
    return this.getChannelFilter(platform);
  }
  statusFor(id, passthrough) {
    const def = PLATFORMS[id];
    const fields = {};
    for (const fieldName of def.fields) {
      const configKey = def.toConfigKey[fieldName];
      const value = configKey ? passthrough[configKey] : undefined;
      fields[fieldName] = typeof value === 'string' && value.length > 0;
    }
    const configured = def.fields.every((f) => fields[f]);
    return { id, configured, fields };
  }
}
