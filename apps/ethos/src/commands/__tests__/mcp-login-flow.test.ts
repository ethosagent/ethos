// `ethos mcp login` / `add --url` flow selection and the headless sign-in
// runner (plan mcp-device-code-login §6.3). The runner is driven with fake
// McpDeviceLogin / McpPasteLogin services and a fake terminal, so the tests pin
// what the CLI decides and prints, not the OAuth wire (that is tools-mcp's).

import { EthosError } from '@ethosagent/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../wiring', () => ({
  createAgentLoop: vi.fn(),
  createLLM: vi.fn(),
  getEthosObservability: () => ({ recordEthosEvent: () => {} }),
  getSecretsResolver: async () => ({ get: async () => undefined }),
  getStorage: () => ({}),
  closeObservabilityStore: () => {},
}));

type Mcp = typeof import('../mcp');
let mcp: Mcp;

beforeAll(async () => {
  mcp = await import('../mcp');
}, 120_000);

const DESKTOP = { env: {}, platform: 'darwin', containerized: false };

describe('chooseLoginFlow', () => {
  it('SSH_CONNECTION selects device', () => {
    expect(
      mcp.chooseLoginFlow({ ...DESKTOP, env: { SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 22' } }),
    ).toBe('device');
    expect(mcp.chooseLoginFlow({ ...DESKTOP, env: { SSH_TTY: '/dev/pts/0' } })).toBe('device');
  });

  it('linux without DISPLAY selects device', () => {
    expect(mcp.chooseLoginFlow({ ...DESKTOP, platform: 'linux' })).toBe('device');
    expect(mcp.chooseLoginFlow({ ...DESKTOP, platform: 'linux', env: { DISPLAY: ':0' } })).toBe(
      'browser',
    );
    expect(
      mcp.chooseLoginFlow({ ...DESKTOP, platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }),
    ).toBe('browser');
  });

  it('a container selects device', () => {
    expect(mcp.chooseLoginFlow({ ...DESKTOP, containerized: true })).toBe('device');
  });

  it('a desktop session selects browser', () => {
    expect(mcp.chooseLoginFlow(DESKTOP)).toBe('browser');
  });

  it('an explicit flag wins over detection', () => {
    const headless = { env: { SSH_CONNECTION: 'x' }, platform: 'linux', containerized: true };
    expect(mcp.chooseLoginFlow({ ...headless, flag: 'browser' })).toBe('browser');
    expect(mcp.chooseLoginFlow({ ...DESKTOP, flag: 'paste' })).toBe('paste');
    expect(mcp.chooseLoginFlow({ ...DESKTOP, flag: 'device' })).toBe('device');
  });
});

describe('parseLoginFlowFlags', () => {
  it('reads one flow flag and --no-qr', () => {
    expect(mcp.parseLoginFlowFlags(['granola', '--device', '--no-qr'])).toEqual({
      flag: 'device',
      noQr: true,
    });
    expect(mcp.parseLoginFlowFlags(['granola'])).toEqual({ noQr: false });
  });

  it('two flags are refused', () => {
    expect(() => mcp.parseLoginFlowFlags(['granola', '--device', '--paste'])).toThrow(EthosError);
    expect(() => mcp.parseLoginFlowFlags(['--browser', '--paste'])).toThrow(/at most one/);
  });
});

// --- runHeadlessLogin ------------------------------------------------------

const INFO = {
  serverName: 'granola',
  serverHost: 'mcp.granola.ai',
  authHost: 'mcp-auth.granola.ai',
  personalityId: 'researcher',
};

function deviceOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    flowId: 'f1',
    userCode: 'ABCD-EFGHJ',
    verificationUri: 'https://mcp-auth.granola.ai/device',
    verificationUriComplete: 'https://mcp-auth.granola.ai/device?user_code=ABCD-EFGHJ',
    expiresAt: 1_000_000 + 299_000,
    ...INFO,
    ...overrides,
  };
}

function setup(opts: { isTTY?: boolean; lines?: string[] } = {}) {
  const err: string[] = [];
  const out: string[] = [];
  const qr: string[] = [];
  const lines = [...(opts.lines ?? [])];
  let sigint: (() => void) | undefined;
  const settleListeners: Array<(s: { status: string; reason?: string }) => void> = [];
  const device = {
    start: vi.fn(),
    cancel: vi.fn(),
    onSettled: vi.fn((_id: string, cb: (s: { status: string; reason?: string }) => void) => {
      settleListeners.push(cb);
    }),
  };
  const paste = { start: vi.fn(), complete: vi.fn(), cancel: vi.fn() };
  const legacyPaste = vi.fn();
  const io = {
    err: (t: string) => void err.push(t),
    out: (t: string) => void out.push(t),
    isTTY: opts.isTTY ?? true,
    now: () => 1_000_000,
    readLine: vi.fn(async () => {
      const next = lines.shift();
      if (next === undefined)
        throw new EthosError({ code: 'INVALID_INPUT', cause: 'eof', action: '' });
      return next;
    }),
    onSigint: (h: () => void) => {
      sigint = h;
      return () => {
        sigint = undefined;
      };
    },
    qr: vi.fn(async (u: string) => void qr.push(u)),
    endInput: vi.fn(),
  };
  return {
    err,
    out,
    qr,
    io,
    device,
    paste,
    legacyPaste,
    settle: (s: { status: string; reason?: string }) => {
      for (const l of settleListeners) l(s);
    },
    interrupt: () => sigint?.(),
    deps: () =>
      ({ device, paste, legacyPaste, io }) as unknown as Parameters<Mcp['runHeadlessLogin']>[1],
  };
}

const INPUT = {
  serverName: 'granola',
  personalityId: 'researcher',
  flow: 'device',
  noQr: false,
} as const;

let prevExit: typeof process.exitCode;
beforeEach(() => {
  prevExit = process.exitCode;
  process.exitCode = undefined;
  return () => {
    process.exitCode = prevExit;
  };
});

describe('runHeadlessLogin — device', () => {
  it('prints the server, authorization host, personality, code and expiry; never opens a browser', async () => {
    const t = setup();
    t.device.start.mockResolvedValue(deviceOk());
    const run = mcp.runHeadlessLogin(INPUT, t.deps());
    await vi.waitFor(() => expect(t.device.onSettled).toHaveBeenCalled());
    t.settle({ status: 'connected' });
    await run;
    const text = t.err.join('');
    expect(text).toContain("Sign in to 'granola' for personality 'researcher'");
    expect(text).toContain('mcp.granola.ai');
    expect(text).toContain('mcp-auth.granola.ai');
    expect(text).toContain('https://mcp-auth.granola.ai/device');
    expect(text).toContain('ABCD-EFGHJ');
    expect(text).toContain('4 min 59 s');
    expect(t.qr).toEqual(['https://mcp-auth.granola.ai/device?user_code=ABCD-EFGHJ']);
    expect(t.out.join('')).toContain(
      "Successfully authenticated with 'granola' (personality: researcher)",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('--no-qr hides the QR', async () => {
    const t = setup();
    t.device.start.mockResolvedValue(deviceOk());
    const run = mcp.runHeadlessLogin({ ...INPUT, noQr: true }, t.deps());
    await vi.waitFor(() => expect(t.device.onSettled).toHaveBeenCalled());
    t.settle({ status: 'connected' });
    await run;
    expect(t.qr).toEqual([]);
  });

  it('maps denied, expired and error outcomes to EthosError', async () => {
    for (const [settled, expected] of [
      [{ status: 'denied' }, /declined in the browser/],
      [{ status: 'expired' }, /code expired/],
      [{ status: 'error', reason: 'invalid_grant' }, /invalid_grant/],
    ] as const) {
      const t = setup();
      t.device.start.mockResolvedValue(deviceOk());
      const run = mcp.runHeadlessLogin(INPUT, t.deps());
      const assertion = expect(run).rejects.toThrow(expected);
      await vi.waitFor(() => expect(t.device.onSettled).toHaveBeenCalled());
      t.settle(settled);
      await assertion;
      await run.catch((e) => expect(e).toBeInstanceOf(EthosError));
    }
  });

  it('Ctrl+C cancels the flow, exits 130 and reports nothing stored', async () => {
    const t = setup();
    t.device.start.mockResolvedValue(deviceOk());
    const run = mcp.runHeadlessLogin(INPUT, t.deps());
    await vi.waitFor(() => expect(t.device.onSettled).toHaveBeenCalled());
    t.interrupt();
    await run;
    expect(t.device.cancel).toHaveBeenCalledWith('f1');
    expect(process.exitCode).toBe(130);
    expect(t.err.join('')).toContain('nothing was stored');
    expect(t.out).toEqual([]);
  });

  it('device_refused falls through to paste with a reason line', async () => {
    const t = setup({ lines: ['http://127.0.0.1:5555/oauth/callback?code=c&state=s'] });
    t.device.start.mockResolvedValue({
      ok: false,
      code: 'device_refused',
      detail: 'unauthorized_client',
    });
    t.paste.start.mockResolvedValue({
      ok: true,
      flowId: 'p1',
      authorizeUrl: 'https://mcp-auth.granola.ai/authorize?x=1',
      expiresAt: 0,
      ...INFO,
    });
    t.paste.complete.mockResolvedValue({ ok: true });
    await mcp.runHeadlessLogin(INPUT, t.deps());
    const text = t.err.join('');
    expect(text).toContain(
      "Device sign-in is not available for 'granola' (unauthorized_client); using paste instead.",
    );
    expect(text).toContain('https://mcp-auth.granola.ai/authorize?x=1');
    expect(text).toContain('paste it here');
    expect(t.paste.complete).toHaveBeenCalledWith(
      'p1',
      'http://127.0.0.1:5555/oauth/callback?code=c&state=s',
    );
    expect(t.out.join('')).toContain('Successfully authenticated');
  });

  it('non-TTY with no device support exits 1 with guidance', async () => {
    const t = setup({ isTTY: false });
    t.device.start.mockResolvedValue({ ok: false, code: 'device_unavailable' });
    const err = await mcp.runHeadlessLogin(INPUT, t.deps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    expect((err as EthosError).cause).toMatch(/interactive terminal/);
    expect((err as EthosError).action).toMatch(/--browser/);
    expect(t.paste.start).not.toHaveBeenCalled();
  });

  it('does not fall through on other start failures', async () => {
    const t = setup();
    t.device.start.mockResolvedValue({
      ok: false,
      code: 'already_pending',
      detail: 'A sign-in for granola is already waiting.',
    });
    await expect(mcp.runHeadlessLogin(INPUT, t.deps())).rejects.toThrow(/already waiting/);
    expect(t.paste.start).not.toHaveBeenCalled();
  });
});

describe('runHeadlessLogin — paste', () => {
  const PASTE = { ...INPUT, flow: 'paste' } as const;
  const started = {
    ok: true as const,
    flowId: 'p1',
    authorizeUrl: 'https://mcp-auth.granola.ai/authorize?x=1',
    expiresAt: 0,
    ...INFO,
  };

  it('re-prompts after an invalid paste, then succeeds', async () => {
    const t = setup({ lines: ['nonsense', 'http://127.0.0.1:1/oauth/callback?code=c&state=s'] });
    t.paste.start.mockResolvedValue(started);
    t.paste.complete
      .mockResolvedValueOnce({ ok: false, code: 'invalid_paste' })
      .mockResolvedValueOnce({ ok: true });
    await mcp.runHeadlessLogin(PASTE, t.deps());
    expect(t.paste.complete).toHaveBeenCalledTimes(2);
    expect(t.out.join('')).toContain('Successfully authenticated');
  });

  it('gives up after three bad pastes', async () => {
    const t = setup({ lines: ['a', 'b', 'c'] });
    t.paste.start.mockResolvedValue(started);
    t.paste.complete.mockResolvedValue({ ok: false, code: 'invalid_paste' });
    await expect(mcp.runHeadlessLogin(PASTE, t.deps())).rejects.toThrow(/invalid_paste/);
    expect(t.paste.cancel).toHaveBeenCalledWith('p1');
  });

  it('an entry without a stored redirect uses the legacy listener+paste path', async () => {
    const t = setup({ lines: ['http://127.0.0.1:9/oauth/callback?code=c&state=s'] });
    t.paste.start.mockResolvedValue({ ok: false, code: 'paste_unavailable' });
    t.legacyPaste.mockImplementation(
      async (i: { onAuthUrl(u: string): void; pasted: Promise<string> }) => {
        i.onAuthUrl('https://as.example/authorize?y=2');
        await i.pasted;
      },
    );
    await mcp.runHeadlessLogin(PASTE, t.deps());
    expect(t.err.join('')).toContain('https://as.example/authorize?y=2');
    expect(t.out.join('')).toContain('Successfully authenticated');
  });

  it('a declined paste is reported as declined', async () => {
    const t = setup({ lines: ['x'] });
    t.paste.start.mockResolvedValue(started);
    t.paste.complete.mockResolvedValue({ ok: false, code: 'denied' });
    await expect(mcp.runHeadlessLogin(PASTE, t.deps())).rejects.toThrow(/declined/);
  });
});

describe('buildHeadlessDeps audit logger', () => {
  it('routes the mcp.oauth.login started event to the host logger', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const deps = await mcp.buildHeadlessDeps();
      const { slots } = deps.device as unknown as {
        slots: import('@ethosagent/tools-mcp').LoginSlots;
      };
      const reserved = slots.reserve({ serverName: 'demo', surface: 'cli', kind: 'device' });
      if (!reserved.ok) throw new Error('reserve failed');
      slots.started(reserved.slot);
      slots.cancel(reserved.slot.flowId);
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(
        lines.some((l) => l.includes('mcp.oauth.login') && l.includes('outcome=started')),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
