import { describe, expect, it } from 'vitest';
import { detectSecrets, redactString } from '../index';

// S13 (plan openclaw-2026.9.6-gaps): seven credential shapes the roster in
// ../index.ts did not recognise. Each gets a positive case (a realistic value is
// replaced by its tag) and a negative case (the nearest ordinary text is left
// alone), so a widened pattern cannot start eating prose.
//
// Every fixture below is synthetic: the right shape, never a real credential.

// <bot id>:<35-char secret>; the secret begins `AA` in every token BotFather issues.
const TELEGRAM = '123456789:AAhJ3kL9mN2pQ7rS1tU5vW8xY0zB4cD6eFg';
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkV0aG9zIn0.' +
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAsyntheticsyntheticsyntheticsyntheticsynthetic',
  'c3ludGhldGljc3ludGhldGljc3ludGhldGljc3ludGhldGlj',
  '-----END RSA PRIVATE KEY-----',
].join('\n');
const ASIA = 'ASIAQX7EXAMPLE4ZK2M9';
const GITHUB_OAUTH = `gho_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
// A refresh token's body length is not pinned here, so the fixture is longer
// than the 36-char floor its pattern shares with gh[sou]_.
const GITHUB_REFRESH = `ghr_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'.repeat(2)}`;
const GOOGLE = 'AIzaSyD3xAmPlE-kEy_0123456789abcdefghij';
const BEARER = 'Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0ZZyy';

const CASES: Array<{
  name: string;
  secret: string;
  tag: string;
  label: string;
  nearMiss: string;
}> = [
  {
    name: 'Telegram bot token',
    secret: TELEGRAM,
    tag: '[REDACTED:telegram-token]',
    label: 'Telegram bot token',
    nearMiss: 'call at 12:30, ticket 123456789:open, ratio 20240925:1',
  },
  {
    name: 'JWT',
    secret: JWT,
    tag: '[REDACTED:jwt]',
    label: 'JWT',
    nearMiss: 'version 1.2.3 and the string eyJ alone and a.b.c',
  },
  {
    name: 'PEM private key',
    secret: PEM,
    tag: '[REDACTED:private-key]',
    label: 'PEM private key',
    nearMiss: '-----BEGIN CERTIFICATE-----\nMIIBsynthetic\n-----END CERTIFICATE-----',
  },
  {
    name: 'AWS temporary access key (ASIA)',
    secret: ASIA,
    tag: '[REDACTED:aws-key]',
    label: 'AWS temporary access key',
    nearMiss: 'ASIAN markets and ASIA-PACIFIC and ASIASHORT1',
  },
  {
    name: 'GitHub OAuth / app token (gh[sou]_)',
    secret: GITHUB_OAUTH,
    tag: '[REDACTED:github-token]',
    label: 'GitHub token',
    nearMiss: 'ghost_writer and gho_short and ghs_ alone',
  },
  {
    name: 'GitHub refresh token (ghr_)',
    secret: GITHUB_REFRESH,
    tag: '[REDACTED:github-token]',
    label: 'GitHub token',
    nearMiss: 'ghrelin levels, ghr_short, ghr_ alone, and ghr_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7_x',
  },
  {
    name: 'Google API key (AIza)',
    secret: GOOGLE,
    tag: '[REDACTED:google-api-key]',
    label: 'Google API key',
    nearMiss: 'AIzawl is not a key, nor is AIza_short',
  },
  {
    name: 'Bearer token',
    secret: BEARER,
    tag: '[REDACTED:bearer-token]',
    label: 'Bearer token',
    nearMiss: 'the Bearer of bad news; bearer bonds; Bearer tokenization',
  },
];

describe('redactString — S13 roster additions', () => {
  it.each(CASES)('redacts a $name', ({ secret, tag }) => {
    const result = redactString(`before ${secret} after`);
    expect(result).toBe(`before ${tag} after`);
  });

  it.each(CASES)('reports the $name label from detectSecrets', ({ secret, label }) => {
    expect(detectSecrets(secret).map((d) => d.label)).toContain(label);
  });

  it.each(CASES)('leaves ordinary text near a $name alone', ({ nearMiss }) => {
    expect(redactString(nearMiss)).toBe(nearMiss);
    expect(detectSecrets(nearMiss)).toEqual([]);
  });

  it('redacts a ghr_ token at the 36-char floor gh[sou]_ uses', () => {
    const atFloor = `ghr_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
    expect(redactString(`see ${atFloor} here`)).toBe('see [REDACTED:github-token] here');
  });

  it('redacts a Telegram token inside a Bot API URL', () => {
    expect(redactString(`https://api.telegram.org/bot${TELEGRAM}/sendMessage`)).toBe(
      'https://api.telegram.org/bot[REDACTED:telegram-token]/sendMessage',
    );
  });

  it('redacts an Authorization header carrying a JWT without leaking either part', () => {
    const result = redactString(`Authorization: Bearer ${JWT}`);
    expect(result).not.toContain('eyJ');
    expect(result).toContain('Authorization: Bearer [REDACTED:');
  });

  it('is idempotent — the new tags are not re-redacted', () => {
    const first = redactString(CASES.map((c) => c.secret).join(' '));
    expect(redactString(first)).toBe(first);
  });
});
