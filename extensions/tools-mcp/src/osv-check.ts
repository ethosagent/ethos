// ---------------------------------------------------------------------------
// OSV vulnerability scanner — queries the OSV.dev API for npm package advisories.
// ---------------------------------------------------------------------------

export interface OsvAdvisory {
  id: string;
  summary: string;
  severity: string;
}

export interface OsvResult {
  safe: boolean;
  advisories: OsvAdvisory[];
  /** Set only under `failClosed`, when `safe` is false because the lookup itself failed. */
  error?: string;
}

export interface OsvCheckOptions {
  /** Query one exact version instead of every advisory the package ever had. */
  version?: string;
  ecosystem?: 'npm' | 'PyPI';
  /**
   * Treat a lookup failure (network, non-2xx, unparseable body) and an advisory
   * of UNKNOWN severity as unsafe, instead of "warn but don't block".
   * Pinned by __tests__/osv-check.test.ts ("failClosed ...").
   */
  failClosed?: boolean;
  /** Abort the request after this long. Absent: no timeout (the default for existing callers). */
  timeoutMs?: number;
}

/**
 * The advisories that make a result unsafe: HIGH or CRITICAL, plus UNKNOWN
 * severity under `failClosed`. The one predicate behind `OsvResult.safe`, so a
 * caller reporting why it failed does not re-list severities.
 */
export function blockingAdvisories(
  advisories: readonly OsvAdvisory[],
  options: { failClosed?: boolean } = {},
): OsvAdvisory[] {
  return advisories.filter(
    (a) =>
      HIGH_SEVERITIES.has(a.severity) || (options.failClosed === true && a.severity === 'UNKNOWN'),
  );
}

// ---------------------------------------------------------------------------
// In-memory cache (24h TTL)
// ---------------------------------------------------------------------------

interface CacheEntry {
  result: OsvResult;
  fetchedAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

/**
 * Clear the in-memory cache. Exposed for tests.
 */
export function clearOsvCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Severity classification
// ---------------------------------------------------------------------------

const HIGH_SEVERITIES = new Set(['HIGH', 'CRITICAL']);

function extractSeverity(vuln: Record<string, unknown>): string {
  // OSV format: severity is an array of { type, score } objects
  const severity = vuln.severity as Array<{ type: string; score: string }> | undefined;
  if (severity?.length) {
    // CVSS_V3 or CVSS_V4 score >= 7.0 → HIGH, >= 9.0 → CRITICAL
    for (const s of severity) {
      const score = Number.parseFloat(s.score);
      // Real OSV records carry a CVSS vector string ("CVSS:3.1/AV:N/..."), not a
      // number; parseFloat gives NaN. Skip it and fall through to the database's
      // own label instead of misreading it as LOW.
      if (Number.isNaN(score)) continue;
      if (score >= 9.0) return 'CRITICAL';
      if (score >= 7.0) return 'HIGH';
      if (score >= 4.0) return 'MEDIUM';
      return 'LOW';
    }
  }
  // Fallback: check database_specific.severity
  const dbSpecific = vuln.database_specific as Record<string, unknown> | undefined;
  if (dbSpecific?.severity && typeof dbSpecific.severity === 'string') {
    return dbSpecific.severity.toUpperCase();
  }
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export async function checkOsvVulnerabilities(
  packageName: string,
  options: OsvCheckOptions = {},
): Promise<OsvResult> {
  const ecosystem = options.ecosystem ?? 'npm';
  const failClosed = options.failClosed === true;
  const cacheKey = `${ecosystem}:${packageName}@${options.version ?? ''}:${failClosed ? 'closed' : 'open'}`;
  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.result;
  }
  const failure = (reason: string): OsvResult =>
    failClosed ? { safe: false, advisories: [], error: reason } : { safe: true, advisories: [] };

  try {
    const resp = await fetch('https://api.osv.dev/v1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        package: { name: packageName, ecosystem },
        ...(options.version !== undefined ? { version: options.version } : {}),
      }),
      ...(options.timeoutMs !== undefined
        ? { signal: AbortSignal.timeout(options.timeoutMs) }
        : {}),
    });

    if (!resp.ok) {
      // OSV unreachable or errored — warn but don't block (unless failClosed)
      return failure(`OSV answered HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as { vulns?: Array<Record<string, unknown>> };
    const vulns = data.vulns ?? [];

    const advisories: OsvAdvisory[] = vulns.map((v) => ({
      id: String(v.id ?? 'unknown'),
      summary: String(v.summary ?? ''),
      severity: extractSeverity(v),
    }));

    const result: OsvResult = {
      safe: blockingAdvisories(advisories, { failClosed }).length === 0,
      advisories,
    };

    // Update cache
    cache.set(cacheKey, { result, fetchedAt: Date.now() });

    return result;
  } catch (err) {
    // Network error — warn, don't block (unless failClosed)
    return failure(err instanceof Error ? err.message : String(err));
  }
}
