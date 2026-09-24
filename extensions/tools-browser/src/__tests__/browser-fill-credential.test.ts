// `browser_fill_credential` (plan reach-and-containment Part 4, §4.4).
//
// Two halves:
//   • fake-page suites — always run. Policy, personality, unattended, audit,
//     the Playwright-error path and the owner-frame origin check, against a
//     stub page, so the gates are pinned even where no browser is installed.
//   • real-Chromium suites — the fill itself, exact origin matching, iframes,
//     the password-field gate and `origin_changed`, against a loopback HTTP
//     fixture. Skipped when no Playwright Chromium is on disk (HAS_CHROMIUM).
//
// Every suite scans what the model could read — the result, the error string,
// every progress event and every audit event — for the username, password,
// TOTP seed and TOTP codes. Remove `withSecretMask` from `createBrowserTools`
// and "fills username + password on the bound origin" fails on the snapshot;
// remove the `originAllowed` check in `checkOrigins` and every origin case fails.

import type { ClarifyBridge } from '@ethosagent/core';
import type { Tool, ToolResult } from '@ethosagent/types';
import type { BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type CredentialFillAuditEvent,
  createBrowserFillCredentialTool,
} from '../browser-fill-credential';
import { setCredential, updateCredentialPolicy } from '../credential-vault';
import { createBrowserTools } from '../index';
import {
  type BrowserSession,
  closeSession,
  getOrCreateSessionWithRoute,
  makeMapKey,
  policyFingerprint,
  sessions,
} from '../sessions';
import { snapshotPage } from '../snapshot';
import { totpCode } from '../totp';
import {
  type Fixture,
  HAS_CHROMIUM,
  makeCtx,
  memoryVault,
  PASSWORD,
  POLICY,
  refFor,
  scopedCredentials,
  secretNeedles,
  startFixture,
  storeCredential,
  TOTP_SEED,
  USERNAME,
} from './credential-fixture';

// `import.meta.resolve` is not answerable under vitest; the availability test
// is about the audit sink, so Playwright is reported installed, as in
// browser-computed-style.test.ts.
vi.mock('../sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessions')>()),
  isPlaywrightInstalled: () => true,
}));

const presentingBridge = { canPresent: (s: string) => s === 'cli' } as unknown as ClarifyBridge;
const silentBridge = { canPresent: () => false } as unknown as ClarifyBridge;

function fillTool(opts: { audit?: CredentialFillAuditEvent[]; bridge?: ClarifyBridge }): Tool {
  const audit = opts.audit;
  const tool = createBrowserTools({
    ...(audit ? { recordCredentialFill: (e) => audit.push(e) } : {}),
    clarifyBridge: opts.bridge ?? presentingBridge,
  }).find((t) => t.name === 'browser_fill_credential');
  if (!tool) throw new Error('browser_fill_credential not registered');
  return tool;
}

function codesAroundNow(): string[] {
  const now = Date.now();
  return [now - 30_000, now, now + 30_000].map((t) => totpCode(TOTP_SEED, t));
}

/** Assert no secret appears anywhere the model or the audit log could read. */
function expectNoLeak(
  result: ToolResult,
  events: unknown[],
  audit: CredentialFillAuditEvent[],
): void {
  const haystack = [JSON.stringify(result), JSON.stringify(events), JSON.stringify(audit)].join(
    '\n',
  );
  for (const needle of secretNeedles(codesAroundNow())) {
    expect(haystack).not.toContain(needle);
  }
}

// ---------------------------------------------------------------------------
// Fake page — gates that need no browser
// ---------------------------------------------------------------------------

interface FakeOpts {
  pageUrl?: string;
  frameUrl?: string;
  passwordIsPassword?: boolean;
  fillThrows?: boolean;
}

