// CredentialsService — the web store surface for `browser_fill_credential`
// logins (plan reach-and-containment §4.2). Values are write-only: `list`
// never returns one, and a bad field refuses before anything is written.

import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { isEthosError } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { CredentialsService } from '../../services/credentials.service';

const USERNAME = 'alice.operator@example.com';
const PASSWORD = 'correct-horse-battery-9';
const TOTP = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function service() {
  const secrets = new InMemorySecretsResolver();
  return { secrets, svc: new CredentialsService({ secrets }) };
}

const base = {
  name: 'gh',
  username: USERNAME,
  password: PASSWORD,
  totp: TOTP,
  origins: ['https://github.com'],
  personalities: ['researcher'],
  unattended: false,
};

async function expectInvalid(p: Promise<unknown>): Promise<void> {
  try {
    await p;
    expect.unreachable('expected INVALID_INPUT');
  } catch (err) {
    expect(isEthosError(err) && err.code).toBe('INVALID_INPUT');
    // A refusal must not quote a value either.
    const text = JSON.stringify(err, Object.getOwnPropertyNames(err));
    for (const v of [PASSWORD, TOTP]) expect(text).not.toContain(v);
  }
}

describe('CredentialsService', () => {
  it('list never returns a value — masked preview and presence flags only', async () => {
    const { svc } = service();
    await svc.set(base);
    const { credentials } = await svc.list();
    expect(credentials).toEqual([
      {
        name: 'gh',
        origins: ['https://github.com'],
        personalities: ['researcher'],
        unattended: false,
        usernamePreview: '….com',
        hasPassword: true,
        hasTotp: true,
        policyValid: true,
      },
    ]);
    const json = JSON.stringify(credentials);
    for (const v of [USERNAME, PASSWORD, TOTP]) expect(json).not.toContain(v);
  });

  it('set validates the name', async () => {
    const { svc, secrets } = service();
    await expectInvalid(svc.set({ ...base, name: '../escape' }));
    expect(await secrets.list()).toEqual([]);
  });

  it('set validates origins: bare https only, http on loopback', async () => {
    const { svc, secrets } = service();
    for (const origin of [
      'http://github.com',
      'https://github.com/login',
      'https://github.com?x=1',
      'ftp://github.com',
      'not a url',
    ]) {
      await expectInvalid(svc.set({ ...base, origins: [origin] }));
    }
    await expectInvalid(svc.set({ ...base, origins: [] }));
    expect(await secrets.list()).toEqual([]);
    await svc.set({ ...base, origins: ['http://localhost:3000', 'https://GitHub.com/'] });
    const [row] = (await svc.list()).credentials;
    expect(row?.origins).toEqual(['http://localhost:3000', 'https://github.com']);
  });

  it('set validates personality ids', async () => {
    const { svc, secrets } = service();
    await expectInvalid(svc.set({ ...base, personalities: ['../root'] }));
    await expectInvalid(svc.set({ ...base, personalities: ['has space'] }));
    expect(await secrets.list()).toEqual([]);
  });

  it('set validates the TOTP seed without quoting it', async () => {
    const { svc, secrets } = service();
    await expectInvalid(svc.set({ ...base, totp: 'otpauth://hotp/x?secret=GEZD&counter=1' }));
    await expectInvalid(
      svc.set({ ...base, totp: `otpauth://totp/x?secret=${TOTP}&algorithm=MD5` }),
    );
    await expectInvalid(svc.set({ ...base, totp: '!!!not-base32' }));
    expect(await secrets.list()).toEqual([]);
  });

  it('a new login needs username and password; an edit may omit them', async () => {
    const { svc, secrets } = service();
    const { username: _u, password: _p, ...rest } = base;
    await expectInvalid(svc.set(rest));
    await svc.set(base);
    await svc.set({ ...rest, personalities: ['engineer'], totp: null });
    expect(await secrets.get('credentials/gh/password')).toBe(PASSWORD);
    expect(await secrets.get('credentials/gh/totp')).toBeNull();
    expect((await svc.list()).credentials[0]?.personalities).toEqual(['engineer']);
  });

  it('delete removes all four refs', async () => {
    const { svc, secrets } = service();
    await svc.set(base);
    expect((await secrets.list('credentials/gh/')).sort()).toEqual([
      'credentials/gh/password',
      'credentials/gh/policy',
      'credentials/gh/totp',
      'credentials/gh/username',
    ]);
    await svc.delete({ name: 'gh' });
    expect(await secrets.list('credentials/')).toEqual([]);
    expect((await svc.list()).credentials).toEqual([]);
  });

  it('reports a login whose policy is unreadable as invalid rather than hiding it', async () => {
    const { svc, secrets } = service();
    await svc.set(base);
    await secrets.set('credentials/gh/policy', '{broken');
    expect((await svc.list()).credentials[0]).toMatchObject({ name: 'gh', policyValid: false });
  });
});
