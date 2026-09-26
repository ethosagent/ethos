import { afterEach, describe, expect, it, vi } from 'vitest';

// B8 (plan ux-feedback-and-config-clarity) — `secrets list`'s source column
// and `secrets get`'s reveal gate. `secretSource` answers "would the merged
// resolver's env reader win for this ref" with the real EnvSecretsResolver.

vi.mock('../wiring', () => ({
  getSecretsResolver: async () => ({}),
}));

import { revealDecision, secretSource } from '../commands/secrets';

describe('secretSource', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('reports env when the recognised env var is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    expect(await secretSource('providers/anthropic/apiKey')).toBe('env');
  });

  it('reports vault when no env var shadows the ref', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await secretSource('providers/anthropic/apiKey')).toBe('vault');
    expect(await secretSource('telegram/token')).toBe('vault');
  });
});

describe('revealDecision — secrets get plaintext gate', () => {
  it('--reveal always prints', () => {
    expect(revealDecision({ reveal: true, isTTY: true })).toBe('yes');
    expect(revealDecision({ reveal: true, isTTY: false })).toBe('yes');
  });

  it('a TTY without --reveal confirms first', () => {
    expect(revealDecision({ reveal: false, isTTY: true })).toBe('confirm');
  });

  it('a non-TTY without --reveal refuses', () => {
    expect(revealDecision({ reveal: false, isTTY: false })).toBe('refuse');
  });

  it('--json counts as explicit intent: no refusal on a pipe, no prompt on a TTY', () => {
    // Scripted `ethos secrets get <ref> --json` must yield the value in JSON.
    expect(revealDecision({ reveal: false, isTTY: false, json: true })).toBe('yes');
    // And a TTY `--json` must not inject a y/N prompt into the JSON stream.
    expect(revealDecision({ reveal: false, isTTY: true, json: true })).toBe('yes');
  });
});
