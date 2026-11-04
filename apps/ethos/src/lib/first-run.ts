// ---------------------------------------------------------------------------
// First-run extras that follow a successful setup (plan keyless-first-run
// §4.2 D15/D16, §5.2 D21): the user-owned born agent, the no-sign-in
// connectors, and the first-task suggestions. Every prompt goes through an
// injected `ask`, so none of it needs a terminal in tests.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import { createPersonalityRegistry, isSafePathSegment } from '@ethosagent/wiring';
import {
  addNoSignInPresets,
  type KeylessProbeResult,
  noSignInPresets,
  oauthPresets,
  probeKeyless,
} from '@ethosagent/wiring/keyless-probe';
import { duplicateBornPersonality } from '../commands/personality-create';
import { type OllamaOfferResult, runOllamaInstallOffer } from './ollama-install';

export interface Prompter {
  ask: (question: string) => Promise<string>;
  print: (line: string) => void;
}

/** Same slug rule as `createBlankPersonality`. */
export function slugAgentName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function defaultAgentName(builtinId: string, builtinName?: string): string {
  return `My ${builtinName ?? titleCase(builtinId)}`;
}

export type BornAgentResult =
  | { status: 'created' | 'reused'; id: string }
  /** The copy could not be made; the built-in stays the default (Q3 branch). */
  | { status: 'failed'; reason: string };

/**
 * D15: duplicate the chosen built-in into a user-owned, born personality.
 * An id that already holds a user personality is reused, never duplicated
 * twice (pinned by __tests__/setup-born-agent.test.ts "a re-run ... reuses it").
 */
