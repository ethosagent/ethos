// ---------------------------------------------------------------------------
// CLI-side Ollama install offer (keyless-first-run §3.4, D9–D12)
//
// Consent + spawn for the plan computed in wiring (`ollamaInstallPlan`).
// Rules, each pinned in apps/ethos/src/__tests__/ollama-install.test.ts:
//  - the exact command is printed BEFORE the question;
//  - only the trimmed literal answer `yes` runs it (`y`, `Y`, Enter decline);
//  - root spawns nothing; non-TTY spawns nothing;
//  - the install argv is the plan's constant argv with stdio 'inherit';
//  - the pull is a separate `yes`; Ctrl-C aborts it via AbortController.
// Everything with a side effect is injectable.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { fetchLocalModels } from '@ethosagent/wiring/local-models';
import {
  type OllamaInstallPlan,
  type OllamaPullProgress,
  type PullOllamaModelOptions,
  pullOllamaModel,
} from '@ethosagent/wiring/ollama';

export const OLLAMA_LOCAL_V1 = 'http://127.0.0.1:11434/v1';
export const POLL_INTERVAL_MS = 2000;
export const POLL_TIMEOUT_MS = 120_000;

export interface OllamaOfferPick {
  modelId: string;
  approxDownloadGb: number;
}

export type OllamaOfferResult =
  /** Nothing was run. `reason` says why; the command/URL was printed. */
  | { status: 'printed-only'; reason: 'non-tty' | 'root' | 'no-command' }
  /** User answered anything but `yes` to the install question. */
  | { status: 'declined' }
  | { status: 'install-failed'; exitCode: number | null }
  /** Install ran (or user downloaded manually) but no server answered in time. */
  | { status: 'server-not-found' }
  /** Server is up; no model pulled (no pick, or the pull question declined). */
  | { status: 'installed'; pullDeclined: boolean }
  | { status: 'pulled'; modelId: string }
  | { status: 'pull-failed'; modelId: string; message: string }
  | { status: 'pull-aborted'; modelId: string };

export interface OllamaOfferDeps {
  plan: OllamaInstallPlan;
  pick?: OllamaOfferPick;
  isTTY: boolean;
  ask: (prompt: string) => Promise<string>;
  print: (line: string) => void;
  spawnImpl?: (
    command: string,
    args: readonly string[],
    options: { stdio: 'inherit' },
  ) => Promise<number | null>;
  pull?: (opts: PullOllamaModelOptions) => Promise<void>;
  probe?: (baseUrl: string) => Promise<{ reachable: boolean }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Register a SIGINT handler; returns an unregister function. */
  onSigint?: (handler: () => void) => () => void;
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { stdio: 'inherit' },
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], options);
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code));
  });
}

function defaultOnSigint(handler: () => void): () => void {
  process.once('SIGINT', handler);
  return () => {
    process.removeListener('SIGINT', handler);
  };
}

function isYes(answer: string): boolean {
  return answer.trim() === 'yes';
}

async function waitForServer(deps: OllamaOfferDeps): Promise<boolean> {
  const probe = deps.probe ?? ((u: string) => fetchLocalModels(u));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const start = now();
  for (;;) {
    if ((await probe(OLLAMA_LOCAL_V1)).reachable) return true;
    if (now() - start >= POLL_TIMEOUT_MS) return false;
    await sleep(POLL_INTERVAL_MS);
  }
}

function progressPrinter(print: (line: string) => void): (p: OllamaPullProgress) => void {
  let last = '';
  return (p) => {
    let line = p.status;
    if (p.total && p.completed !== undefined) {
      const pct = Math.floor(((p.completed / p.total) * 100) / 10) * 10;
      line = `${p.status} ${pct}%`;
    }
    if (line !== last) {
      last = line;
      print(`  ${line}`);
    }
  };
}

async function offerPull(deps: OllamaOfferDeps, pick: OllamaOfferPick): Promise<OllamaOfferResult> {
  const answer = await deps.ask(
    `Download ${pick.modelId} (about ${pick.approxDownloadGb} GB)? Type "yes" to continue: `,
  );
  if (!isYes(answer)) return { status: 'installed', pullDeclined: true };

  const ac = new AbortController();
  const unregister = (deps.onSigint ?? defaultOnSigint)(() => ac.abort());
  try {
    await (deps.pull ?? pullOllamaModel)({
      baseUrl: OLLAMA_LOCAL_V1,
      model: pick.modelId,
      signal: ac.signal,
      onProgress: progressPrinter(deps.print),
    });
    return { status: 'pulled', modelId: pick.modelId };
  } catch (err) {
    if (ac.signal.aborted) return { status: 'pull-aborted', modelId: pick.modelId };
    return {
      status: 'pull-failed',
      modelId: pick.modelId,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    unregister();
  }
}

export async function runOllamaInstallOffer(deps: OllamaOfferDeps): Promise<OllamaOfferResult> {
  const { plan, print } = deps;

  if (plan.command === null || plan.argv === null) {
    // macOS without brew (or an unknown OS): a manual download, no spawn.
    print(plan.notes);
    if (plan.downloadUrl) print(`  ${plan.downloadUrl}`);
    if (!deps.isTTY) return { status: 'printed-only', reason: 'non-tty' };
    if (!(await waitForServer(deps))) return { status: 'server-not-found' };
    return deps.pick ? offerPull(deps, deps.pick) : { status: 'installed', pullDeclined: false };
  }

  print(plan.notes);
  print(`  ${plan.command}`);

  if (!plan.runnable) {
    // Not runnable with a command present means root (D10).
    print('Ethos will not install as root: run this yourself as a normal user.');
    return { status: 'printed-only', reason: 'root' };
  }
  if (!deps.isTTY) return { status: 'printed-only', reason: 'non-tty' };

  const answer = await deps.ask('Run this command now? Type "yes" to continue: ');
  if (!isYes(answer)) return { status: 'declined' };

  const [bin, ...args] = plan.argv;
  if (bin === undefined) return { status: 'printed-only', reason: 'no-command' };
  const exitCode = await (deps.spawnImpl ?? defaultSpawn)(bin, args, { stdio: 'inherit' });
  if (exitCode !== 0) return { status: 'install-failed', exitCode };

  print('Waiting for Ollama to start...');
  if (!(await waitForServer(deps))) return { status: 'server-not-found' };
  return deps.pick ? offerPull(deps, deps.pick) : { status: 'installed', pullDeclined: false };
}
