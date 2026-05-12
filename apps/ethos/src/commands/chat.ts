import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { InMemorySteerSink } from '@ethosagent/agent-bridge';
import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import type { SplashInventory } from '@ethosagent/tui';
import type { SteerSink } from '@ethosagent/types';
import type { EthosConfig } from '../config';
import { SpinnerState } from '../lib/spinner';
import { renderStatusBar, type Threshold } from '../lib/status-bar';
import { formatToolFeedLine } from '../lib/tool-feed';
import { isVerbosity, nextVerbosity, projectEvent, type Verbosity } from '../lib/verbosity';
import { resolveActiveLoop, startEvolverCron, startNightlyPrune } from '../wiring';
import { runPairingCommand } from './pairing-commands';
import { formatVerboseSummary, type TurnTiming } from './verbose-timing';

async function buildInventory(loop: AgentLoop, _config: EthosConfig): Promise<SplashInventory> {
  const tools = loop.getAvailableTools();
  let personalities: string[];
  try {
    personalities = loop.getPersonalityIds();
    if (personalities.length === 0)
      personalities = ['researcher', 'engineer', 'reviewer', 'coach', 'operator'];
  } catch {
    personalities = ['researcher', 'engineer', 'reviewer', 'coach', 'operator'];
  }

  const groupMap = new Map<string, string[]>();
  for (const tool of tools) {
    const ts = tool.toolset ?? 'general';
    const names = groupMap.get(ts) ?? [];
    names.push(tool.name);
    groupMap.set(ts, names);
  }

  const toolGroups = [...groupMap.entries()].map(([toolset, names]) => ({ toolset, names }));

  return {
    tools: toolGroups,
    totalTools: tools.length,
    personalities,
    skills: [],
    mcpServers: [],
  };
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  orange: '\x1b[38;5;208m',
};

const out = (s: string) => process.stdout.write(s);

function colorForThreshold(t: Threshold): string {
  switch (t) {
    case 'red':
      return c.red;
    case 'orange':
      return c.orange;
    case 'yellow':
      return c.yellow;
    case 'green':
      return c.green;
  }
}

// FW-1 — model context window. Conservative default of 200K matches Anthropic
// Sonnet/Opus and the OpenAI Compat default. Specific routes can refine later.
const DEFAULT_CONTEXT_MAX = 200_000;

// ---------------------------------------------------------------------------
// Mutable chat state
// ---------------------------------------------------------------------------

type BusyInputMode = 'interrupt' | 'queue' | 'steer';

interface ChatState {
  sessionKey: string;
  personalityId: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  /** FW-1 — running max-of-turn context tokens for the status bar. */
  contextTokens: number;
  startedAt: number;
  verbosity: Verbosity;
  busyMode: BusyInputMode;
  toolPreviewLength: number;
  modelName: string;
  /** Steer sink used by AgentLoop when `busyMode === 'steer'`. */
  steerSink: SteerSink;
  /** Inputs typed during an in-flight turn (`queue` mode). FIFO. */
  inputQueue: string[];
  /** Currently running turn — null when idle. */
  abort: AbortController | null;
  /** Total in-flight iterations seen this turn (for steer pre-first-iteration fallback). */
  iterationsThisTurn: number;
  /**
   * True from the moment the user submits a normal turn through the end of
   * queue-draining. Distinct from `abort` (which is null between consecutive
   * drained turns). Prevents a second `'line'` event from spawning an
   * overlapping `runTurn` while we're mid-drain. (Codex P2 finding #4.)
   */
  draining: boolean;
}

interface RunChatOptions {
  singleQuery?: string;
}

function renderStatusBarLine(state: ChatState): void {
  const cols = process.stdout.columns ?? 80;
  const bar = renderStatusBar({
    model: state.modelName,
    contextTokens: state.contextTokens,
    contextMax: DEFAULT_CONTEXT_MAX,
    elapsedSecs: Math.floor((Date.now() - state.startedAt) / 1000),
    columns: cols,
  });
  const color = colorForThreshold(bar.threshold);
  out(`${c.dim}⚕ ${color}${bar.text}${c.reset}\n`);
}

// ---------------------------------------------------------------------------
// Main chat entry point
// ---------------------------------------------------------------------------

