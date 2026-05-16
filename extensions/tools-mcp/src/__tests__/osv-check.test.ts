import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkOsvVulnerabilities, clearOsvCache } from '../osv-check';

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
});
