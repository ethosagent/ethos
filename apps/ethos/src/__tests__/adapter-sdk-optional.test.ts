// `npm install --omit=optional` leaves every channel SDK out. Each adapter
// loads its SDK in its own sdk.ts (the only runtime import of it), and a
// missing one must surface as a clear "<Platform> adapter needs <pkg>; install
// it with …" error — which `loadAdapterModule` (apps/ethos/src/commands/gateway.ts)
// turns into "<Platform> adapter unavailable" — never a startup crash.

import { describe, expect, it } from 'vitest';

/** What Node's ESM loader rejects with for a package that is not installed. */
function notInstalled(pkg: string): () => Promise<never> {
  return () =>
    Promise.reject(
      Object.assign(new Error(`Cannot find package '${pkg}'`), { code: 'ERR_MODULE_NOT_FOUND' }),
    );
}

const telegram = () => import('../../../../extensions/platform-telegram/src/sdk');
const slack = () => import('../../../../extensions/platform-slack/src/sdk');
const discord = () => import('../../../../extensions/platform-discord/src/sdk');
const email = () => import('../../../../extensions/platform-email/src/sdk');

describe('adapter SDK loaders with the optional SDK not installed', () => {
  it('telegram', async () => {
    await expect((await telegram()).loadTelegramSdk(notInstalled('grammy'))).rejects.toThrow(
      'Telegram adapter needs grammy; install it with npm install -g grammy',
    );
  });

  it('slack', async () => {
    await expect((await slack()).loadSlackSdk(notInstalled('@slack/bolt'))).rejects.toThrow(
      'Slack adapter needs @slack/bolt; install it with npm install -g @slack/bolt',
    );
  });

  it('discord', async () => {
    await expect((await discord()).loadDiscordSdk(notInstalled('discord.js'))).rejects.toThrow(
      'Discord adapter needs discord.js; install it with npm install -g discord.js',
    );
  });

  it('email names every missing package', async () => {
    const { loadEmailSdk } = await email();
    await expect(
      loadEmailSdk({
        imapflow: notInstalled('imapflow'),
        mailparser: () => import('mailparser'),
        nodemailer: notInstalled('nodemailer'),
      }),
    ).rejects.toThrow(
      'Email adapter needs imapflow, nodemailer; install it with npm install -g imapflow nodemailer',
    );
  });

  it('passes through a failure that is not "not installed"', async () => {
    const broken = () => Promise.reject(new Error('grammy: syntax error in module'));
    await expect((await telegram()).loadTelegramSdk(broken)).rejects.toThrow(
      'grammy: syntax error in module',
    );
  });

  it('constructing an adapter before its SDK is loaded names the loader', async () => {
    const { grammy } = await telegram();
    expect(() => grammy()).toThrow('await loadTelegramSdk() before constructing TelegramAdapter');
  });

  it('each adapter package exports the loader loadAdapterModule calls', async () => {
    // That no adapter file imports its SDK at top level is pinned statically
    // by scripts/check-bundle-deps.sh; the SDKs are installed here, so a
    // runtime import could not show it.
    expect(
      typeof (await import('../../../../extensions/platform-telegram/src/index')).loadTelegramSdk,
    ).toBe('function');
    expect(
      typeof (await import('../../../../extensions/platform-slack/src/index')).loadSlackSdk,
    ).toBe('function');
    expect(
      typeof (await import('../../../../extensions/platform-discord/src/index')).loadDiscordSdk,
    ).toBe('function');
    expect(
      typeof (await import('../../../../extensions/platform-email/src/index')).loadEmailSdk,
    ).toBe('function');
  });
});
