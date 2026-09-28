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

// UBP-044 (plan upstream-bug-parity): a Discord bot token, and a secret carried
// under a NAME that says so (`DISCORD_BOT_TOKEN=`, `export ELEVENLABS_API_KEY=`,
// the JSON-key form), passed through with no detection. Synthetic fixtures.
const DISCORD = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GAbCdE.abcdefghijklmnopqrstuvwxyz0123';
const HEX32 = '0123456789abcdef0123456789abcdef';

describe('redactString — UBP-044 Discord token and secret-named values', () => {
  it('redacts a Discord bot token in prose, all three segments', () => {
    const result = redactString(`my bot token is ${DISCORD} ok`);
    expect(result).toBe('my bot token is [REDACTED:discord-token] ok');
    expect(detectSecrets(DISCORD).map((d) => d.label)).toContain('Discord bot token');
  });

  it('fully masks a Discord token behind token= (no trailing segments left)', () => {
    const result = redactString(`token=${DISCORD}`);
    expect(result).not.toContain('GAbCdE');
    expect(result).not.toContain('abcdefghij');
  });

  it.each([
    ['DISCORD_BOT_TOKEN=', DISCORD],
    ['ELEVENLABS_API_KEY=', HEX32],
    ['DEEPGRAM_API_KEY=', `dg${HEX32}`],
    ['export API_KEY=', HEX32],
    ['export OPENROUTER_API_KEY="', `${HEX32}"`],
    ['DB_PASSWORD: ', 'correcthorsebattery'],
    ['CLIENT_SECRET=', HEX32],
  ])('redacts the value of %s', (prefix, value) => {
    const result = redactString(`${prefix}${value}`);
    expect(result).not.toContain(value.replace(/"$/, ''));
    expect(result.startsWith(prefix)).toBe(true);
    expect(result).toContain('[REDACTED:');
    expect(detectSecrets(`${prefix}${value}`).length).toBeGreaterThan(0);
  });

  it('redacts the value of a secret-named JSON key and keeps the key', () => {
    expect(redactString(`{"DISCORD_BOT_TOKEN": "${DISCORD}"}`)).not.toContain('GAbCdE');
    expect(redactString(`{"elevenlabs_api_key": "${HEX32}", "voice": "rachel"}`)).toBe(
      '{"elevenlabs_api_key": "[REDACTED:secret-value]", "voice": "rachel"}',
    );
    expect(redactString(`{"apiKey":"${HEX32}"}`)).toBe('{"apiKey":"[REDACTED:secret-value]"}');
    expect(redactString(`{"password": "${HEX32}"}`)).toBe(
      '{"password": "[REDACTED:secret-value]"}',
    );
  });

  it('keeps the tag of a vendor pattern that matched first', () => {
    const xai = `xai-${'A1b2C3d4E5f6G7h8I9j0'.repeat(4)}`;
    expect(redactString(`XAI_API_KEY=${xai}`)).toBe('XAI_API_KEY=[REDACTED:xai-key]');
  });

  it.each([
    'tokenizer=bert-base-uncased-whole-word',
    'MAX_TOKENS=4096',
    'max_tokens: 4096',
    'OLDPWD=/home/someone/projects/long-directory-name',
    'GITHUB_TOKEN: $GITHUB_TOKEN_FROM_THE_RUNNER',
    `GITHUB_TOKEN: ${'$'}{{ secrets.GITHUB_TOKEN }}`,
    '{"key": "uploads/2026/09/profile-photo-large.png"}',
    '{"nextPageToken": "CAUQAAabcdefghijklmnop"}',
    '{"max_tokens": 4096, "token_count": 1234567890123456}',
    'DISCORD_BOT_TOKEN=short',
    'host mnopqrstuvwxyzabcdefghijkl.abc.def is fine',
  ])('leaves %s alone', (text) => {
    expect(redactString(text)).toBe(text);
    expect(detectSecrets(text)).toEqual([]);
  });

  it('is idempotent over the new tags', () => {
    const first = redactString(
      `DISCORD_BOT_TOKEN=${DISCORD} {"api_key": "${HEX32}"} prose ${DISCORD}`,
    );
    expect(redactString(first)).toBe(first);
  });
});

// UBP-045 (plan upstream-bug-parity): the OpenAI pattern had no left boundary
// and accepted any 40 kebab chars, so long lowercase identifiers and paths
// were masked into names that do not exist.
describe('redactString — UBP-045 OpenAI-key near-misses', () => {
  it.each([
    '/data/disk-usage-report-for-production-cluster-2026-09.csv',
    'git checkout fix/risk-assessment-for-payment-gateway-migration-v2',
    'task-runner-configuration-for-the-nightly-build-pipeline.yaml',
  ])('leaves %s unchanged', (text) => {
    expect(redactString(text)).toBe(text);
    expect(detectSecrets(text)).toEqual([]);
  });

  it.each([
    `sk-proj-${'Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4fGh7jKl0nOp3r'}`,
    `sk-${'T3BlbkFJa1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'}`,
    `sk-svcacct-${'Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4fGh7jKl0n'}`,
  ])('still redacts a real-shape key %#', (key) => {
    expect(redactString(`OPENAI=${key} and "${key}" and (${key})`)).toBe(
      'OPENAI=[REDACTED:openai-key] and "[REDACTED:openai-key]" and ([REDACTED:openai-key])',
    );
  });

  it.each([
    ['xai-', `xai-${'A1b2C3d4E5f6G7h8I9j0'}`],
    ['gsk_', `gsk_${'B1c2D3e4F5g6H7i8J9k0'}`],
    ['AKIA', 'AKIAQX7EXAMPLE4ZK2M9'],
    ['ghp_', `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`],
  ])('does not match a %s key glued to a preceding identifier', (_name, key) => {
    const glued = `prefix${key}`;
    expect(redactString(glued)).toBe(glued);
    expect(redactString(`x ${key} y`)).not.toContain(key);
  });
});

// V-ES-4 (plan upstream-bug-parity, fix round 1): common lowercase and
// embedded secret shapes passed through, because the Generic-secret rule wants
// whitespace or punctuation right before `key`/`token` and the secret-named
// rule is UPPER_SNAKE only. Synthetic fixtures; each keeps the name visible.
describe('redactString — V-ES-4 lowercase and embedded secret forms', () => {
  it.each([
    ['aws_secret_access_key = ', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['aws_access_key_id = ', 'EXAMPLEKEYID0123456'],
    ['//registry.npmjs.org/:_authToken=', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['api_key=', 'abcdef1234567890abcdef1234'],
    ['apiKey: ', 'abcdef1234567890abcdef1234'],
    ['db_password: ', 'supersecretvalue'],
    ['Password=', 'hunter2hunter2'],
    ['secret_key_base: ', '0123456789abcdef0123456789'],
    ['client_secret=', 'abcdef1234567890abcdef'],
    ['https://api.example.com/x?access_token=', 'abcdef1234567890abcdef'],
    ['https://api.example.com/x?a=1&api_key=', 'abcdef1234567890abcdef'],
    ['https://maps.example.com/js?token=', 'abcdef1234567890abcdef'],
    ['https://maps.example.com/js?v=3&key=', 'abcdef1234567890abcdef'],
  ])('redacts the value of %s', (prefix, value) => {
    const text = `${prefix}${value}&next=1`;
    const result = redactString(text);
    expect(result).not.toContain(value);
    expect(result.startsWith(prefix)).toBe(true);
    expect(result).toContain('[REDACTED:');
    expect(detectSecrets(text).length).toBeGreaterThan(0);
  });

  it.each([
    'max_tokens: 4096',
    'tokenizer=cl100k_base_tokenizer_v2',
    'password: required',
    'password_hash=pbkdf2_sha256_abcdefghijk',
    'passwordless=enabled_for_everyone',
    'access_token_expires_in=3600000000',
    'api_key_name: my-service-key-name',
    'https://api.example.com/items?page_token=CAUQAAabcdefghijklmnop',
    'https://api.example.com/items?next_page_token=CAUQAAabcdefghijklmnop',
    'https://api.example.com/items?pageToken=CAUQAAabcdefghijklmnop',
    'https://api.example.com/items?sort_key=created_at_descending',
    'https://example.com/?monkey=bananas_and_more',
    'https://example.com/?max_tokens=40964096',
    `api_key: ${'$'}{OPENAI_API_KEY_FROM_ENV}`,
    'password=$(cat /run/secrets/db_password)',
    'the api key is stored in the vault, not here',
  ])('leaves %s alone', (text) => {
    expect(redactString(text)).toBe(text);
    expect(detectSecrets(text)).toEqual([]);
  });

  it('is idempotent', () => {
    const first = redactString(
      'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ?token=abcdef1234567890',
    );
    expect(redactString(first)).toBe(first);
  });
});

// V2-SEC-4 (verify2-sec/shapes.mts): column-aligned assignments (terraform
// fmt, INI), standard credential names the lowercase list omitted, the
// `x-api-key` and `Authorization: Basic` headers, and a password in a URL's
// userinfo all passed through. And the UPPER rule redacted English prose
// (`PASSWORD: required`, `The SECRET: congratulations`).
describe('redactString — V2-SEC-4 shapes', () => {
  it.each([
    ['db_password     = "', 'SuperSecretValue123'],
    ['db_password      = "', 'SuperSecretValue123'],
    ['DB_PASSWORD          = ', 'SuperSecretValue123'],
    ['password:     ', 'hunter2hunter2hunter2'],
    ['  password:   ', 'hunter2hunter2hunter2'],
    ['aws_session_token = ', 'FwoGZXIvYXdzEBYaDHqa0AP1b2c3d4e5f6g7h8i9j0'],
    ['api_token = "', 'abcdef1234567890abcdef'],
    ['cloudflare_api_token = "', 'abcdef1234567890abcdef'],
    ['session_token: ', 'abcdef1234567890abcdef1234'],
    ['bearer_token=', 'abcdef1234567890abcdef1234'],
    ['x-api-key: ', 'abcdef1234567890abcdef1234'],
    ['X-Api-Key:', 'abcdef1234567890abcdef1234'],
    ['Authorization: Basic ', 'dXNlcjpwYXNzd29yZDEyMzQ1Njc4OTA='],
    ['Proxy-Authorization: Basic ', 'YWxpY2U6czNjcjN0'],
    ['mysql://root:', 'SuperSecretValue123'],
    ['postgres://app_user:', 'pw'],
    ['https://alice:', 'S3cretProxyPw'],
  ])('redacts the value of %s', (prefix, value) => {
    const suffix = prefix.startsWith('mysql') || prefix.includes('://') ? '@db:3306/app' : '';
    const text = `${prefix}${value}${suffix}`;
    const result = redactString(text);
    expect(result).not.toContain(value);
    expect(result.startsWith(prefix)).toBe(true);
    expect(result).toContain('[REDACTED:');
    expect(detectSecrets(text).length).toBeGreaterThan(0);
  });

  it.each([
    'PASSWORD: required',
    'The SECRET: congratulations',
    'API_KEY: Optional',
    'DB_PASSWORD: <your-password>',
    'API_TOKEN: ********',
    'password:   required.',
    'Authorization: Basic authentication is disabled',
    'see https://example.com:8080/path for details',
    'git@github.com:org/repo.git',
    'ssh://git@github.com/org/repo',
  ])('leaves %s alone', (text) => {
    expect(redactString(text)).toBe(text);
  });

  it('still redacts a letters-only value assigned with `=`', () => {
    expect(redactString('DB_PASSWORD=supersecretpass')).toBe('DB_PASSWORD=[REDACTED:secret-value]');
  });
});
