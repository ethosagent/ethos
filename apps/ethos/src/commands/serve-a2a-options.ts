// The options of `buildServeA2aCore` (serve.ts), split out for the size gate;
// serve.ts re-exports the type, so its export surface is unchanged.
import type { EthosConfig } from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import type { ServePersonalityRegistry } from './serve-loop';

export interface BuildServeA2aCoreOptions {
  config: EthosConfig;
  /** `~/.ethos` (or the `--data-dir` override) — the a2a state dir's parent. */
  dir: string;
  loop: AgentLoop;
  personalities: ServePersonalityRegistry;
  activePersonality: string;
}
