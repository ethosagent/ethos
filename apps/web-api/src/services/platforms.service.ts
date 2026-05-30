import type {
  BotBinding,
  ChannelPlatformFilter,
  PlatformId,
  PlatformStatus,
  SlackAppEntry,
  TelegramBotEntry,
  WhatsAppEntry,
} from '@ethosagent/web-contracts';
import type { PlatformsRepository } from '../repositories/platforms.repository';

// Communications service. Pass-through over PlatformsRepository today
// — the repository owns the field-name → config-key mapping per
// platform, and the service surface is just {list, set, clear}.
//
// Real validation (does the Telegram bot token actually work? Can the
// SMTP host accept connections?) lives in the gateway adapters when
// the gateway boots; this service does not block on those. The setup
// form's success state means "stored to config.yaml," not "validated
// against the upstream platform."

export interface PlatformsServiceOptions {
  repo: PlatformsRepository;
}

export class PlatformsService {
  constructor(private readonly opts: PlatformsServiceOptions) {}

  async list(): Promise<{ platforms: PlatformStatus[] }> {
    return { platforms: await this.opts.repo.listStatus() };
  }

  async set(id: PlatformId, fields: Record<string, string>): Promise<{ platform: PlatformStatus }> {
    return { platform: await this.opts.repo.set(id, fields) };
  }

  async clear(id: PlatformId): Promise<{ platform: PlatformStatus }> {
    return { platform: await this.opts.repo.clear(id) };
  }

  async listTelegramBots(): Promise<{ bots: TelegramBotEntry[] }> {
    return { bots: await this.opts.repo.listTelegramBots() };
  }

  async addTelegramBot(
    token: string,
    bind: BotBinding,
    username?: string,
  ): Promise<{ bot: TelegramBotEntry }> {
    return { bot: await this.opts.repo.addTelegramBot(token, bind, username) };
  }

  async removeTelegramBot(botKey: string): Promise<{ ok: true }> {
    await this.opts.repo.removeTelegramBot(botKey);
    return { ok: true };
  }

  async listSlackApps(): Promise<{ bots: SlackAppEntry[] }> {
    return { bots: await this.opts.repo.listSlackApps() };
  }

  async addSlackApp(
    tokens: { botToken: string; appToken: string; signingSecret: string },
    bind: BotBinding,
  ): Promise<{ bot: SlackAppEntry }> {
    return { bot: await this.opts.repo.addSlackApp(tokens, bind) };
  }

  async removeSlackApp(botKey: string): Promise<{ ok: true }> {
    await this.opts.repo.removeSlackApp(botKey);
    return { ok: true };
  }

  async listWhatsApp(): Promise<{ bots: WhatsAppEntry[] }> {
    return { bots: await this.opts.repo.listWhatsApp() };
  }

  async addWhatsApp(input: {
    id?: string;
    defaultMode?: 'all' | 'mention_only';
    allowedNumbers?: string[];
    phoneNumber?: string;
  }): Promise<{ bot: WhatsAppEntry }> {
    return { bot: await this.opts.repo.addWhatsApp(input) };
  }

  async removeWhatsApp(botKey: string): Promise<{ ok: true }> {
    await this.opts.repo.removeWhatsApp(botKey);
    return { ok: true };
  }

  async getChannelFilter(platform: string): Promise<{ filter: ChannelPlatformFilter }> {
    return { filter: await this.opts.repo.getChannelFilter(platform) };
  }

  async setChannelFilter(
    platform: string,
    filter: ChannelPlatformFilter,
  ): Promise<{ filter: ChannelPlatformFilter }> {
    return { filter: await this.opts.repo.setChannelFilter(platform, filter) };
  }
}
