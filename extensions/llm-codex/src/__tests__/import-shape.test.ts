import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectExternalLogin, importFromFile } from '../auth';

/** Fake 3-part JWT built in-test; never a real credential. */
function fakeJwt(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}

const EXP = 4_000_000_000;
const ACCESS = fakeJwt({ exp: EXP, sub: 'user-access' });
const ID = fakeJwt({ sub: 'user-sub' });

describe('importFromFile / detectExternalLogin shapes', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codex-import-shape-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, body: unknown): Promise<string> {
    const p = join(dir, name);
    await writeFile(p, JSON.stringify(body), 'utf-8');
    return p;
  }

  it('imports the flat top-level shape', async () => {
    const p = await write('flat.json', {
      access_token: ACCESS,
      refresh_token: 'rt-flat',
      id_token: ID,
      account_id: 'acct-flat',
    });
    const creds = await importFromFile(p);
    expect(creds?.accessToken).toBe(ACCESS);
    expect(creds?.refreshToken).toBe('rt-flat');
    expect(creds?.accountId).toBe('acct-flat');
    expect(creds?.expiresAt).toBe(new Date(EXP * 1000).toISOString());
  });

  it('imports the nested Codex CLI shape ({ tokens: {...}, last_refresh })', async () => {
    const p = await write('nested.json', {
      OPENAI_API_KEY: null,
      tokens: {
        access_token: ACCESS,
        refresh_token: 'rt-nested',
        id_token: ID,
        account_id: 'acct-nested',
      },
      last_refresh: '2026-10-01T00:00:00.000Z',
    });
    const creds = await importFromFile(p);
    expect(creds?.accessToken).toBe(ACCESS);
    expect(creds?.refreshToken).toBe('rt-nested');
    expect(creds?.idToken).toBe(ID);
    expect(creds?.accountId).toBe('acct-nested');
    expect(creds?.updatedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('nested shape falls back to the id_token sub when account_id is missing', async () => {
    const p = await write('nested-noacct.json', {
      tokens: { access_token: ACCESS, refresh_token: 'rt', id_token: ID },
    });
    expect((await importFromFile(p))?.accountId).toBe('user-sub');
  });

  it('returns null when a token is missing, the file is absent, or it is not JSON', async () => {
    expect(
      await importFromFile(await write('partial.json', { tokens: { access_token: ACCESS } })),
    ).toBeNull();
    expect(await importFromFile(join(dir, 'nope.json'))).toBeNull();
    const bad = join(dir, 'bad.json');
    await writeFile(bad, 'not json', 'utf-8');
    expect(await importFromFile(bad)).toBeNull();
  });

  it('detectExternalLogin reports presence only, never token material', async () => {
    const p = await write('nested.json', {
      tokens: { access_token: ACCESS, refresh_token: 'rt-secret', id_token: ID },
    });
    const found = await detectExternalLogin(p);
    expect(found).toEqual({ present: true });
    expect(JSON.stringify(found)).not.toContain('rt-secret');
    expect(JSON.stringify(found)).not.toContain(ACCESS);
  });

  it('detectExternalLogin returns null for absent, malformed, or token-less files', async () => {
    expect(await detectExternalLogin(join(dir, 'nope.json'))).toBeNull();
    expect(await detectExternalLogin(await write('empty.json', {}))).toBeNull();
    expect(
      await detectExternalLogin(await write('partial.json', { tokens: { access_token: 'x' } })),
    ).toBeNull();
  });
});
