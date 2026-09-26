// `ethos secrets credential add|list|rm|grant|revoke` (plan reach-and-containment
// §4.2). Round-trips through the real vault layout, and scans every printed
// line for the values: the command prompts for them and must never echo one.

import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CredentialPrompt, runSecretsCredential } from '../secrets-credential';

const USERNAME = 'alice.operator@example.com';
const PASSWORD = 'correct-horse-battery-9';
const TOTP = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

let printed: string[] = [];
let written: string[] = [];

beforeEach(() => {
  printed = [];
  written = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    printed.push(a.map(String).join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function answers(...values: string[]): {
  prompt: CredentialPrompt;
  asked: Array<[string, boolean]>;
} {
  const asked: Array<[string, boolean]> = [];
  return {
    asked,
    prompt: async (q, { hidden }) => {
      asked.push([q, hidden]);
      return values.shift() ?? '';
    },
  };
}

function output(): string {
  return [...printed, ...written].join('\n');
}

function expectNoValues(): void {
  const all = output();
  for (const v of [USERNAME, PASSWORD, TOTP]) expect(all).not.toContain(v);
}

describe('ethos secrets credential', () => {
  it('add → list → grant → revoke → rm round-trip, printing no value', async () => {
    const secrets = new InMemorySecretsResolver();
    const { prompt, asked } = answers(USERNAME, PASSWORD, TOTP);
    await runSecretsCredential(
      ['add', 'gh', '--origin', 'https://github.com/', '--personality', 'researcher'],
      { secrets, prompt },
    );
    expect(process.exitCode).toBeUndefined();
    // Password and TOTP are asked without echo; the username is not secret-shaped.
    expect(asked.map(([, hidden]) => hidden)).toEqual([false, true, true]);
    expect(await secrets.get('credentials/gh/username')).toBe(USERNAME);
    expect(await secrets.get('credentials/gh/password')).toBe(PASSWORD);
    expect(await secrets.get('credentials/gh/totp')).toBe(TOTP);
    expect(JSON.parse((await secrets.get('credentials/gh/policy')) ?? '')).toEqual({
      origins: ['https://github.com'],
      personalities: ['researcher'],
      unattended: false,
    });

    await runSecretsCredential(['list'], { secrets });
    expect(output()).toContain('gh');
    expect(output()).toContain('https://github.com');
    expect(output()).toContain('….com'); // redactSecretValue: last 4 of a 16+ char value
    expect(output()).toMatch(/totp\s+yes/);

    await runSecretsCredential(['grant', 'gh', '--personality', 'engineer', '--unattended'], {
      secrets,
    });
    expect(JSON.parse((await secrets.get('credentials/gh/policy')) ?? '')).toEqual({
      origins: ['https://github.com'],
      personalities: ['researcher', 'engineer'],
      unattended: true,
    });

    await runSecretsCredential(['revoke', 'gh', '--personality', 'researcher', '--unattended'], {
      secrets,
    });
    expect(JSON.parse((await secrets.get('credentials/gh/policy')) ?? '')).toEqual({
      origins: ['https://github.com'],
      personalities: ['engineer'],
      unattended: false,
    });

    await runSecretsCredential(['rm', 'gh'], { secrets });
    expect(await secrets.list('credentials/')).toEqual([]);
    expectNoValues();
  });

  it('list --json carries masked previews only', async () => {
    const secrets = new InMemorySecretsResolver();
    await runSecretsCredential(['add', 'gh', '--origin', 'https://github.com'], {
      secrets,
      prompt: answers(USERNAME, PASSWORD, '').prompt,
    });
    await runSecretsCredential(['list', '--json'], { secrets });
    const json = written.join('');
    expect(json).toContain('"usernamePreview"');
    expect(json).toContain('"hasTotp":false');
    expectNoValues();
  });

  it('refuses a non-https origin, a bad TOTP seed and a bad name — vault untouched', async () => {
    const secrets = new InMemorySecretsResolver();
    for (const [args, answer] of [
      [
        ['add', 'a', '--origin', 'http://github.com'],
        [USERNAME, PASSWORD, ''],
      ],
      [
        ['add', 'b', '--origin', 'https://github.com'],
        [USERNAME, PASSWORD, 'otpauth://hotp/x?secret=GEZD'],
      ],
      [
        ['add', '../c', '--origin', 'https://github.com'],
        [USERNAME, PASSWORD, ''],
      ],
      [
        ['add', 'd'],
        [USERNAME, PASSWORD, ''],
      ],
    ] as const) {
      process.exitCode = undefined;
      await runSecretsCredential([...args], { secrets, prompt: answers(...answer).prompt });
      expect(process.exitCode).toBe(1);
    }
    expect(await secrets.list()).toEqual([]);
    expectNoValues();
  });

  it('allows http:// on loopback for local development', async () => {
    const secrets = new InMemorySecretsResolver();
    await runSecretsCredential(
      ['add', 'local', '--origin', 'http://127.0.0.1:8765', '--personality', 'researcher'],
      { secrets, prompt: answers(USERNAME, PASSWORD, '').prompt },
    );
    expect(process.exitCode).toBeUndefined();
    expect(await secrets.get('credentials/local/policy')).toContain('http://127.0.0.1:8765');
  });

  it('grant on a missing credential fails without inventing one', async () => {
    const secrets = new InMemorySecretsResolver();
    await runSecretsCredential(['grant', 'nope', '--personality', 'researcher'], { secrets });
    expect(process.exitCode).toBe(1);
    expect(await secrets.list()).toEqual([]);
  });
});
