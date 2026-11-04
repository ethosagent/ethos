import { ollamaInstallPlan } from '@ethosagent/wiring/ollama';
import { describe, expect, it, vi } from 'vitest';
import { type OllamaOfferDeps, runOllamaInstallOffer } from '../lib/ollama-install';

const LINUX_CMD = 'curl -fsSL https://ollama.com/install.sh | sh';
const pick = { modelId: 'llama3.2', approxDownloadGb: 2 };

function harness(over: Partial<OllamaOfferDeps> & { answers?: string[] } = {}) {
  const events: string[] = [];
  const answers = [...(over.answers ?? ['yes', 'yes'])];
  const spawnImpl = vi.fn(async () => 0);
  const deps: OllamaOfferDeps = {
    plan: ollamaInstallPlan('linux', { hasBrew: false, isRoot: false }),
    pick,
    isTTY: true,
    print: (l) => events.push(`print:${l}`),
    ask: async (q) => {
      events.push(`ask:${q}`);
      return answers.shift() ?? '';
    },
    spawnImpl,
    probe: async () => ({ reachable: true }),
    sleep: async () => {},
    pull: async () => {},
    onSigint: () => () => {},
    ...over,
  };
  return { deps, events, spawnImpl };
}

describe('runOllamaInstallOffer', () => {
  it('prints the exact command before asking', async () => {
    const { deps, events } = harness({ answers: ['no'] });
    await runOllamaInstallOffer(deps);
    const printIdx = events.findIndex((e) => e.includes(LINUX_CMD));
    const askIdx = events.findIndex((e) => e.startsWith('ask:'));
    expect(printIdx).toBeGreaterThanOrEqual(0);
    expect(printIdx).toBeLessThan(askIdx);
  });

  it("only the literal 'yes' runs it", async () => {
    for (const [answer, runs] of [
      ['y', false],
      ['Y', false],
      ['', false],
      ['YES', false],
      ['yes ', true],
      ['yes', true],
    ] as const) {
      const { deps, spawnImpl } = harness({ answers: [answer, 'no'] });
      await runOllamaInstallOffer(deps);
      expect(spawnImpl).toHaveBeenCalledTimes(runs ? 1 : 0);
    }
  });

  it('as root nothing is spawned', async () => {
    const { deps, events, spawnImpl } = harness({
      plan: ollamaInstallPlan('linux', { hasBrew: false, isRoot: true }),
    });
    const res = await runOllamaInstallOffer(deps);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(res).toEqual({ status: 'printed-only', reason: 'root' });
    expect(events.some((e) => e.includes('run this yourself as a normal user'))).toBe(true);
    expect(events.some((e) => e.startsWith('ask:'))).toBe(false);
  });

  it('non-TTY prints the command and spawns nothing', async () => {
    const { deps, events, spawnImpl } = harness({ isTTY: false });
    const res = await runOllamaInstallOffer(deps);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(res).toEqual({ status: 'printed-only', reason: 'non-tty' });
    expect(events.some((e) => e.includes(LINUX_CMD))).toBe(true);
  });

  it('Linux spawns sh -c with the constant string and stdio inherit', async () => {
    const { deps, spawnImpl } = harness({ answers: ['yes', 'no'] });
    await runOllamaInstallOffer(deps);
    expect(spawnImpl).toHaveBeenCalledWith('sh', ['-c', LINUX_CMD], { stdio: 'inherit' });
  });

  it('no accept-agreements flag in any argv', () => {
    const banned = /accept|^-y$|--yes|--force/i;
    for (const platform of ['linux', 'darwin', 'win32', 'freebsd']) {
      for (const hasBrew of [true, false]) {
        const plan = ollamaInstallPlan(platform, { hasBrew, isRoot: false });
        for (const a of plan.argv ?? []) expect(a).not.toMatch(banned);
        expect(plan.command ?? '').not.toMatch(/accept-|\s-y(\s|$)/);
      }
    }
  });

  it('pull asks separately', async () => {
    const pull = vi.fn(async () => {});
    const { deps, spawnImpl, events } = harness({ answers: ['yes', 'no'], pull });
    const res = await runOllamaInstallOffer(deps);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
    expect(res).toEqual({ status: 'installed', pullDeclined: true });
    expect(events.filter((e) => e.startsWith('ask:'))).toHaveLength(2);
    expect(events.at(-1)).not.toContain('pulling');
  });

  it('pulls on a second yes and Ctrl-C aborts the pull', async () => {
    let fire: () => void = () => {};
    const pull = vi.fn(
      (o: { signal?: AbortSignal }) =>
        new Promise<void>((_, reject) => {
          o.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          fire();
        }),
    );
    const { deps } = harness({
      pull,
      onSigint: (h) => {
        fire = h;
        return () => {};
      },
    });
    const res = await runOllamaInstallOffer(deps);
    expect(res).toEqual({ status: 'pull-aborted', modelId: 'llama3.2' });
  });

  it('macOS without brew prints the download url and spawns nothing', async () => {
    const { deps, events, spawnImpl } = harness({
      plan: ollamaInstallPlan('darwin', { hasBrew: false, isRoot: false }),
      answers: ['no'],
    });
    await runOllamaInstallOffer(deps);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(events.some((e) => e.includes('https://ollama.com/download/mac'))).toBe(true);
  });

  it('polls every 2s and gives up after 120s', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const { deps } = harness({
      answers: ['yes'],
      probe: async () => ({ reachable: false }),
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    const res = await runOllamaInstallOffer(deps);
    expect(res).toEqual({ status: 'server-not-found' });
    expect(new Set(sleeps)).toEqual(new Set([2000]));
    expect(sleeps.length).toBe(60);
  });
});
