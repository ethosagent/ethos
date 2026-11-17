import type { EthosConfig } from '@ethosagent/config';
import { c } from './doctor-shared';

export interface SdkRow {
  label: string;
  module: string;
  /**
   * Loads `module`. A literal `import()` per row, never a computed one, so the module graph
   * stays readable; dynamic because the channel SDKs are optionalDependencies of the CLI.
   */
  load: () => Promise<unknown>;
  required: boolean;
  /** Config keys that, if set, mean this SDK is "in use" — missing is a hard error. */
  configuredWhen?: (cfg: EthosConfig) => boolean;
}

export const CORE_SDKS: SdkRow[] = [
  {
    label: 'Anthropic provider',
    module: '@anthropic-ai/sdk',
    load: () => import('@anthropic-ai/sdk'),
    required: true,
  },
  {
    label: 'OpenAI-compat provider',
    module: 'openai',
    load: () => import('openai'),
    required: true,
  },
];

export const CHANNEL_SDKS: SdkRow[] = [
  {
    label: 'Telegram',
    module: 'grammy',
    load: () => import('grammy'),
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.telegramToken),
  },
  {
    label: 'Discord',
    module: 'discord.js',
    load: () => import('discord.js'),
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.discordToken),
  },
  {
    label: 'Slack',
    module: '@slack/bolt',
    load: () => import('@slack/bolt'),
    required: false,
    configuredWhen: (cfg) =>
      Boolean(cfg.slackBotToken && cfg.slackAppToken && cfg.slackSigningSecret),
  },
  {
    label: 'Email (IMAP)',
    module: 'imapflow',
    load: () => import('imapflow'),
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.emailImapHost && cfg.emailUser && cfg.emailPassword),
  },
  {
    label: 'Email (parser)',
    module: 'mailparser',
    load: () => import('mailparser'),
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.emailImapHost && cfg.emailUser && cfg.emailPassword),
  },
  {
    label: 'Email (SMTP)',
    module: 'nodemailer',
    load: () => import('nodemailer'),
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.emailSmtpHost && cfg.emailUser && cfg.emailPassword),
  },
];

export async function checkSdk(row: SdkRow): Promise<{ ok: boolean; error?: string }> {
  try {
    await row.load();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface RowResult {
  row: SdkRow;
  ok: boolean;
  inUse: boolean;
}

export function printRow(r: RowResult): void {
  const tag = r.ok
    ? `${c.green}✓${c.reset}`
    : r.row.required || r.inUse
      ? `${c.red}✗${c.reset}`
      : `${c.dim}–${c.reset}`;
  const label = r.row.label.padEnd(24);
  const module = `${c.dim}${r.row.module}${c.reset}`;
  const note = r.ok
    ? ''
    : r.row.required
      ? `  ${c.red}(required — ethos will not work)${c.reset}`
      : r.inUse
        ? `  ${c.red}(configured but SDK missing — install with ${c.cyan}npm install -g ${r.row.module}${c.reset}${c.red})${c.reset}`
        : `  ${c.dim}(not installed; not in use)${c.reset}`;
  console.log(`  ${tag}  ${label} ${module}${note}`);
}
