import { assertSafeId } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Default dream prompt
// ---------------------------------------------------------------------------
const DEFAULT_DREAM_PROMPT =
  'Review recent session history. Consolidate key facts into MEMORY.md. ' +
  'Update USER.md with any new user preferences observed. ' +
  'Be concise — this is background maintenance, not a conversation.';
// ---------------------------------------------------------------------------
// DreamExecutor — idle-triggered background maintenance turns
// ---------------------------------------------------------------------------
export class DreamExecutor {
  storage;
  getLoop;
  getConfig;
  lastUserTurnAt = new Map();
  inFlight = new Map();
  timer;
  ticking = false;
  constructor(storage, getLoop, getConfig) {
    this.storage = storage;
    this.getLoop = getLoop;
    this.getConfig = getConfig;
  }
  /** Call on every inbound user message to update the activity timestamp. */
  recordUserTurn(personalityId) {
    assertSafeId(personalityId, 'personalityId');
    this.lastUserTurnAt.set(personalityId, Date.now());
    // Cancel in-flight dream — user activity takes priority
    const inflight = this.inFlight.get(personalityId);
    if (inflight) {
      inflight.abort();
    }
  }
  /** Start the idle-check interval (every 5 minutes). */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 5 * 60_000);
    this.timer.unref?.();
  }
  /** Stop the idle-check interval and clean up. */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const abort of this.inFlight.values()) {
      abort.abort();
    }
    this.inFlight.clear();
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const [personalityId, lastTurn] of this.lastUserTurnAt) {
        const config = this.getConfig(personalityId);
        if (!config?.dreaming?.enable) continue;
        if (this.inFlight.has(personalityId)) continue;
        const idleMs = (config.dreaming.idleMinutes ?? 60) * 60_000;
        if (Date.now() - lastTurn < idleMs) continue;
        // Check eligibility
        const eligible = await this.checkEligibility(personalityId, config.dreaming.maxPerDay ?? 1);
        if (!eligible) {
          // Reset so this crossing doesn't re-fire every tick
          this.lastUserTurnAt.set(personalityId, Date.now());
          continue;
        }
        // Execute dream run
        await this.executeDream(personalityId, config);
        // Reset timer — dream counts as activity
        this.lastUserTurnAt.set(personalityId, Date.now());
      }
    } finally {
      this.ticking = false;
    }
  }
  async checkEligibility(personalityId, maxPerDay) {
    if (maxPerDay <= 0) return false;
    assertSafeId(personalityId, 'personalityId');
    const path = `personalities/${personalityId}/dream-state.json`;
    const raw = await this.storage.read(path);
    if (!raw) return true;
    try {
      const state = JSON.parse(raw);
      const windowStart = new Date(state.windowStart).getTime();
      const now = Date.now();
      if (now - windowStart > 24 * 60 * 60_000) return true;
      return state.runsToday < maxPerDay;
    } catch {
      return true; // corrupt state → allow
    }
  }
  async executeDream(personalityId, config) {
    const loop = this.getLoop(personalityId);
    if (!loop) return;
    const prompt = config.dreaming?.prompt ?? DEFAULT_DREAM_PROMPT;
    const sessionKey = `dream:${personalityId}:${Date.now()}`;
    const abort = new AbortController();
    this.inFlight.set(personalityId, abort);
    let success = false;
    try {
      for await (const event of loop.run(prompt, {
        personalityId,
        sessionKey,
        abortSignal: abort.signal,
      })) {
        if (event.type === 'done') {
          success = true;
          break;
        }
        if (event.type === 'error') break;
      }
    } finally {
      this.inFlight.delete(personalityId);
    }
    if (success) {
      await this.persistState(personalityId);
    }
  }
  async persistState(personalityId) {
    const path = `personalities/${personalityId}/dream-state.json`;
    const raw = await this.storage.read(path);
    let runsToday = 1;
    let windowStart = new Date().toISOString();
    if (raw) {
      try {
        const prev = JSON.parse(raw);
        const prevWindow = new Date(prev.windowStart).getTime();
        if (Date.now() - prevWindow <= 24 * 60 * 60_000) {
          runsToday = prev.runsToday + 1;
          windowStart = prev.windowStart;
        }
      } catch {
        // corrupt state — start fresh
      }
    }
    await this.storage.writeAtomic(
      path,
      JSON.stringify({ lastDreamAt: new Date().toISOString(), runsToday, windowStart }, null, 2),
    );
  }
}
