// ---------------------------------------------------------------------------
// OSV vulnerability scanner — queries the OSV.dev API for npm package advisories.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();
/**
 * Clear the in-memory cache. Exposed for tests.
 */
export function clearOsvCache() {
    cache.clear();
}
// ---------------------------------------------------------------------------
// Severity classification
// ---------------------------------------------------------------------------
const HIGH_SEVERITIES = new Set(['HIGH', 'CRITICAL']);
function extractSeverity(vuln) {
    // OSV format: severity is an array of { type, score } objects
    const severity = vuln.severity;
    if (severity?.length) {
        // CVSS_V3 or CVSS_V4 score >= 7.0 → HIGH, >= 9.0 → CRITICAL
        for (const s of severity) {
            const score = Number.parseFloat(s.score);
            if (score >= 9.0)
                return 'CRITICAL';
            if (score >= 7.0)
                return 'HIGH';
            if (score >= 4.0)
                return 'MEDIUM';
            return 'LOW';
        }
    }
    // Fallback: check database_specific.severity
    const dbSpecific = vuln.database_specific;
    if (dbSpecific?.severity && typeof dbSpecific.severity === 'string') {
        return dbSpecific.severity.toUpperCase();
    }
    return 'UNKNOWN';
}
// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------
export async function checkOsvVulnerabilities(packageName) {
    // Check cache first
    const cached = cache.get(packageName);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.result;
    }
    try {
        const resp = await fetch('https://api.osv.dev/v1/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                package: { name: packageName, ecosystem: 'npm' },
            }),
        });
        if (!resp.ok) {
            // OSV unreachable or errored — warn but don't block
            return { safe: true, advisories: [] };
        }
        const data = (await resp.json());
        const vulns = data.vulns ?? [];
        const advisories = vulns.map((v) => ({
            id: String(v.id ?? 'unknown'),
            summary: String(v.summary ?? ''),
            severity: extractSeverity(v),
        }));
        const hasHighOrCritical = advisories.some((a) => HIGH_SEVERITIES.has(a.severity));
        const result = {
            safe: !hasHighOrCritical,
            advisories,
        };
        // Update cache
        cache.set(packageName, { result, fetchedAt: Date.now() });
        return result;
    }
    catch {
        // Network error — warn, don't block
        return { safe: true, advisories: [] };
    }
}
