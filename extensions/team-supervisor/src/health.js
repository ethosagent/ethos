/** HTTP GET /health on 127.0.0.1:<port> with a 5s timeout. Returns null on any failure. */
export async function probeHealth(port) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        clearTimeout(timer);
        return null;
    }
}
/**
 * Start the health-probe loop. Returns a stop function.
 *
 * Each tick probes all `running` or `degraded` members. Consecutive failures
 * per member:
 *   1–(max-1) → status=degraded, log probe_fail
 *   max       → onHung() (caller decides whether to respawn)
 *   success   → reset counter; if was degraded call onRecovered()
 */
export function startHealthProbeLoop(config) {
    const { intervalMs = 30_000, maxConsecutiveFails = 3, getMembers, onDegraded, onRecovered, onHung, probe = probeHealth, } = config;
    const consecutiveFails = new Map();
    const tick = async () => {
        const members = getMembers().filter((m) => m.status === 'running' || m.status === 'degraded');
        await Promise.all(members.map(async (m) => {
            const result = await probe(m.port);
            const prev = consecutiveFails.get(m.personality) ?? 0;
            if (result === null) {
                const next = prev + 1;
                consecutiveFails.set(m.personality, next);
                if (next >= maxConsecutiveFails) {
                    consecutiveFails.delete(m.personality);
                    onHung(m.personality);
                }
                else if (m.status === 'running') {
                    onDegraded(m.personality);
                }
            }
            else {
                if (prev > 0) {
                    consecutiveFails.delete(m.personality);
                    if (m.status === 'degraded')
                        onRecovered(m.personality);
                }
            }
        }));
    };
    const id = setInterval(() => {
        void tick().catch(() => { });
    }, intervalMs);
    return () => clearInterval(id);
}
