import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockingAdvisories, checkOsvVulnerabilities, clearOsvCache } from '../osv-check';

describe('checkOsvVulnerabilities', () => {
  beforeEach(() => {
    clearOsvCache();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns safe:false for high-severity vulnerabilities', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          vulns: [
            {
              id: 'GHSA-1234',
              summary: 'Remote code execution',
              severity: [{ type: 'CVSS_V3', score: '9.8' }],
            },
          ],
        }),
      }),
    );

    const result = await checkOsvVulnerabilities('vulnerable-pkg');
    expect(result.safe).toBe(false);
    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0].id).toBe('GHSA-1234');
    expect(result.advisories[0].severity).toBe('CRITICAL');
  });

  it('returns safe:true for low-severity vulnerabilities only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          vulns: [
            {
              id: 'GHSA-low',
              summary: 'Minor issue',
              severity: [{ type: 'CVSS_V3', score: '2.1' }],
            },
          ],
        }),
      }),
    );

    const result = await checkOsvVulnerabilities('safe-pkg');
    expect(result.safe).toBe(true);
    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0].severity).toBe('LOW');
  });

  it('returns safe:true when no vulns are found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }),
    );

    const result = await checkOsvVulnerabilities('clean-pkg');
    expect(result.safe).toBe(true);
    expect(result.advisories).toHaveLength(0);
  });

  it('uses cache on second call (does not re-fetch)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ vulns: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await checkOsvVulnerabilities('cached-pkg');
    await checkOsvVulnerabilities('cached-pkg');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches again after cache is cleared', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ vulns: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await checkOsvVulnerabilities('pkg-a');
    clearOsvCache();
    await checkOsvVulnerabilities('pkg-a');

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns safe:true when OSV API returns non-ok status (warn, not block)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }),
    );

    const result = await checkOsvVulnerabilities('unreachable-pkg');
    expect(result.safe).toBe(true);
    expect(result.advisories).toHaveLength(0);
  });

  it('returns safe:true when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network timeout')));

    const result = await checkOsvVulnerabilities('network-fail-pkg');
    expect(result.safe).toBe(true);
    expect(result.advisories).toHaveLength(0);
  });

  it('uses database_specific.severity as fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          vulns: [
            {
              id: 'GHSA-5678',
              summary: 'Issue with fallback severity',
              database_specific: { severity: 'HIGH' },
            },
          ],
        }),
      }),
    );

    const result = await checkOsvVulnerabilities('fallback-pkg');
    expect(result.safe).toBe(false);
    expect(result.advisories[0].severity).toBe('HIGH');
  });

  it('sends correct request body to OSV API', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ vulns: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await checkOsvVulnerabilities('my-package');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.osv.dev/v1/query',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          package: { name: 'my-package', ecosystem: 'npm' },
        }),
      }),
    );
  });

  it('sends version and ecosystem when given', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ vulns: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await checkOsvVulnerabilities('mcp-server-git', { version: '2025.1.14', ecosystem: 'PyPI' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.osv.dev/v1/query',
      expect.objectContaining({
        body: JSON.stringify({
          package: { name: 'mcp-server-git', ecosystem: 'PyPI' },
          version: '2025.1.14',
        }),
      }),
    );
  });

  it('caches per version, so another version is not served the first one', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ vulns: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await checkOsvVulnerabilities('pkg', { version: '1.0.0' });
    await checkOsvVulnerabilities('pkg', { version: '1.0.1' });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('failClosed returns safe:false on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network timeout')));

    const result = await checkOsvVulnerabilities('pkg', { version: '1.0.0', failClosed: true });
    expect(result.safe).toBe(false);
    expect(result.error).toBe('network timeout');
  });

  it('failClosed returns safe:false on a non-ok status and on an unparseable body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const down = await checkOsvVulnerabilities('pkg', { failClosed: true });
    expect(down.safe).toBe(false);
    expect(down.error).toContain('503');

    clearOsvCache();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }),
    );
    const garbled = await checkOsvVulnerabilities('pkg', { failClosed: true });
    expect(garbled.safe).toBe(false);
  });

  it('failClosed treats an advisory of unknown severity as unsafe; the default does not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ vulns: [{ id: 'GHSA-x', summary: 'no severity at all' }] }),
      }),
    );
    expect((await checkOsvVulnerabilities('pkg', { failClosed: true })).safe).toBe(false);
    expect((await checkOsvVulnerabilities('pkg')).safe).toBe(true);
  });

  it('reads database_specific.severity when the CVSS score is a vector string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          vulns: [
            {
              id: 'GHSA-vec',
              summary: 'real-world record shape',
              severity: [
                { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
              ],
              database_specific: { severity: 'CRITICAL' },
            },
          ],
        }),
      }),
    );
    const result = await checkOsvVulnerabilities('pkg', { version: '1.0.0' });
    expect(result.advisories[0].severity).toBe('CRITICAL');
    expect(result.safe).toBe(false);
  });

  it('timeoutMs passes an abort signal; a timeout under failClosed is unsafe', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkOsvVulnerabilities('pkg', { failClosed: true, timeoutMs: 50 });
    expect(mockFetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.safe).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('sends no signal by default', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);
    await checkOsvVulnerabilities('pkg');
    expect(mockFetch.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  });
});

describe('blockingAdvisories', () => {
  const adv = (severity: string) => ({ id: severity, summary: '', severity });
  it('HIGH and CRITICAL always block; UNKNOWN only under failClosed', () => {
    const all = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN'].map(adv);
    expect(blockingAdvisories(all).map((a) => a.severity)).toEqual(['HIGH', 'CRITICAL']);
    expect(blockingAdvisories(all, { failClosed: true }).map((a) => a.severity)).toEqual([
      'HIGH',
      'CRITICAL',
      'UNKNOWN',
    ]);
  });
});
