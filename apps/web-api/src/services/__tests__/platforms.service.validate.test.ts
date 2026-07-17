import { describe, expect, it, vi } from 'vitest';
import { PlatformsService } from '../platforms.service';

// Mock the shared validators so the service test never hits the network.
const telegram = vi.fn();
const slack = vi.fn();
const discord = vi.fn();
vi.mock('@ethosagent/platform-telegram/validate', () => ({
  validateTelegramToken: (...a: unknown[]) => telegram(...a),
}));
vi.mock('@ethosagent/platform-slack/validate', () => ({
  validateSlackToken: (...a: unknown[]) => slack(...a),
}));
vi.mock('@ethosagent/platform-discord/validate', () => ({
  validateDiscordToken: (...a: unknown[]) => discord(...a),
}));

// The repository is unused by validate(); a bare stub satisfies the constructor.
function makeService() {
  return new PlatformsService({ repo: {} as never });
}

describe('PlatformsService.validate — W2.1 liveness mapping', () => {
  it('maps a successful Telegram probe to ok + label', async () => {
    telegram.mockResolvedValue({ ok: true, label: '@mybot' });
    const out = await makeService().validate('telegram', { token: 'good' });
    expect(out).toEqual({ status: 'ok', label: '@mybot', error: null });
    expect(telegram).toHaveBeenCalledWith('good');
  });

  it('maps a rejected token to status rejected (no label)', async () => {
    telegram.mockResolvedValue({ ok: false, error: 'Invalid token', reason: 'rejected' });
    const out = await makeService().validate('telegram', { token: 'bad' });
    expect(out).toEqual({ status: 'rejected', label: null, error: 'Invalid token' });
  });

  it('maps an unreachable probe to status unreachable', async () => {
    slack.mockResolvedValue({ ok: false, error: 'Slack returned 503', reason: 'unreachable' });
    const out = await makeService().validate('slack', { botToken: 'x' });
    expect(out).toEqual({ status: 'unreachable', label: null, error: 'Slack returned 503' });
    expect(slack).toHaveBeenCalledWith('x');
  });

  it('reads the Discord token from the token field', async () => {
    discord.mockResolvedValue({ ok: true, label: 'BotName' });
    const out = await makeService().validate('discord', { token: 'd' });
    expect(out.status).toBe('ok');
    expect(discord).toHaveBeenCalledWith('d');
  });

  it('returns unsupported for email (no probe)', async () => {
    const out = await makeService().validate('email', { user: 'a@b.com' });
    expect(out).toEqual({ status: 'unsupported', label: null, error: null });
  });
});
