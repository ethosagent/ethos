import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBatch } from '../batch';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 17 (context-budget-2): `ethos batch --json` prints exactly one JSON document.
// BatchRunner and the agent loop are doubles (a real run needs a live LLM). Per-task results
// live in the --output JSONL file; the document carries the stats and the paths.

const runner = vi.hoisted(() => ({
  stats: { total: 2, completed: 2, failed: 0, skipped: 0 },
  progress: true,
}));

vi.mock('@ethosagent/batch-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ethosagent/batch-runner')>()),
  BatchRunner: class {
    async run(_tasks: unknown, onProgress?: (done: number, total: number) => void) {
      if (runner.progress) onProgress?.(1, 2);
      return runner.stats;
    }
  },
}));
vi.mock('../../wiring', () => ({
  createAgentLoop: async () => ({ loop: {} }),
  getStorage: () => ({}),
}));
vi.mock('../../lib/non-interactive-approval', () => ({ gateNonInteractiveLoop: vi.fn() }));
vi.mock('../../lib/release-command-runtime', () => ({ releaseCommandRuntime: async () => {} }));

const config = { personality: 'muse' } as EthosConfig;

let h: JsonCliHarness;
let tasksPath: string;

beforeEach(async () => {
  h = await setupJsonCli('ethos-batch-json-');
  runner.stats = { total: 2, completed: 2, failed: 0, skipped: 0 };
  tasksPath = join(h.scopeDir, 'tasks.jsonl');
  await writeFile(tasksPath, '{"id":"a","prompt":"hi"}\n{"id":"b","prompt":"yo"}\n');
});

afterEach(async () => {
  await h.teardown();
});

describe('batch --json', () => {
  it('--json success is one JSON doc', async () => {
    await runBatch([tasksPath, '--json'], config);
    const doc = parseOneDoc(h);
    expect(doc).toMatchObject({
      ok: true,
      tasks: 2,
      completed: 2,
      failed: 0,
      skipped: 0,
      concurrency: 3,
      output: tasksPath.replace(/\.jsonl$/, '.output.jsonl'),
      checkpoint: tasksPath.replace(/\.jsonl$/, '.checkpoint.json'),
    });
    expect(h.stderr()).not.toContain('\r');
  });

  it('--json with failed tasks still prints the doc, then exits 1', async () => {
    runner.stats = { total: 2, completed: 1, failed: 1, skipped: 0 };
    await expect(runBatch([tasksPath, '--json'], config)).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h)).toMatchObject({ ok: true, completed: 1, failed: 1 });
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runBatch(['--json'], config)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(h.stdout()).toBe('');
  });

  it('--json unreadable tasks file is one JSON doc', async () => {
    await expect(runBatch([join(h.scopeDir, 'missing.jsonl'), '--json'], config)).rejects.toThrow(
      `${EXIT}(1)`,
    );
    expect(parseOneDoc(h).error?.code).toBe('FILE_NOT_FOUND');
  });

  it('--json invalid tasks file is one JSON doc', async () => {
    await writeFile(tasksPath, 'not json\n');
    await expect(runBatch([tasksPath, '--json'], config)).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('BATCH_INVALID_LINE');
  });
});
