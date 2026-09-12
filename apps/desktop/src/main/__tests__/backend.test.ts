import { beforeEach, describe, expect, it, vi } from 'vitest';

// F06 follow-up — `stopServer` now rejects when a disposal step fails or runs
// past its bound (`shutdownDesktopRuntime`). `restartBackendAsync` awaited it
// with no catch, so one failed dispose meant the new backend was never started:
// the onboarding-complete restart left the desktop with no backend at all.

const serve = vi.hoisted(() => ({
  startServer: vi.fn(async (port: number) => port),
  stopServer: vi.fn(async () => {}),
  getPort: vi.fn(() => null),
}));
vi.mock('../serve', () => serve);
vi.mock('../store', () => ({ store: { get: () => undefined } }));

import { restartBackendAsync } from '../backend';

beforeEach(() => {
  serve.startServer.mockClear();
  serve.stopServer.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 200 })),
  );
});

describe('restartBackendAsync (F06)', () => {
  it('still starts the new backend when stopping the old one rejects', async () => {
    serve.stopServer.mockRejectedValueOnce(
      new AggregateError([new Error('agent loop: did not finish within 10000ms')], 'shutdown'),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(restartBackendAsync(4321)).resolves.toBe(4321);

    expect(serve.startServer).toHaveBeenCalledWith(4321);
    // The failure is reported, not swallowed.
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(
      'error stopping server on restart',
    );
    stderr.mockRestore();
  });
});