function fakeSession(sessionId: string, o: FakeOpts = {}) {
  const filled: Record<string, string> = {};
  const makeHandle = (name: string) => ({
    ownerFrame: async () => ({ url: () => o.frameUrl ?? o.pageUrl ?? 'https://bank.example/' }),
    evaluate: async () => (name === 'Password' ? (o.passwordIsPassword ?? true) : false),
    fill: async (value: string) => {
      if (o.fillThrows && value !== '') {
        // What a real Playwright timeout message looks like — it quotes the arg.
        throw new Error(`locator.fill: Timeout 10000ms exceeded.\n  - fill("${value}")`);
      }
      filled[name] = value;
    },
    press: async () => {},
  });
  const page = {
    url: () => o.pageUrl ?? 'https://bank.example/login',
    title: async () => 'Bank',
    waitForTimeout: async () => {},
    getByRole: (_role: string, { name }: { name: string }) => ({
      first: () => ({
        count: async () => 1,
        elementHandle: async () => makeHandle(name),
      }),
    }),
    locator: () => ({
      ariaSnapshot: async () =>
        `- textbox "Username": ${filled.Username ?? ''}\n- textbox "Password": ${filled.Password ?? ''}`,
    }),
  } as unknown as Page;
  const session: BrowserSession = {
    context: {} as BrowserContext,
    page,
    refs: new Map([
      ['@e1', { ref: '@e1', role: 'textbox', name: 'Username' }],
      ['@e2', { ref: '@e2', role: 'textbox', name: 'Password' }],
    ]),
    lastUrl: '',
    policyFingerprint: policyFingerprint(POLICY),
    consoleLogs: [],
    tier: 'stock',
    pendingWarnings: [],
    lastActiveAt: Date.now(),
    close: async () => {},
  };
  sessions.set(makeMapKey(sessionId, POLICY), session);
  return { session, filled };
}