export async function ensureBornAgent(opts: {
  storage: Storage;
  dataDir: string;
  sourceId: string;
  name: string;
}): Promise<BornAgentResult> {
  const id = slugAgentName(opts.name);
  if (!id || !isSafePathSegment(id))
    return { status: 'failed', reason: `"${opts.name}" is not a usable name` };
  if (await opts.storage.exists(join(opts.dataDir, 'personalities', id, 'config.yaml'))) {
    return { status: 'reused', id };
  }
  try {
    await duplicateBornPersonality(opts.storage, opts.dataDir, opts.sourceId, id);
    return { status: 'created', id };
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Attach servers to one personality only (default-deny per personality). */
export async function attachConnectors(opts: {
  storage: Storage;
  dataDir: string;
  agentId: string;
  names: readonly string[];
}): Promise<string[]> {
  if (opts.names.length === 0) return [];
  const reg = await createPersonalityRegistry({
    storage: opts.storage,
    userPersonalitiesDir: opts.dataDir,
  });
  await reg.loadFromDirectory(join(opts.dataDir, 'personalities'));
  const current = reg.get(opts.agentId)?.mcp_servers ?? [];
  const merged = [...new Set([...current, ...opts.names])];
  await reg.update(opts.agentId, { mcp_servers: merged });
  return [...opts.names];
}

/** Parse "1 3" / "1,3" into 0-based indexes inside [0, max); junk is dropped. */
export function parsePicks(answer: string, max: number): number[] {
  const out = new Set<number>();
  for (const tok of answer.split(/[\s,]+/)) {
    const n = Number.parseInt(tok, 10);
    if (Number.isInteger(n) && n >= 1 && n <= max) out.add(n - 1);
  }
  return [...out];
}

/**
 * D21: multi-select of the no-sign-in presets; OAuth presets are printed as the
 * two commands that connect them. Skippable, never throws into setup.
 * Resolves the names attached.
 */
export async function runConnectorsStep(opts: {
  storage: Storage;
  dataDir: string;
  agentId: string;
  prompt: Prompter;
}): Promise<string[]> {
  const { prompt, agentId } = opts;
  const presets = noSignInPresets();
  prompt.print('\nConnect tools to your agent (no sign-in needed):');
  for (const [i, p] of presets.entries()) {
    prompt.print(`  ${i + 1}. ${p.label} - ${p.description}`);
  }
  const answer = await prompt.ask('Numbers to connect (e.g. "1 3"), Enter to skip: ');
  const picked = parsePicks(answer, presets.length)
    .map((i) => presets[i]?.name)
    .filter((n): n is string => n !== undefined);
  let attached: string[] = [];
  if (picked.length > 0) {
    try {
      const written = await addNoSignInPresets(
        opts.storage,
        picked,
        join(opts.dataDir, 'mcp.json'),
      );
      attached = await attachConnectors({
        storage: opts.storage,
        dataDir: opts.dataDir,
        agentId,
        names: written,
      });
      prompt.print(`Connected to ${agentId}: ${attached.join(', ')}`);
    } catch (err) {
      prompt.print(`Could not connect tools: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const oauth = oauthPresets();
  if (oauth.length > 0) {
    prompt.print('\nNeed a sign-in? Connect these later:');
    for (const p of oauth) {
      prompt.print(`  ethos mcp add ${p.name} --url ${p.url}`);
      prompt.print(`  ethos personality mcp ${agentId} --attach ${p.name}`);
    }
  }
  return attached;
}

const OAUTH_TASKS: Record<string, string> = {
  linear: 'Show my open issues.',
};

/** D16: static strings chosen by what is connected; at most four. */
export function firstTaskSuggestions(connected: readonly string[]): string[] {
  const tasks = ['Look around this folder and tell me what it is.'];
  if (connected.includes('deepwiki')) {
    tasks.push('Ask DeepWiki how a repository I care about handles errors.');
  }
  for (const name of connected) {
    const t = OAUTH_TASKS[name];
    if (t) tasks.push(t);
  }
  tasks.push('Help me plan my week. Ask me three questions first.');
  return tasks.slice(0, 4);
}

/**
 * Print numbered suggestions; resolve the picked text, or undefined on Enter
 * or anything that is not a listed number (D16/D17: an explicit user action).
 */
export async function pickFirstTask(
  prompt: Prompter,
  connected: readonly string[],
): Promise<string | undefined> {
  const tasks = firstTaskSuggestions(connected);
  prompt.print('\nTry a first task:');
  for (const [i, t] of tasks.entries()) {
    prompt.print(`  ${i + 1}. ${t}`);
  }
  const answer = await prompt.ask('Number to start with it, Enter to skip: ');
  const n = Number.parseInt(answer.trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= tasks.length ? tasks[n - 1] : undefined;
}

function hasBrew(): boolean {
  try {
    return spawnSync('brew', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/** The probe against this machine. `secrets` is the Ethos vault (read-only use). */
export function probeThisMachine(
  secrets: import('@ethosagent/types').SecretsResolver,
  over: { fetchImpl?: typeof fetch; home?: string } = {},
): Promise<KeylessProbeResult> {
  return probeKeyless({
    secrets,
    platform: process.platform,
    totalMemBytes: totalmem(),
    isRoot: process.getuid?.() === 0,
    hasBrew: hasBrew(),
    ...over,
  });
}

/** Run the Ollama install offer for the probe's install-offer candidate, if any. */
export async function runInstallOfferFromProbe(
  probe: KeylessProbeResult,
  prompt: Prompter,
  isTTY: boolean,
): Promise<OllamaOfferResult | null> {
  const offer = probe.candidates.find((c) => c.kind === 'install-offer');
  if (offer?.kind !== 'install-offer') return null;
  return runOllamaInstallOffer({
    plan: offer.plan,
    pick: { modelId: offer.model.modelId, approxDownloadGb: offer.model.approxDownloadGb },
    isTTY,
    ask: prompt.ask,
    print: prompt.print,
  });
}

export interface FirstRunOutcome {
  /** The personality id to write into config.yaml. */
  personality: string;
  born: BornAgentResult | { status: 'kept-builtin' };
  connected: string[];
  /** A first task the user picked; the chat starts with it. */
  initialMessage?: string;
}

const KEEP_WORD = 'keep';

/**
 * D15 + D21 + D16 after the model is settled. `interactive: false` takes the
 * default name and asks nothing (`setup --keyless`, piped stdin). The built-in
 * stays the default when the user types `keep` or the copy cannot be made; both
 * skip connectors, with a line saying why (Q3).
 */
export async function runFirstRunExtras(opts: {
  storage: Storage;
  dataDir: string;
  builtinId: string;
  prompt: Prompter;
  interactive: boolean;
}): Promise<FirstRunOutcome> {
  const { storage, dataDir, builtinId, prompt, interactive } = opts;
  const keep = (reason: string): FirstRunOutcome => {
    prompt.print(`Keeping the built-in "${builtinId}": ${reason}`);
    return { personality: builtinId, born: { status: 'kept-builtin' }, connected: [] };
  };

  // A chosen personality the user already owns needs no copy and no questions.
  if (await storage.exists(join(dataDir, 'personalities', builtinId, 'config.yaml'))) {
    return { personality: builtinId, born: { status: 'reused', id: builtinId }, connected: [] };
  }

  const fallbackName = defaultAgentName(builtinId);
  let name = fallbackName;
  if (interactive) {
    const answer = (
      await prompt.ask(
        `Name your agent (Enter for "${fallbackName}", "${KEEP_WORD}" uses the built-in as is): `,
      )
    ).trim();
    if (answer.toLowerCase() === KEEP_WORD) {
      return keep('no personal copy, so no first-chat introduction and no connectors.');
    }
    if (answer) name = answer;
  }

  const born = await ensureBornAgent({ storage, dataDir, sourceId: builtinId, name });
  if (born.status === 'failed') return keep(`could not create your copy (${born.reason}).`);
  prompt.print(
    born.status === 'created'
      ? `Created your agent "${born.id}" from ${builtinId}.`
      : `Using your existing agent "${born.id}".`,
  );

  if (!interactive) return { personality: born.id, born, connected: [] };

  const connected = await runConnectorsStep({ storage, dataDir, agentId: born.id, prompt });
  const initialMessage = await pickFirstTask(prompt, connected);
  return { personality: born.id, born, connected, ...(initialMessage ? { initialMessage } : {}) };
}
