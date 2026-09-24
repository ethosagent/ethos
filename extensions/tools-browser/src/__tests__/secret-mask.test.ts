// The filled-secret masking chokepoint (plan reach-and-containment D4-6).
//
// Playwright's aria snapshot prints a textbox's current value — including a
// password input's — so once `browser_fill_credential` has run, every browser
// tool that returns page content would echo it. `withSecretMask`, applied to
// the whole roster in `createBrowserTools`, is what stops that. Drop the
// `roster.map(withSecretMask)` there and every case below fails; add a browser
// tool that bypasses the roster and "every tool is wrapped" fails.

import type { ClarifyBridge } from '@ethosagent/core';
import type { Tool, ToolContext } from '@ethosagent/types';
import type { BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBrowserTools } from '../index';
import {
  isSecretMasked,
  maskFilledSecrets,
  registerFilledSecrets,
  SECRET_MASK,
  withSecretMask,
} from '../secret-mask';
import {
  type BrowserSession,
  closeSession,
  getOrCreateSessionWithRoute,
  makeMapKey,
  policyFingerprint,
  sessions,
} from '../sessions';
import { snapshotPage } from '../snapshot';
import {
  type Fixture,
  HAS_CHROMIUM,
  makeCtx,
  memoryVault,
  PASSWORD,
  POLICY,
  refFor,
  scopedCredentials,
  startFixture,
  storeCredential,
  USERNAME,
} from './credential-fixture';

vi.mock('../sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessions')>()),
  isPlaywrightInstalled: () => true,
}));

// `browse_url`'s pre-navigation SSRF check refuses loopback outright; the
// fixture lives on 127.0.0.1. The route guard still runs, under POLICY.
vi.mock('@ethosagent/tools-web', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ethosagent/tools-web')>()),
  checkSsrf: async () => ({ blocked: false }),
}));

const bridge = { canPresent: () => true } as unknown as ClarifyBridge;

function roster(): Map<string, Tool> {
  const tools = createBrowserTools({ recordCredentialFill: () => {}, clarifyBridge: bridge });
  return new Map(tools.map((t) => [t.name, t]));
}