describe('browser_fill_credential — gates (fake page)', () => {
  afterEach(() => sessions.clear());

  async function run(
    o: FakeOpts & {
      personalities?: string[];
      unattended?: boolean;
      policy?: 'missing' | 'garbage';
      ctx?: Parameters<typeof makeCtx>[2];
      bridge?: ClarifyBridge;
      args?: Record<string, unknown>;
    } = {},
  ) {
    const vault = memoryVault();
    await storeCredential(vault, ['https://bank.example'], {
      ...(o.personalities ? { personalities: o.personalities } : {}),
      ...(o.unattended !== undefined ? { unattended: o.unattended } : {}),
    });
    if (o.policy === 'missing') await vault.delete('credentials/test-login/policy');
    if (o.policy === 'garbage') await vault.set('credentials/test-login/policy', '{nope');
    const { filled } = fakeSession('fake', o);
    const audit: CredentialFillAuditEvent[] = [];
    const { ctx, events } = makeCtx('fake', scopedCredentials(vault), o.ctx);
    const result = await fillTool({ audit, ...(o.bridge ? { bridge: o.bridge } : {}) }).execute(
      o.args ?? { credential: 'test-login', username_ref: '@e1', password_ref: '@e2' },
      ctx,
    );
    expectNoLeak(result, events, audit);
    return { result, audit, filled, events };
  }

  it('fills on the bound origin and returns only the masked snapshot', async () => {
    const { result, audit, filled } = await run();
    expect(result.ok).toBe(true);
    expect(filled).toEqual({ Username: USERNAME, Password: PASSWORD });
    if (result.ok) {
      expect(result.value).toContain('••••••');
      expect(result.value).toContain('"filled":["username","password"]');
    }
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ code: 'filled', severity: 'info' });
  });

  it('refuses when ctx.personalityId is not in policy.personalities', async () => {
    const { result, audit, filled } = await run({ ctx: { personalityId: 'intruder' } });
    expect(result.ok).toBe(false);
    expect(filled).toEqual({});
    expect(audit.map((a) => a.code)).toEqual(['refused_personality']);
    expect(audit[0]?.severity).toBe('warn');
  });

  it('refuses an empty personalities list — usable by nobody', async () => {
    const { result, audit } = await run({ personalities: [] });
    expect(result.ok).toBe(false);
    expect(audit.map((a) => a.code)).toEqual(['refused_personality']);
  });

  it('refuses when policy is missing, and when it is unparseable', async () => {
    for (const policy of ['missing', 'garbage'] as const) {
      const { result, audit, filled } = await run({ policy });
      expect(result.ok).toBe(false);
      expect(filled).toEqual({});
      expect(audit.map((a) => a.code)).toEqual(['not_found']);
      sessions.clear();
    }
  });

  it('refuses a background job (jobId set) unless the policy opts in', async () => {
    const refused = await run({ ctx: { jobId: 'job-1' } });
    expect(refused.result.ok).toBe(false);
    expect(refused.audit.map((a) => a.code)).toEqual(['refused_unattended']);
    expect(refused.audit[0]?.details.jobId).toBe('job-1');
    sessions.clear();
    const allowed = await run({ ctx: { jobId: 'job-1' }, unattended: true });
    expect(allowed.result.ok).toBe(true);
    expect(allowed.audit.map((a) => a.code)).toEqual(['filled']);
  });

  it('refuses when the clarify bridge cannot present on ctx.platform', async () => {
    const refused = await run({ bridge: silentBridge });
    expect(refused.audit.map((a) => a.code)).toEqual(['refused_unattended']);
    sessions.clear();
    const allowed = await run({ bridge: silentBridge, unattended: true });
    expect(allowed.audit.map((a) => a.code)).toEqual(['filled']);
  });

  it('refuses when the target element sits in a frame on an unlisted origin', async () => {
    const { result, audit, filled } = await run({ frameUrl: 'https://evil.example/frame' });
    expect(result.ok).toBe(false);
    expect(filled).toEqual({});
    expect(audit.map((a) => a.code)).toEqual(['refused_origin']);
    expect(audit[0]?.details.frameOrigins).toContain('https://evil.example');
  });

  it('refuses a listed-origin frame inside an unlisted top page', async () => {
    const { audit, filled } = await run({
      pageUrl: 'https://evil.example/',
      frameUrl: 'https://bank.example/login',
    });
    expect(filled).toEqual({});
    expect(audit.map((a) => a.code)).toEqual(['refused_origin']);
  });

  it('matches exactly — a suffix look-alike never matches', async () => {
    for (const pageUrl of [
      'https://bank.example.evil.io/',
      'https://evil.bank.example/',
      'http://bank.example/',
      'https://bank.example:8443/',
    ]) {
      const { audit, filled } = await run({ pageUrl });
      expect(filled).toEqual({});
      expect(audit.map((a) => a.code)).toEqual(['refused_origin']);
      sessions.clear();
    }
  });

  it('refuses password_ref pointing at a non-password input', async () => {
    const { audit, filled } = await run({ passwordIsPassword: false });
    expect(filled).toEqual({});
    expect(audit.map((a) => a.code)).toEqual(['refused_field_type']);
  });

  it('a Playwright error never reaches the result — fixed message, fields cleared', async () => {
    const { result, audit, filled } = await run({ fillThrows: true });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBe('The credential fill could not be completed in the browser.');
    expect(audit.map((a) => a.code)).toEqual(['error']);
    expect(filled.Username ?? '').toBe('');
  });

  it('refuses an unknown element ref and a missing credential as not_found', async () => {
    const badRef = await run({ args: { credential: 'test-login', password_ref: '@e99' } });
    expect(badRef.audit.map((a) => a.code)).toEqual(['not_found']);
    sessions.clear();
    const noCred = await run({ args: { credential: 'nope', password_ref: '@e2' } });
    expect(noCred.audit.map((a) => a.code)).toEqual(['not_found']);
  });

  it('requires at least one ref and a valid name; still one audit event per call', async () => {
    const none = await run({ args: { credential: 'test-login' } });
    expect(none.result.ok).toBe(false);
    expect(none.audit).toHaveLength(1);
    sessions.clear();
    const badName = await run({ args: { credential: '../x', password_ref: '@e2' } });
    expect(badName.result.ok).toBe(false);
    expect(badName.audit).toHaveLength(1);
    expect(badName.audit[0]?.details.credential).toBe('<invalid>');
  });

  it('the audit event carries metadata only', async () => {
    const { audit } = await run();
    expect(audit[0]?.details).toEqual({
      credential: 'test-login',
      fields: ['username', 'password'],
      origin: 'https://bank.example',
      frameOrigins: ['https://bank.example', 'https://bank.example'],
      personalityId: 'researcher',
      sessionId: 'fake',
      jobId: null,
    });
  });

  it('the schema has no value property (D4-1)', () => {
    const props = Object.keys(
      (fillTool({}).schema as { properties: Record<string, unknown> }).properties,
    );
    expect(props.sort()).toEqual([
      'credential',
      'password_ref',
      'submit',
      'totp_ref',
      'username_ref',
    ]);
  });

  it('is unavailable when recordCredentialFill is not supplied (D4-8)', () => {
    const timeouts = { navigationMs: 30_000, commandMs: 10_000 };
    expect(createBrowserFillCredentialTool({ timeouts }).isAvailable?.()).toBe(false);
    expect(
      createBrowserFillCredentialTool({ timeouts, recordCredentialFill: () => {} }).isAvailable?.(),
    ).toBe(true);
    expect(fillTool({}).isAvailable?.()).toBe(false);
  });

  it('refuses a non-loopback http: origin at store time', async () => {
    const vault = memoryVault();
    await expect(
      setCredential(vault, {
        name: 'x',
        username: 'u',
        password: 'p',
        origins: ['http://bank.example'],
        personalities: ['researcher'],
      }),
    ).rejects.toThrow(/not an https origin/);
    expect(await vault.list()).toEqual([]);
  });

  it('refuses a non-loopback http: origin at fill even if the policy was hand-edited', async () => {
    const vault = memoryVault();
    await storeCredential(vault, ['https://bank.example']);
    await vault.set(
      'credentials/test-login/policy',
      JSON.stringify({ origins: ['http://bank.example'], personalities: ['researcher'] }),
    );
    fakeSession('fake', { pageUrl: 'http://bank.example/' });
    const audit: CredentialFillAuditEvent[] = [];
    const { ctx } = makeCtx('fake', scopedCredentials(vault));
    const result = await fillTool({ audit }).execute(
      { credential: 'test-login', password_ref: '@e2' },
      ctx,
    );
    expect(result.ok).toBe(false);
    // A tampered policy fails closed as "no usable credential".
    expect(audit.map((a) => a.code)).toEqual(['not_found']);
  });
});