export async function runChat(config: EthosConfig, opts: RunChatOptions = {}): Promise<void> {
  startNightlyPrune(config.retention, config.personalitiesConfig);
  if (config.evolverCronEnabled) {
    const schedule = config.evolverSchedule ?? '0 3 * * *';
    void startEvolverCron(schedule);
  }
  const { loop, personalityId, displayName } = await resolveActiveLoop(config);

  if (opts.singleQuery) {
    await runSingleQuery(loop, config, {
      query: opts.singleQuery,
      sessionKey: `cli:${basename(process.cwd())}`,
      personalityId,
    });
    return;
  }

  if (process.stdout.isTTY && process.stdin.isTTY) {
    const { runTUI } = await import('@ethosagent/tui');
    const inventory = await buildInventory(loop, config);
    await runTUI(loop, {
      model: config.model,
      personality: displayName,
      verbose: config.verbose ?? false,
      skin: config.skin,
      inventory,
      rebuildLoop: async (modelId: string) => {
        const { loop: newLoop } = await resolveActiveLoop({ ...config, model: modelId });
        return newLoop;
      },
    });
    return;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const state: ChatState = {
    sessionKey: `cli:${basename(process.cwd())}`,
    personalityId,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    contextTokens: 0,
    startedAt: Date.now(),
    verbosity: config.displayVerbosity ?? (config.verbose ? 'verbose' : 'default'),
    busyMode: config.displayBusyInputMode ?? 'interrupt',
    toolPreviewLength: config.displayToolPreviewLength ?? 0,
    modelName: config.model,
    steerSink: new InMemorySteerSink(),
    inputQueue: [],
    abort: null,
    iterationsThisTurn: 0,
    draining: false,
  };

  rl.on('SIGINT', () => {
    if (state.abort) {
      state.abort.abort();
      out(`\n${c.dim}[aborted — press Ctrl+C again to exit]${c.reset}\n`);
    } else {
      out('\n');
      rl.close();
    }
  });

  rl.on('close', () => process.exit(0));

  // Welcome
  out(`${c.bold}ethos${c.reset}  ${c.dim}${config.model} · ${displayName} · /help${c.reset}\n\n`);

  if (state.verbosity !== 'quiet') renderStatusBarLine(state);

  // Switch from blocking rl.question to event-driven rl.on('line') so mid-turn
  // input can be dispatched on busyMode.
  rl.setPrompt(`${c.cyan}You${c.reset} > `);
  rl.prompt();

  rl.on('line', (raw) => {
    const input = raw.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Slash commands are always dispatched immediately — even mid-turn — except
    // /busy and /steer which have special busy-state semantics handled below.
    const isBusySlash = input.startsWith('/busy') || input.startsWith('/steer');
    if (input.startsWith('/') && !isBusySlash) {
      handleSlashCommand(input, state, loop, rl, config)
        .then(() => {
          // Only re-prompt when idle; a running turn will prompt on completion.
          if (!state.draining && !state.abort) rl.prompt();
        })
        .catch((err) => {
          out(`${c.red}Error: ${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
          if (!state.draining && !state.abort) rl.prompt();
        });
      return;
    }

    // Mid-drain / mid-turn: route non-slash input (and /busy, /steer) through
    // the busy handler so two consecutive 'line' events can't spawn overlapping turns.
    if (state.draining || state.abort) {
      handleBusyInput(input, state);
      return;
    }

    state.draining = true;
    runTurn(input, state, loop)
      .then(() => {
        const drainNext = () => {
          const next = state.inputQueue.shift();
          if (!next) {
            state.draining = false;
            if (state.verbosity !== 'quiet') renderStatusBarLine(state);
            rl.prompt();
            return;
          }
          out(`${c.dim}[draining queue → ${next}]${c.reset}\n`);
          runTurn(next, state, loop)
            .then(drainNext)
            .catch((err) => {
              state.draining = false;
              out(`${c.red}Error: ${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
              rl.prompt();
            });
        };
        drainNext();
      })
      .catch((err) => {
        state.draining = false;
        out(`${c.red}Error: ${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
        rl.prompt();
      });
  });
}

// ---------------------------------------------------------------------------
// FW-9 — busy-input dispatch
// ---------------------------------------------------------------------------

function handleBusyInput(input: string, state: ChatState): void {
  // /steer <text> and /busy <mode|status> always work regardless of mode.
  if (input.startsWith('/steer ')) {
    const text = input.slice('/steer '.length).trim();
    pushSteer(text, state);
    return;
  }
  if (input.startsWith('/busy')) {
    const arg = input.slice('/busy'.length).trim();
    handleBusyCommand(arg, state);
    return;
  }

  switch (state.busyMode) {
    case 'interrupt': {
      state.abort?.abort();
      // Queue the new input — it fires on the next prompt cycle after the
      // current turn unwinds.
      state.inputQueue.unshift(input);
      out(`${c.dim}[interrupted — restarting with new input]${c.reset}\n`);
      return;
    }
    case 'queue': {
      state.inputQueue.push(input);
      out(`${c.dim}[queued — depth ${state.inputQueue.length}]${c.reset}\n`);
      return;
    }
    case 'steer': {
      pushSteer(input, state);
      return;
    }
  }
}

function pushSteer(text: string, state: ChatState): void {
  if (!text) return;
  // Pre-first-iteration steers fall back to queue (LLM hasn't called yet, so
  // no tool_results to attach to). Iterations >0 reach the seam.
  if (state.iterationsThisTurn === 0) {
    state.inputQueue.push(text);
    out(
      `${c.dim}[steer → queued (pre-first-iteration), depth ${state.inputQueue.length}]${c.reset}\n`,
    );
    return;
  }
  const ok = state.steerSink.push(text);
  if (!ok) {
    out(`${c.red}[steer sink full — dropped]${c.reset}\n`);
    return;
  }
  out(`${c.dim}[steer queued — folds in at next iteration]${c.reset}\n`);
}

function handleBusyCommand(arg: string, state: ChatState): void {
  if (!arg || arg === 'status') {
    out(`${c.dim}busy mode: ${state.busyMode}${c.reset}\n`);
    return;
  }
  if (arg === 'interrupt' || arg === 'queue' || arg === 'steer') {
    state.busyMode = arg;
    out(`${c.dim}busy mode: ${arg}${c.reset}\n`);
    return;
  }
  out(`${c.dim}Usage: /busy [interrupt|queue|steer|status]${c.reset}\n`);
}

// ---------------------------------------------------------------------------
// Turn runner
// ---------------------------------------------------------------------------

async function runTurn(input: string, state: ChatState, loop: AgentLoop): Promise<void> {
  state.abort = new AbortController();
  state.iterationsThisTurn = 0;

  const reducedMotion = process.env.ETHOS_NO_SPINNER_ANIMATION === '1';
  const spinner = new SpinnerState({ reducedMotion });
  spinner.start(Date.now());

  let spinnerCleared = false;
  if (state.verbosity !== 'quiet') {
    out(
      `${c.bold}ethos${c.reset} ${c.dim}${spinner.frame()} thinking ${spinner.elapsed()}${c.reset}`,
    );
  }
  const spinnerInterval = setInterval(
    () => {
      spinner.tick(Date.now());
      if (!spinnerCleared && state.verbosity !== 'quiet') {
        out(
          `\r${c.bold}ethos${c.reset} ${c.dim}${spinner.frame()} thinking ${spinner.elapsed()}${c.reset}`,
        );
      }
    },
    reducedMotion ? 500 : 100,
  );

  function clearSpinner(): void {
    if (spinnerCleared) return;
    spinnerCleared = true;
    spinner.stop(Date.now());
    clearInterval(spinnerInterval);
    if (state.verbosity !== 'quiet') {
      // Wipe the spinner line cleanly so trailing chars don't bleed into output.
      out('\r\x1b[2K');
    }
  }

  const turnStart = Date.now();
  let firstTextDeltaAt: number | null = null;
  const toolDurations: number[] = [];
  let turnUsage: TurnTiming['turnUsage'] = null;
  const toolStartTimes = new Map<string, number>();
  const toolArgs = new Map<string, unknown>();
  const toolNames = new Map<string, string>();
  let hasText = false;

  try {
    for await (const event of loop.run(input, {
      sessionKey: state.sessionKey,
      personalityId: state.personalityId,
      abortSignal: state.abort.signal,
      ...(state.busyMode === 'steer' ? { steerSink: state.steerSink } : {}),
    })) {
      // Track iteration count — proxy by counting `run_start`+tool_start sequences.
      // Per AgentLoop, an iteration starts on before_llm_call hook. We don't get
      // that event externally, so use first tool_start or text_delta as proxy.
      if (event.type === 'text_delta' || event.type === 'tool_start') {
        if (state.iterationsThisTurn === 0) state.iterationsThisTurn = 1;
      }
      if (event.type === 'tool_end') {
        // A tool_end -> next iteration boundary, so the steer drain fires next.
        state.iterationsThisTurn++;
      }

      if (event.type === 'tool_start') {
        toolStartTimes.set(event.toolCallId, Date.now());
        toolArgs.set(event.toolCallId, event.args);
        toolNames.set(event.toolCallId, event.toolName);
      }
      if (event.type === 'text_delta' && firstTextDeltaAt === null) {
        firstTextDeltaAt = Date.now();
        clearSpinner();
        if (state.verbosity !== 'quiet') out(`${c.bold}ethos${c.reset} > `);
      }
      if (event.type === 'tool_start' && !spinnerCleared) {
        clearSpinner();
        if (state.verbosity !== 'quiet') out('\n');
      }
      if (event.type === 'tool_end') {
        toolDurations.push(event.durationMs);
      }
      if (event.type === 'usage') {
        turnUsage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          estimatedCostUsd: event.estimatedCostUsd,
        };
        state.contextTokens = event.inputTokens + event.outputTokens;
      }
      if (event.type === 'error') clearSpinner();

      renderEventForVerbosity(event, state, {
        hasText,
        toolStartTimes,
        toolArgs,
        toolNames,
      });

      if (event.type === 'text_delta') hasText = true;

      if (event.type === 'done') {
        clearSpinner();
        if (state.verbosity === 'verbose' || state.verbosity === 'debug') {
          const summary = formatVerboseSummary({
            turnStart,
            turnEnd: Date.now(),
            firstTextDeltaAt,
            toolDurations,
            turnUsage,
          });
          out(`\n${c.dim}${summary}${c.reset}`);
        }
      }
    }
  } catch (err) {
    clearSpinner();
    if (!state.abort?.signal.aborted) {
      out(`\n${c.red}Error: ${err instanceof Error ? err.message : String(err)}${c.reset}`);
    }
  } finally {
    clearInterval(spinnerInterval);
    state.abort = null;
    // Codex P2 #2 — steers attach to an iteration seam (tool_results). A
    // text-only turn (no tools) has no seam, so a steer typed during it
    // would otherwise linger and fold into a later, unrelated turn. Drop
    // anything still queued when this turn ends.
    const stranded = state.steerSink.drain();
    if (stranded.length > 0 && state.verbosity !== 'quiet') {
      out(
        `${c.yellow}[discarded ${stranded.length} unread steer${stranded.length === 1 ? '' : 's'} — no tool seam in turn]${c.reset}\n`,
      );
    }
    if (state.verbosity !== 'quiet') out('\n\n');
  }
}

// ---------------------------------------------------------------------------
// Event renderer
// ---------------------------------------------------------------------------

interface RenderContext {
  hasText: boolean;
  toolStartTimes: Map<string, number>;
  toolArgs: Map<string, unknown>;
  toolNames: Map<string, string>;
}

function renderEventForVerbosity(event: AgentEvent, state: ChatState, ctx: RenderContext): void {
  const lines = projectEvent(event, state.verbosity);
  if (lines.length === 0) return;

  switch (event.type) {
    case 'text_delta':
      out(event.text);
      break;

    case 'tool_start':
      if (state.verbosity === 'verbose' || state.verbosity === 'debug') {
        if (ctx.hasText) out('\n');
        out(`${c.dim}  ⟳ ${event.toolName}${c.reset}\n`);
      }
      break;

    case 'tool_progress':
      if (state.verbosity === 'default' && event.audience !== 'user') break;
      if (event.toolName === '_watcher') {
        out(`${c.yellow}  ${event.message}${c.reset}\n`);
      } else {
        out(`${c.dim}  · ${event.toolName}: ${event.message}${c.reset}\n`);
      }
      break;

    case 'tool_end': {
      const startedAt = ctx.toolStartTimes.get(event.toolCallId) ?? Date.now();
      const ms = Date.now() - startedAt;
      ctx.toolStartTimes.delete(event.toolCallId);
      const args = ctx.toolArgs.get(event.toolCallId) ?? {};
      ctx.toolArgs.delete(event.toolCallId);
      ctx.toolNames.delete(event.toolCallId);
      const line = formatToolFeedLine({
        toolName: event.toolName,
        args,
        durationMs: event.durationMs ?? ms,
        previewLength: state.toolPreviewLength,
      });
      const mark = event.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
      out(`${c.dim}  ${mark} ${line}${c.reset}\n`);
      break;
    }

    case 'usage':
      state.usage.inputTokens += event.inputTokens;
      state.usage.outputTokens += event.outputTokens;
      state.usage.costUsd += event.estimatedCostUsd;
      break;

    case 'error':
      out(`\n${c.red}[${event.code}] ${event.error}${c.reset}`);
      break;

    case 'run_start':
      if (state.verbosity === 'verbose' || state.verbosity === 'debug') {
        out(`${c.dim}↳ ${event.provider}/${event.model} (${event.source})${c.reset}\n`);
      }
      break;

    case 'thinking_delta':
    case 'done':
    case 'context_meta':
      // Not surfaced in the rendered stream.
      break;
  }

  // Debug verbosity: dump raw JSON for every event (after primary render).
  if (state.verbosity === 'debug') {
    out(`${c.dim}[debug] ${JSON.stringify(event)}${c.reset}\n`);
  }
}

// ---------------------------------------------------------------------------
// Single-query (non-interactive) runner
// ---------------------------------------------------------------------------

async function runSingleQuery(
  loop: AgentLoop,
  config: EthosConfig,
  input: { query: string; sessionKey: string; personalityId: string },
): Promise<void> {
  const verbosity: Verbosity = config.displayVerbosity ?? (config.verbose ? 'verbose' : 'default');
  const turnStart = Date.now();
  let firstTextDeltaAt: number | null = null;
  const toolDurations: number[] = [];
  let turnUsage: TurnTiming['turnUsage'] = null;

  for await (const event of loop.run(input.query, {
    sessionKey: input.sessionKey,
    personalityId: input.personalityId,
  })) {
    if (event.type === 'text_delta') {
      if (firstTextDeltaAt === null) firstTextDeltaAt = Date.now();
      out(event.text);
    }
    if (event.type === 'tool_end') toolDurations.push(event.durationMs);
    if (event.type === 'usage') {
      turnUsage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        estimatedCostUsd: event.estimatedCostUsd,
      };
    }
    if (event.type === 'done' && (verbosity === 'verbose' || verbosity === 'debug')) {
      const summary = formatVerboseSummary({
        turnStart,
        turnEnd: Date.now(),
        firstTextDeltaAt,
        toolDurations,
        turnUsage,
      });
      out(`\n${c.dim}${summary}${c.reset}`);
    }
  }
  out('\n');
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

async function handleSlashCommand(
  raw: string,
  state: ChatState,
  loop: AgentLoop,
  rl: ReturnType<typeof createInterface>,
  _config: EthosConfig,
): Promise<void> {
  const parts = raw.slice(1).trim().split(/\s+/);
  const name = parts[0]?.toLowerCase() ?? '';
  const arg = parts.slice(1).join(' ');

  switch (name) {
    case 'help':
      out(
        `\n${c.dim}` +
          `  /new                  start a fresh session\n` +
          `  /personality          show current personality\n` +
          `  /personality list     list all personalities\n` +
          `  /personality <id>     switch personality\n` +
          `  /model <name>         switch model for this session\n` +
          `  /memory               show ~/.ethos/MEMORY.md and USER.md\n` +
          `  /usage                show token and cost stats\n` +
          `  /budget               show session spend against cap\n` +
          `  /budget reset         reset the session budget counter\n` +
          `  /verbose              cycle quiet → default → verbose → debug\n` +
          `  /verbose <level>      set level directly\n` +
          `  /verbose status       show current level\n` +
          `  /busy <mode|status>   busy-input mode (interrupt/queue/steer)\n` +
          `  /steer <text>         inject [USER STEER] mid-turn\n` +
          `  /allow <code>         approve a pending channel sender by pairing code\n` +
          `  /deny <platform> <id> revoke an approved channel sender\n` +
          `  /communications       list approved senders + pending pairing codes\n` +
          `  /exit                 quit\n` +
          `${c.reset}\n`,
      );
      break;

    case 'new':
    case 'reset':
      loop.resetSessionCost(state.sessionKey);
      state.sessionKey = `cli:${basename(process.cwd())}:${Date.now()}`;
      state.contextTokens = 0;
      state.startedAt = Date.now();
      out(`${c.dim}[new session started]${c.reset}\n`);
      break;

    case 'personality': {
      if (!arg) {
        out(`${c.dim}Current: ${state.personalityId}${c.reset}\n`);
        break;
      }
      if (arg === 'list') {
        out(
          `${c.dim}Built-ins: researcher · engineer · reviewer · coach · operator\n` +
            `User personalities: ~/.ethos/personalities/<id>/\n${c.reset}`,
        );
        break;
      }
      state.personalityId = arg;
      out(`${c.dim}[personality: ${arg}]${c.reset}\n`);
      break;
    }

    case 'model': {
      if (!arg) {
        out(`${c.dim}Current model: ${_config.model}${c.reset}\n`);
        break;
      }
      out(
        `${c.yellow}Model switching takes effect on next restart. Edit ~/.ethos/config.yaml to persist.${c.reset}\n`,
      );
      break;
    }

    case 'memory': {
      const { createMemoryProvider } = await import('@ethosagent/wiring');
      const { ethosDir } = await import('../config');
      const mem = createMemoryProvider({ dataDir: ethosDir() });
      const result = await mem.prefetch({
        sessionId: '',
        sessionKey: state.sessionKey,
        platform: 'cli',
      });
      if (result) {
        out(`\n${result.content}${result.truncated ? `\n${c.dim}[truncated]${c.reset}` : ''}\n\n`);
      } else {
        out(`${c.dim}[no memory yet — chat to build it]${c.reset}\n`);
      }
      break;
    }

    case 'usage':
      out(
        `${c.dim}` +
          `Tokens  : ${state.usage.inputTokens.toLocaleString()} in · ${state.usage.outputTokens.toLocaleString()} out\n` +
          `Cost    : $${state.usage.costUsd.toFixed(5)}\n` +
          `${c.reset}`,
      );
      break;

    case 'budget': {
      if (arg === 'reset') {
        loop.resetSessionCost(state.sessionKey);
        out(`${c.dim}[budget counter reset]${c.reset}\n`);
        break;
      }
      const spent = loop.getSessionCost(state.sessionKey);
      out(
        `${c.dim}Session spend: $${spent.toFixed(5)}\n` +
          `Use /budget reset to clear the counter.\n${c.reset}`,
      );
      break;
    }

    case 'verbose': {
      if (!arg) {
        state.verbosity = nextVerbosity(state.verbosity);
        out(`${c.dim}verbosity: ${state.verbosity}${c.reset}\n`);
        break;
      }
      if (arg === 'status') {
        out(`${c.dim}verbosity: ${state.verbosity}${c.reset}\n`);
        break;
      }
      if (isVerbosity(arg)) {
        state.verbosity = arg;
        out(`${c.dim}verbosity: ${arg}${c.reset}\n`);
        break;
      }
      out(
        `${c.yellow}Invalid level '${arg}' — falling back to default. Valid: quiet|default|verbose|debug${c.reset}\n`,
      );
      state.verbosity = 'default';
      break;
    }

    case 'busy':
      handleBusyCommand(arg, state);
      break;

    case 'steer':
      // When idle, /steer queues as a fresh turn (no in-flight run to steer).
      if (!arg) {
        out(`${c.dim}Usage: /steer <text>${c.reset}\n`);
        break;
      }
      if (!state.abort) {
        state.inputQueue.push(arg);
        out(`${c.dim}[idle — /steer queued as a turn]${c.reset}\n`);
        break;
      }
      pushSteer(arg, state);
      break;

    case 'allow': {
      if (!arg) {
        out(`${c.dim}Usage: /allow <code>${c.reset}\n`);
        break;
      }
      const r = await runPairingCommand('allow', { code: arg });
      out(`${c.dim}${r}${c.reset}\n`);
      break;
    }

    case 'deny': {
      const tokens = arg.split(/\s+/).filter(Boolean);
      if (tokens.length < 2) {
        out(`${c.dim}Usage: /deny <platform> <senderId>${c.reset}\n`);
        break;
      }
      const r = await runPairingCommand('deny', {
        platform: tokens[0],
        senderId: tokens.slice(1).join(' '),
      });
      out(`${c.dim}${r}${c.reset}\n`);
      break;
    }

    case 'communications':
    case 'comms': {
      const r = await runPairingCommand('list', {});
      out(`${c.dim}${r}${c.reset}\n`);
      break;
    }

    case 'exit':
    case 'quit':
      rl.close();
      break;

    default:
      out(`${c.dim}Unknown command /${name} — type /help${c.reset}\n`);
  }
}
