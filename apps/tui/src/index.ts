import { basename } from 'node:path';
import { AgentBridge, type BridgeApprovalSource } from '@ethosagent/agent-bridge';
import type { AgentLoop } from '@ethosagent/core';
import type { BackgroundJob } from '@ethosagent/types';
import { render } from 'ink';
import { createElement } from 'react';
import { App, type AppProps, type ExternalSlashCommands } from './components/App';
import type { SplashInventory } from './components/Splash';
import type { RebuiltLoop } from './loop-switch';

export type { BridgeOpts } from '@ethosagent/agent-bridge';
export { AgentBridge } from '@ethosagent/agent-bridge';
export type { ExternalSlashCommands } from './components/App';
export type { SplashInventory } from './components/Splash';
export type { ExternalSlashCommand } from './help';
export type { RebuiltLoop } from './loop-switch';

export interface TUIOptions {
  model: string;
  personality: string;
  verbose?: boolean;
  /** Named skin to apply at boot (one of the built-in skin names). */
  skin?: string;
  /**
   * B2 — host startup warnings (config parse notices) rendered once on mount
   * as dim system lines, the same lines the readline branch prints.
   */
  startupNotices?: string[];
  /** Called when the user switches model via /model picker. Returns the new
   *  loop and the release of the runtime it replaces (`RebuiltLoop`). */
  rebuildLoop?: (modelId: string) => Promise<RebuiltLoop>;
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
  /**
   * C5 — subscribe to background-job completions (the executor's `onComplete`
   * shape). The TUI renders the same completion box the readline branch
   * prints and counts completions in the status bar (`bg:N`). Returns an
   * unsubscribe.
   */
  onBackgroundComplete?: (cb: (job: BackgroundJob) => void) => () => void;
  /** `/memory` reader over the configured backend's file memory (see `AppProps.readMemory`). */
  readMemory: (scope: { personalityId: string; sessionKey: string }) => Promise<string | null>;
  /** `/fork`, `/branches`, `/branch <n>` over the host's session store (see `AppProps.branches`). */
  branches?: AppProps['branches'];
  /**
   * Stores a plugin credential typed into the masked `credential_required`
   * modal — pass `PluginLoader.setCredential`, the one writer. Without it the
   * TUI does not opt its sends in to credential requests.
   */
  setPluginCredential?: (pluginId: string, key: string, value: string) => Promise<void>;
  /**
   * Where tool-approval prompts come from — the host's approval gate
   * (`createTerminalApprovalSource`, apps/ethos/src/terminal-approval.ts).
   * Relayed through the bridge (`AgentBridge.setApprovalSource`) and rendered
   * as `ApprovalModal`. Absent → the TUI shows no approval prompt.
   */
  approvals?: BridgeApprovalSource;
}

export async function runTUI(loop: AgentLoop, opts: TUIOptions): Promise<void> {
  const bridge = new AgentBridge(loop);
  if (opts.approvals) bridge.setApprovalSource(opts.approvals);
  const sessionKey = `cli:${basename(process.cwd())}`;

  const { waitUntilExit } = render(
    createElement(App, {
      bridge,
      model: opts.model,
      initialPersonality: opts.personality,
      initialSessionKey: sessionKey,
      initialVerbose: opts.verbose ?? false,
      initialSkin: opts.skin,
      startupNotices: opts.startupNotices,
      rebuildLoop: opts.rebuildLoop,
      inventory: opts.inventory,
      version: opts.version,
      preprocessInput: opts.preprocessInput,
      slashCommands: opts.slashCommands,
      onNotification: opts.onNotification,
      onSkillProposed: opts.onSkillProposed,
      onBackgroundComplete: opts.onBackgroundComplete,
      readMemory: opts.readMemory,
      ...(opts.branches ? { branches: opts.branches } : {}),
      setPluginCredential: opts.setPluginCredential,
    }),
  );

  await waitUntilExit();
}
