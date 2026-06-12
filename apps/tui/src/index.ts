import { basename } from 'node:path';
import { AgentBridge } from '@ethosagent/agent-bridge';
import type { AgentLoop } from '@ethosagent/core';
import { render } from 'ink';
import { createElement } from 'react';
import { App, type ExternalSlashCommands } from './components/App';
import type { SplashInventory } from './components/Splash';

export type { BridgeOpts } from '@ethosagent/agent-bridge';
export { AgentBridge } from '@ethosagent/agent-bridge';
export type { ExternalSlashCommands } from './components/App';
export type { SplashInventory } from './components/Splash';
export type { ExternalSlashCommand } from './help';

export interface TUIOptions {
  model: string;
  personality: string;
  verbose?: boolean;
  /** Named skin to apply at boot (one of the built-in skin names). */
  skin?: string;
  /** Called when the user switches model via /model picker. Returns a new AgentLoop. */
  rebuildLoop?: (modelId: string) => Promise<AgentLoop>;
  /** Capability inventory shown on the splash screen before first message. */
  inventory?: SplashInventory;
  /** Current package version — used for update notifier. */
  version?: string;
  /** Transform user input before it is sent to the loop (e.g. @file/@url refs). */
  preprocessInput?: (text: string) => Promise<string>;
  /** Externally injected slash commands (plugins) — merged into /help, tried for unknown names. */
  slashCommands?: ExternalSlashCommands;
  /**
   * Subscribe to session-scoped notifications (e.g. plugin notify_session).
   * Called with the active session key; returns an unsubscribe. The TUI
   * re-subscribes whenever its session key changes (/new, /sessions).
   */
  onNotification?: (sessionKey: string, cb: (text: string) => void) => () => void;
  /** Subscribe to skill-evolver proposal notices. Returns an unsubscribe. */
  onSkillProposed?: (cb: (text: string) => void) => () => void;
}

export async function runTUI(loop: AgentLoop, opts: TUIOptions): Promise<void> {
  const bridge = new AgentBridge(loop);
  const sessionKey = `cli:${basename(process.cwd())}`;

  const { waitUntilExit } = render(
    createElement(App, {
      bridge,
      model: opts.model,
      initialPersonality: opts.personality,
      initialSessionKey: sessionKey,
      initialVerbose: opts.verbose ?? false,
      initialSkin: opts.skin,
      rebuildLoop: opts.rebuildLoop,
      inventory: opts.inventory,
      version: opts.version,
      preprocessInput: opts.preprocessInput,
      slashCommands: opts.slashCommands,
      onNotification: opts.onNotification,
      onSkillProposed: opts.onSkillProposed,
    }),
  );

  await waitUntilExit();
}