// ---------------------------------------------------------------------------
// Real Chromium against a loopback fixture
// ---------------------------------------------------------------------------

// Real Chromium under a loaded full-suite run needs more than the 15s default.
describe.skipIf(!HAS_CHROMIUM)(
  'browser_fill_credential — real Chromium',
  { timeout: 60_000 },
  () => {
    let fx: Fixture;
    beforeAll(async () => {
      fx = await startFixture();
    }, 60_000);
    afterAll(async () => {
      await fx.close();
    });
    afterEach(async () => {
      await closeSession('real');
    }, 60_000);

    async function open(path: string, origin?: string) {
      const session = await getOrCreateSessionWithRoute('real', POLICY);
      await session.page.goto(`${origin ?? fx.originA}${path}`);
      const snap = await snapshotPage(session.page);
      session.refs = snap.refs;
      return session;
    }

    async function fill(
      session: BrowserSession,
      fields: Array<'Username' | 'Password' | 'Code'>,
      opts: {
        origins?: string[];
        unattended?: boolean;
        bridge?: ClarifyBridge;
        ctx?: Parameters<typeof makeCtx>[2];
      } = {},
    ) {
      const vault = memoryVault();
      await storeCredential(vault, opts.origins ?? [fx.originA], {
        totp: true,
        ...(opts.unattended !== undefined ? { unattended: opts.unattended } : {}),
      });
      const audit: CredentialFillAuditEvent[] = [];
      const { ctx, events } = makeCtx('real', scopedCredentials(vault), opts.ctx);
      const args: Record<string, unknown> = { credential: 'test-login' };
      if (fields.includes('Username')) args.username_ref = refFor(session, 'Username');
      if (fields.includes('Password')) args.password_ref = refFor(session, 'Password');
      if (fields.includes('Code')) args.totp_ref = refFor(session, 'Code');
      const result = await fillTool({
        audit,
        ...(opts.bridge ? { bridge: opts.bridge } : {}),
      }).execute(args, ctx);
      expectNoLeak(result, events, audit);
      return { result, audit, events };
    }

    const inputValue = (session: BrowserSession, id: string) =>
      session.page.evaluate((i) => (document.getElementById(i) as HTMLInputElement).value, id);

    it('fills username + password + TOTP on the bound origin; result holds none of them', async () => {
      const session = await open('/login');
      const { result, audit } = await fill(session, ['Username', 'Password', 'Code']);
      expect(result.ok).toBe(true);
      expect(await inputValue(session, 'u')).toBe(USERNAME);
      expect(await inputValue(session, 'p')).toBe(PASSWORD);
      expect(codesAroundNow()).toContain(await inputValue(session, 'c'));
      if (result.ok) expect(result.value).toContain('••••••');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ code: 'filled', details: { origin: fx.originA } });
    });

    it('injected page on a foreign origin: refused no matter what the page says', async () => {
      const session = await open('/evil', fx.originB);
      const { result, audit } = await fill(session, ['Username', 'Password']);
      expect(result.ok).toBe(false);
      expect(await inputValue(session, 'u')).toBe('');
      expect(await inputValue(session, 'p')).toBe('');
      expect(audit.map((a) => a.code)).toEqual(['refused_origin']);
      expect(audit[0]?.details.origin).toBe(fx.originB);
    });

    it('a listed-origin iframe inside an unlisted top page is refused', async () => {
      const session = await open('/embeds-bound', fx.originB);
      const { audit } = await fill(session, ['Password']);
      expect(await inputValue(session, 'p')).toBe('');
      expect(audit.map((a) => a.code)).toEqual(['refused_origin']);
    });

    it('a field inside an unlisted-origin iframe cannot be targeted at all', async () => {
      // The snapshot does not descend into iframes and `page.getByRole` does not
      // pierce them, so a ref naming the framed field resolves to nothing.
      const session = await open('/framed-foreign');
      session.refs.set('@e90', { ref: '@e90', role: 'textbox', name: 'Password' });
      const vault = memoryVault();
      await storeCredential(vault, [fx.originA]);
      const audit: CredentialFillAuditEvent[] = [];
      const { ctx } = makeCtx('real', scopedCredentials(vault));
      const result = await fillTool({ audit }).execute(
        { credential: 'test-login', password_ref: '@e90' },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(audit.map((a) => a.code)).toEqual(['not_found']);
      const frame = session.page.frames().find((f) => f !== session.page.mainFrame());
      expect(
        await frame?.evaluate(() => (document.getElementById('p') as HTMLInputElement).value),
      ).toBe('');
    });

    it('origin match is exact: 127.0.0.1:P listed, localhost:P refused', async () => {
      const session = await open('/login', fx.localhostA);
      const { audit } = await fill(session, ['Password']);
      expect(await inputValue(session, 'p')).toBe('');
      expect(audit.map((a) => a.code)).toEqual(['refused_origin']);
    });

    it('refuses password_ref pointing at type=text', async () => {
      const session = await open('/text-password');
      const { audit } = await fill(session, ['Password']);
      expect(audit.map((a) => a.code)).toEqual(['refused_field_type']);
      const value = await session.page.getByRole('textbox', { name: 'Password' }).inputValue();
      expect(value).toBe('');
    });

    it('origin_changed: the page navigates on focus; call fails and the field is empty', async () => {
      const session = await open('/nav-on-focus');
      const { result, audit } = await fill(session, ['Password']);
      expect(result.ok).toBe(false);
      expect(audit.map((a) => a.code)).toEqual(['origin_changed']);
      expect(new URL(session.page.url()).origin).toBe(fx.localhostA);
      expect(await inputValue(session, 'p')).toBe('');
    });

    it('unattended: canPresent false refused, unattended:true fills', async () => {
      const session = await open('/login');
      const refused = await fill(session, ['Password'], { bridge: silentBridge });
      expect(refused.audit.map((a) => a.code)).toEqual(['refused_unattended']);
      expect(await inputValue(session, 'p')).toBe('');
      const allowed = await fill(session, ['Password'], { bridge: silentBridge, unattended: true });
      expect(allowed.audit.map((a) => a.code)).toEqual(['filled']);
      expect(await inputValue(session, 'p')).toBe(PASSWORD);
    });

    it('grant/revoke through updateCredentialPolicy takes effect on the next fill', async () => {
      const session = await open('/login');
      const vault = memoryVault();
      await storeCredential(vault, [fx.originA], { personalities: [] });
      const audit: CredentialFillAuditEvent[] = [];
      const { ctx } = makeCtx('real', scopedCredentials(vault));
      const args = { credential: 'test-login', password_ref: refFor(session, 'Password') };
      await fillTool({ audit }).execute(args, ctx);
      await updateCredentialPolicy(vault, 'test-login', (p) => ({
        ...p,
        personalities: ['researcher'],
      }));
      await fillTool({ audit }).execute(args, ctx);
      expect(audit.map((a) => a.code)).toEqual(['refused_personality', 'filled']);
    });
  },
);
