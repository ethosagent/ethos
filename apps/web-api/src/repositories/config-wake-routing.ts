// `voice.wake.*` parsing — the satellite lane's pushed routing table. Split out
// of config.repository.ts, which re-exports everything public. `collectRoster`
// (the shared dotted-key bag walker, also used by the voice rosters) lives here.

export function collectRoster(
  passthrough: Record<string, string>,
  prefixes: readonly string[],
): Record<string, Record<string, string>> {
  const bag: Record<string, Record<string, string>> = {};
  // Prefixes are applied in order and later ones overwrite earlier ones, so the
  // canonical spelling wins over the legacy alias regardless of key order.
  for (const prefix of prefixes) {
    const re = new RegExp(`^${prefix.replace(/\./g, '\\.')}\\.([A-Za-z0-9_-]+)\\.(\\w+)$`);
    for (const [key, value] of Object.entries(passthrough)) {
      const m = key.match(re);
      const name = m?.[1];
      const field = m?.[2];
      if (!name || !field) continue;
      const slot = bag[name] ?? {};
      bag[name] = slot;
      slot[field] = value;
    }
  }
  return bag;
}

// ---------------------------------------------------------------------------
// Wake routing (`voice.wake.*`) — the satellite lane's pushed table
// ---------------------------------------------------------------------------

/** One resolved wake route. Unlike `WakeRouteConfig` in `@ethosagent/config`,
 *  the two tri-state flags are RESOLVED here: the wire frame the satellite
 *  receives is a decision, not a config file with holes in it. */
export interface WakeRoute {
  id: string;
  phrase: string;
  personalityId: string;
  /** Route-level opt-in for a privileged personality (eng-review D13). */
  privileged: boolean;
  enabled: boolean;
  /**
   * True for a route SYNTHESIZED from a personality's name rather than read
   * from `config.yaml` — see `withImplicitWakeRoutes`. Nothing writes an
   * implicit route back to the file, and the editor renders it read-only, so
   * the flag is what keeps "the effective table" and "the operator's table"
   * from being confused for each other.
   */
  implicit: boolean;
}

/** Deployment-wide satellite knobs, defaults applied. */
export interface WakeSettings {
  engine: 'fallback' | 'sherpa' | 'openwakeword';
  sensitivity: number;
  confirmationFrames: number;
  edgeStt: boolean;
  /** `voice.wake.idleTimeout` in milliseconds — the frame's unit, not yaml's. */
  idleTimeoutMs: number;
  wakeEnabled: boolean;
}

/** Everything a `routes` frame is built from. */
export interface WakeRoutingTable {
  routes: WakeRoute[];
  settings: WakeSettings;
  /** `voice.wake.nodes.<nodeId>` — per-satellite overrides. */
  nodes: Record<string, { inputDevice?: string; enabled?: boolean }>;
}

/**
 * Defaults for a deployment that has written no `voice.wake.*` scalar.
 *
 * `wakeEnabled: true` is deliberate: the yaml key is a MASTER SWITCH, and its
 * absence means the operator never disabled wake, not that they disabled it.
 * A node's own persisted preference (and the per-node `enabled` override) is
 * what turns an individual microphone off — see `set_wake_enabled`.
 */
export const WAKE_SETTINGS_DEFAULTS: WakeSettings = {
  engine: 'fallback',
  sensitivity: 0.5,
  confirmationFrames: 2,
  edgeStt: false,
  idleTimeoutMs: 30_000,
  wakeEnabled: true,
};

/**
 * Read the wake routing table out of the passthrough block.
 *
 * Mirrors `packages/config`'s reader deliberately, the same way the voice
 * rosters above do: same route-id charset, the same "a route missing `phrase`
 * or `personality` is dropped rather than half-built" rule, and the same bounds
 * — an out-of-range number is IGNORED (the default applies) rather than clamped
 * to a value the operator did not write.
 */
export function parseWakeRouting(passthrough: Record<string, string>): WakeRoutingTable {
  const routeKv = collectRoster(passthrough, ['voice.wake.routes']);
  const routes: WakeRoute[] = [];
  for (const [id, fields] of Object.entries(routeKv)) {
    const phrase = fields.phrase;
    const personalityId = fields.personality;
    if (!phrase || !personalityId) continue;
    routes.push({
      id,
      phrase,
      personalityId,
      privileged: fields.privileged === 'true',
      enabled: fields.enabled !== 'false',
      // Everything this function returns came out of the file, by definition.
      implicit: false,
    });
  }
  routes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const nodeKv = collectRoster(passthrough, ['voice.wake.nodes']);
  const nodes: Record<string, { inputDevice?: string; enabled?: boolean }> = {};
  for (const [id, fields] of Object.entries(nodeKv)) {
    nodes[id] = {
      ...(fields.inputDevice ? { inputDevice: fields.inputDevice } : {}),
      ...(fields.enabled === 'true'
        ? { enabled: true }
        : fields.enabled === 'false'
          ? { enabled: false }
          : {}),
    };
  }

  const engine = passthrough['voice.wake.engine'];
  const idleSeconds = boundedNumber(passthrough['voice.wake.idleTimeout'], 5, 600, true);
  return {
    routes,
    nodes,
    settings: {
      ...WAKE_SETTINGS_DEFAULTS,
      ...(engine === 'fallback' || engine === 'sherpa' || engine === 'openwakeword'
        ? { engine }
        : {}),
      ...pick('sensitivity', boundedNumber(passthrough['voice.wake.sensitivity'], 0, 1, false)),
      ...pick(
        'confirmationFrames',
        boundedNumber(passthrough['voice.wake.confirmationFrames'], 1, 10, true),
      ),
      ...(passthrough['voice.wake.edgeStt'] === 'true'
        ? { edgeStt: true }
        : passthrough['voice.wake.edgeStt'] === 'false'
          ? { edgeStt: false }
          : {}),
      ...(idleSeconds !== undefined ? { idleTimeoutMs: idleSeconds * 1000 } : {}),
      ...(passthrough['voice.wake.enabled'] === 'false' ? { wakeEnabled: false } : {}),
    },
  };
}

/** `{ [key]: value }` when the value is defined, `{}` otherwise — so a rejected
 *  number leaves the default in place instead of overwriting it with undefined. */
function pick<K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

/** A finite number inside `[min, max]`, else undefined. Never a clamped
 *  near-miss — same contract as `parseBoundedInt` in `@ethosagent/config`. */
function boundedNumber(
  raw: string | undefined,
  min: number,
  max: number,
  integer: boolean,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  if (integer && !Number.isInteger(n)) return undefined;
  return n;
}
