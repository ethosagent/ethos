import type { AgentLoop } from '@ethosagent/core';
import type { PersonalityConfig, Storage } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Dream state — internal, not exported from types
// ---------------------------------------------------------------------------

interface DreamState {
  lastDreamAt: string; // ISO date string
  runsToday: number;
  windowStart: string; // ISO date string
}

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
  private readonly lastUserTurnAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly storage: Storage,
    private readonly getLoop: (personalityId: string) => AgentLoop | undefined,
    private readonly getConfig: (personalityId: string) => PersonalityConfig | undefined,
  ) {}

  /** Call on every inbound user message to update the activity timestamp. */
  recordUserTurn(personalityId: string): void {
    this.lastUserTurnAt.set(personalityId, Date.now());
  }

  /** Start the idle-check interval (every 5 minutes). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 5 * 60_000);
    this.timer.unref?.();
  }

  /** Stop the idle-check interval and clean up. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    for (const [personalityId, lastTurn] of this.lastUserTurnAt) {
      const config = this.getConfig(personalityId);
      if (!config?.dreaming?.enable) continue;

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
  }

  private async checkEligibility(personalityId: string, maxPerDay: number): Promise<boolean> {
    const path = `personalities/${personalityId}/dream-state.json`;
    const raw = await this.storage.read(path);
    if (!raw) return true;

    try {
      const state: DreamState = JSON.parse(raw);
      const windowStart = new Date(state.windowStart).getTime();
      const now = Date.now();

      if (now - windowStart > 24 * 60 * 60_000) return true;
      return state.runsToday < maxPerDay;
    } catch {
      return true; // corrupt state → allow
    }
  }

  private async executeDream(personalityId: string, config: PersonalityConfig): Promise<void> {
    const loop = this.getLoop(personalityId);
    if (!loop) return;

    const prompt = config.dreaming?.prompt ?? DEFAULT_DREAM_PROMPT;
    const sessionKey = `dream:${personalityId}:${Date.now()}`;

    // Run the dream turn — consume all events silently
    for await (const event of loop.run(prompt, {
      personalityId,
      sessionKey,
    })) {
      // Drain events — dream output is not surfaced to any user channel
      if (event.type === 'error') break;
      if (event.type === 'done') break;
    }

    // Persist updated state
    await this.persistState(personalityId);
  }

  private async persistState(personalityId: string): Promise<void> {
    const path = `personalities/${personalityId}/dream-state.json`;
    const raw = await this.storage.read(path);

    let runsToday = 1;
    let windowStart = new Date().toISOString();

    if (raw) {
      try {
        const prev: DreamState = JSON.parse(raw);
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
