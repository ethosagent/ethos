export interface HealthResponse {
  status: 'ok';
  uptime_s: number;
  active_sessions: number;
  last_turn_at: string | null;
}

export type ProbeFunction = (port: number) => Promise<HealthResponse | null>;

/** HTTP GET /health on 127.0.0.1:<port> with a 5s timeout. Returns null on any failure. */
export async function probeHealth(port: number): Promise<HealthResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export interface ProbedMember {
  personality: string;
  port: number;
  status: string;
  pid: number | null;
}

export interface ProbeLoopConfig {
  /** How often to probe each member (default 30 000 ms). */
  intervalMs?: number;
  /** Number of consecutive probe failures before treating the member as hung (default 3). */
  maxConsecutiveFails?: number;
  /** Return current member snapshots. Called each tick. */
  getMembers: () => ProbedMember[];
  /** Called when a member transitions to degraded (consecutive fails, process still up). */
  onDegraded: (personality: string) => void;
  /** Called when a member probe succeeds after being degraded. */
  onRecovered: (personality: string) => void;
  /** Called when consecutive fails reach the limit — treat member as hung. */
  onHung: (personality: string) => void;
  /** Injectable probe function (default: probeHealth). */
  probe?: ProbeFunction;
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
export function startHealthProbeLoop(config: ProbeLoopConfig): () => void {
  const {
    intervalMs = 30_000,
    maxConsecutiveFails = 3,
    getMembers,
    onDegraded,
    onRecovered,
    onHung,
    probe = probeHealth,
  } = config;

  const consecutiveFails = new Map<string, number>();

  const tick = async (): Promise<void> => {
    const members = getMembers().filter((m) => m.status === 'running' || m.status === 'degraded');

    await Promise.all(
      members.map(async (m) => {
        const result = await probe(m.port);
        const prev = consecutiveFails.get(m.personality) ?? 0;

        if (result === null) {
          const next = prev + 1;
          consecutiveFails.set(m.personality, next);

          if (next >= maxConsecutiveFails) {
            consecutiveFails.delete(m.personality);
            onHung(m.personality);
          } else if (m.status === 'running') {
            onDegraded(m.personality);
          }
        } else {
          if (prev > 0) {
            consecutiveFails.delete(m.personality);
            if (m.status === 'degraded') onRecovered(m.personality);
          }
        }
      }),
    );
  };

  const id = setInterval(() => {
    void tick().catch(() => {});
  }, intervalMs);

  return () => clearInterval(id);
}