function tool(name: string): Tool {
  const t = roster().get(name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
}

function seedFake(sessionId: string, logs: string[] = []): BrowserSession {
  const session: BrowserSession = {
    context: {} as BrowserContext,
    page: {} as Page,
    refs: new Map(),
    lastUrl: '',
    policyFingerprint: policyFingerprint(POLICY),
    consoleLogs: [...logs],
    tier: 'stock',
    pendingWarnings: [],
    lastActiveAt: Date.now(),
    close: async () => {
      session.filledSecrets = undefined;
    },
  };
  sessions.set(makeMapKey(sessionId, POLICY), session);
  return session;
}

function ctxFor(sessionId: string): ToolContext {
  return makeCtx(sessionId, undefined).ctx;
}

describe('withSecretMask — roster and lifetime', () => {
  afterEach(() => sessions.clear());

  it('every tool returned by createBrowserTools is wrapped', () => {
    const tools = createBrowserTools({ recordCredentialFill: () => {}, clarifyBridge: bridge });
    expect(tools.length).toBeGreaterThan(10);
    for (const t of tools) expect(isSecretMasked(t), t.name).toBe(true);
    // Also without the optional deps — a smaller roster, still all wrapped.
    for (const t of createBrowserTools()) expect(isSecretMasked(t), t.name).toBe(true);
  });

  it('browser_console and browser_dialog show the mask, not the value', async () => {
    const session = seedFake('s1', [
      `[log] pw is ${PASSWORD}`,
      `[dialog:alert] submitted ${PASSWORD} for ${USERNAME}`,
    ]);
    registerFilledSecrets(session, [USERNAME, PASSWORD]);

    const dialog = await tool('browser_dialog').execute({}, ctxFor('s1'));
    expect(dialog.ok && dialog.value).toContain(`submitted ${SECRET_MASK} for ${SECRET_MASK}`);
    const consoleResult = await tool('browser_console').execute({}, ctxFor('s1'));
    expect(consoleResult.ok && consoleResult.value).toContain(`pw is ${SECRET_MASK}`);
    for (const r of [dialog, consoleResult]) {
      expect(JSON.stringify(r)).not.toContain(PASSWORD);
      expect(JSON.stringify(r)).not.toContain(USERNAME);
    }
  });

  it('masks error strings and progress events too', async () => {
    const session = seedFake('s2');
    registerFilledSecrets(session, [PASSWORD]);
    const emitted: string[] = [];
    const leaky: Tool = withSecretMask({
      name: 'leaky',
      description: 'x',
      schema: { type: 'object' },
      capabilities: {},
      execute: async (_args, ctx) => {
        ctx.emit({ type: 'progress', toolName: 'leaky', message: `typing ${PASSWORD}` });
        return { ok: false, error: `failed on ${PASSWORD}`, code: 'execution_failed' };
      },
    });
    const ctx = { ...ctxFor('s2'), emit: (e: { message: string }) => emitted.push(e.message) };
    const result = await leaky.execute({}, ctx as ToolContext);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(emitted).toEqual([`typing ${SECRET_MASK}`]);
  });

  it('the mask set is cleared by closeSession; a new session does not mask', async () => {
    const session = seedFake('s3');
    registerFilledSecrets(session, [PASSWORD]);
    expect(maskFilledSecrets('s3', `x ${PASSWORD}`)).toBe(`x ${SECRET_MASK}`);
    await closeSession('s3');
    expect(session.filledSecrets).toBeUndefined();
    seedFake('s3');
    expect(maskFilledSecrets('s3', `x ${PASSWORD}`)).toBe(`x ${PASSWORD}`);
  });

  it('is scoped to its own session', () => {
    registerFilledSecrets(seedFake('mine'), [PASSWORD]);
    seedFake('other');
    expect(maskFilledSecrets('other', PASSWORD)).toBe(PASSWORD);
    expect(maskFilledSecrets('mine', PASSWORD)).toBe(SECRET_MASK);
  });

  it('does not register values too short to mask meaningfully', () => {
    const session = seedFake('short');
    registerFilledSecrets(session, ['ab', PASSWORD]);
    expect(maskFilledSecrets('short', 'ab cd')).toBe('ab cd');
  });
});

// Real Chromium under a loaded full-suite run needs more than the 15s default.
describe.skipIf(!HAS_CHROMIUM)(
  'withSecretMask — real Chromium, after a fill',
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
      await closeSession('mask');
    }, 60_000);

    async function filledSession(): Promise<BrowserSession> {
      const session = await getOrCreateSessionWithRoute('mask', POLICY);
      await session.page.goto(`${fx.originA}/persist`);
      session.refs = (await snapshotPage(session.page)).refs;
      const vault = memoryVault();
      await storeCredential(vault, [fx.originA]);
      const { ctx } = makeCtx('mask', scopedCredentials(vault));
      const result = await tool('browser_fill_credential').execute(
        {
          credential: 'test-login',
          username_ref: refFor(session, 'Username'),
          password_ref: refFor(session, 'Password'),
          submit: true,
        },
        ctx,
      );
      expect(result.ok).toBe(true);
      // The page really holds the values — the mask is what hides them.
      const raw = await session.page.locator('body').ariaSnapshot();
      expect(raw).toContain(PASSWORD);
      return session;
    }

    function expectMasked(result: Awaited<ReturnType<Tool['execute']>>) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(USERNAME);
    }

    it('browser_click and browser_type results are masked', async () => {
      const session = await filledSession();
      const click = await tool('browser_click').execute(
        { element_ref: refFor(session, 'Other') },
        ctxFor('mask'),
      );
      expect(click.ok).toBe(true);
      expect(click.ok && click.value).toContain(SECRET_MASK);
      expectMasked(click);

      const type = await tool('browser_type').execute(
        { element_ref: refFor(session, 'Code'), text: '12' },
        ctxFor('mask'),
      );
      expect(type.ok).toBe(true);
      expectMasked(type);
    });

    it('browser_console and browser_dialog (real page events) are masked', async () => {
      await filledSession();
      const consoleResult = await tool('browser_console').execute({ clear: false }, ctxFor('mask'));
      expect(consoleResult.ok && consoleResult.value).toContain(`pw is ${SECRET_MASK}`);
      expectMasked(consoleResult);
      const dialog = await tool('browser_dialog').execute({}, ctxFor('mask'));
      expect(dialog.ok && dialog.value).toContain(`submitted ${SECRET_MASK}`);
      expectMasked(dialog);
    });

    it('browse_url on a page that re-renders the value is masked', async () => {
      await filledSession();
      const result = await tool('browse_url').execute(
        { url: `${fx.originA}/persist` },
        ctxFor('mask'),
      );
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toContain(`Saved: ${SECRET_MASK}`);
      expectMasked(result);
    });
  },
);
