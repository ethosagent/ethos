import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BatchRunner, parseTasksJsonl } from '@ethosagent/batch-runner';
import { EvalRunner } from '@ethosagent/eval-harness';
import { FsStorage } from '@ethosagent/storage-fs';
import { EthosError } from '@ethosagent/types';
// Lab service — owns the lifecycle of background batch + eval runs.
//
// State is in-memory: a Map<runId, RunState>. On server restart any
// in-flight runs are lost (the on-disk Atropos JSONL + checkpoint
// remain — re-running with the same id resumes via the runner's
// existing checkpoint mechanism, which is what the plan calls
// "cancel-mid-run leaves a checkpoint that resumes correctly").
//
// File layout under <dataDir>:
//   batch/
//     <runId>.jsonl              — Atropos output written by BatchRunner
//     <runId>.checkpoint.json    — checkpoint for resume
//     tasks/<runId>.jsonl        — caller's tasks file (kept for re-run)
//   eval/
//     <runId>.jsonl              — output (one row per task w/ score)
//     tasks/<runId>.jsonl
//     expected/<runId>.jsonl
const RUN_HISTORY_CAP = 50;
export class LabService {
    opts;
    batchRuns = new Map();
    evalRuns = new Map();
    storage;
    constructor(opts) {
        this.opts = opts;
        this.storage = opts.storage ?? new FsStorage();
    }
    // ---------------------------------------------------------------------------
    // Batch
    // ---------------------------------------------------------------------------
    async batchList() {
        const runs = [...this.batchRuns.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
        return { runs: runs.slice(0, RUN_HISTORY_CAP) };
    }
    batchGet(id) {
        const run = this.batchRuns.get(id);
        if (!run)
            throw notFound('batch', id);
        return { run };
    }
    async batchStart(input) {
        let tasks;
        try {
            tasks = parseTasksJsonl(input.tasksJsonl);
        }
        catch (err) {
            throw new EthosError({
                code: 'BATCH_INVALID_LINE',
                cause: err instanceof Error ? err.message : String(err),
                action: 'Each line must be JSON with `id` (string) and `prompt` (string).',
            });
        }
        if (tasks.length === 0) {
            throw new EthosError({
                code: 'INVALID_INPUT',
                cause: 'tasks file is empty after parsing',
                action: 'Add at least one `{ id, prompt }` line.',
            });
        }
        const runId = freshId();
        const dir = join(this.opts.dataDir, 'batch');
        const tasksDir = join(dir, 'tasks');
        await this.storage.mkdir(tasksDir);
        const tasksPath = join(tasksDir, `${runId}.jsonl`);
        const outputPath = join(dir, `${runId}.jsonl`);
        const checkpointPath = join(dir, `${runId}.checkpoint.json`);
        // Persist the input tasks file for re-runs / debugging.
        await this.storage.write(tasksPath, input.tasksJsonl);
        const startedAt = new Date().toISOString();
        const initial = {
            id: runId,
            status: 'running',
            total: tasks.length,
            completed: 0,
            failed: 0,
            skipped: 0,
            startedAt,
            finishedAt: null,
            outputPath,
            errorMessage: null,
        };
        this.batchRuns.set(runId, initial);
        const runner = new BatchRunner(this.opts.loop, {
            concurrency: input.concurrency ?? 4,
            outputPath,
            checkpointPath,
            defaultPersonalityId: input.defaultPersonalityId ?? '',
        });
        // Fire and forget — the run progresses in the background while
        // `batchList`/`batchGet` polls the in-memory state.
        void this.driveBatchRun(runId, runner, tasks).catch((err) => {
            const state = this.batchRuns.get(runId);
            if (!state)
                return;
            this.batchRuns.set(runId, {
                ...state,
                status: 'failed',
                finishedAt: new Date().toISOString(),
                errorMessage: err instanceof Error ? err.message : String(err),
            });
        });
        return { run: initial };
    }
    async batchOutput(id) {
        const run = this.batchRuns.get(id);
        if (!run)
            throw notFound('batch', id);
        // Run may not have written anything yet — return empty so the UI
        // can still render its download button without a hard error.
        return { content: (await this.storage.read(run.outputPath)) ?? '' };
    }
    // ---------------------------------------------------------------------------
    // Eval
    // ---------------------------------------------------------------------------
    async evalList() {
        const runs = [...this.evalRuns.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
        return { runs: runs.slice(0, RUN_HISTORY_CAP) };
    }
    evalGet(id) {
        const run = this.evalRuns.get(id);
        if (!run)
            throw notFound('eval', id);
        return { run };
    }
    async evalStart(input) {
        let tasks;
        try {
            tasks = parseTasksJsonl(input.tasksJsonl);
        }
        catch (err) {
            throw new EthosError({
                code: 'BATCH_INVALID_LINE',
                cause: err instanceof Error ? err.message : String(err),
                action: 'Each tasks line must be JSON with `id` (string) and `prompt` (string).',
            });
        }
        let expected;
        try {
            expected = parseExpectedJsonlInline(input.expectedJsonl);
        }
        catch (err) {
            throw new EthosError({
                code: 'EVAL_INVALID_LINE',
                cause: err instanceof Error ? err.message : String(err),
                action: 'Each expected line must be JSON with `id` (string) and `expected` (string).',
            });
        }
        if (tasks.length === 0 || expected.size === 0) {
            throw new EthosError({
                code: 'INVALID_INPUT',
                cause: 'tasks or expected file is empty',
                action: 'Provide at least one task and one expected entry.',
            });
        }
        const runId = freshId();
        const dir = join(this.opts.dataDir, 'eval');
        const tasksDir = join(dir, 'tasks');
        const expectedDir = join(dir, 'expected');
        await this.storage.mkdir(tasksDir);
        await this.storage.mkdir(expectedDir);
        const tasksPath = join(tasksDir, `${runId}.jsonl`);
        const expectedPath = join(expectedDir, `${runId}.jsonl`);
        const outputPath = join(dir, `${runId}.jsonl`);
        await this.storage.write(tasksPath, input.tasksJsonl);
        await this.storage.write(expectedPath, input.expectedJsonl);
        const startedAt = new Date().toISOString();
        const scorer = input.scorer ?? 'contains';
        const initial = {
            id: runId,
            status: 'running',
            scorer,
            total: tasks.length,
            passed: 0,
            failed: 0,
            avgScore: 0,
            startedAt,
            finishedAt: null,
            outputPath,
            errorMessage: null,
        };
        this.evalRuns.set(runId, initial);
        const runner = new EvalRunner(this.opts.loop, {
            concurrency: input.concurrency ?? 4,
            outputPath,
            defaultScorer: scorer,
        });
        void this.driveEvalRun(runId, runner, tasks, expected).catch((err) => {
            const state = this.evalRuns.get(runId);
            if (!state)
                return;
            this.evalRuns.set(runId, {
                ...state,
                status: 'failed',
                finishedAt: new Date().toISOString(),
                errorMessage: err instanceof Error ? err.message : String(err),
            });
        });
        return { run: initial };
    }
    async evalOutput(id) {
        const run = this.evalRuns.get(id);
        if (!run)
            throw notFound('eval', id);
        return { content: (await this.storage.read(run.outputPath)) ?? '' };
    }
    // ---------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------
    async driveBatchRun(runId, runner, tasks) {
        const stats = await runner.run(tasks, (done, total) => {
            const state = this.batchRuns.get(runId);
            if (!state)
                return;
            // We don't know the exact split here; the runner's per-task hook
            // increments completed+failed. Mirror the totals from the
            // partial state and trust the final stats object below.
            this.batchRuns.set(runId, {
                ...state,
                total,
                completed: done - state.failed,
            });
        });
        const state = this.batchRuns.get(runId);
        if (!state)
            return;
        this.batchRuns.set(runId, {
            ...state,
            status: stats.failed > 0 && stats.completed === 0 ? 'failed' : 'completed',
            total: stats.total,
            completed: stats.completed,
            failed: stats.failed,
            skipped: stats.skipped,
            finishedAt: new Date().toISOString(),
        });
    }
    async driveEvalRun(runId, runner, tasks, expected) {
        const stats = await runner.run(tasks, expected, (_done, total) => {
            const state = this.evalRuns.get(runId);
            if (!state)
                return;
            this.evalRuns.set(runId, { ...state, total });
        });
        const state = this.evalRuns.get(runId);
        if (!state)
            return;
        this.evalRuns.set(runId, {
            ...state,
            status: 'completed',
            total: stats.total,
            passed: stats.passed,
            failed: stats.failed,
            avgScore: stats.avgScore,
            finishedAt: new Date().toISOString(),
        });
    }
}
// EvalRunner.parseExpectedJsonl is exported but takes a full source
// string; the import is a Map<id, expected> — duplicate the small
// parser here so the service can validate cleanly + return our error
// shape. Behaviour matches the runner-side parser.
function parseExpectedJsonlInline(src) {
    const map = new Map();
    const lines = src
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch (err) {
            throw new Error(`Line ${i + 1}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
        }
        if (typeof obj.id !== 'string' || typeof obj.expected !== 'string') {
            throw new Error(`Line ${i + 1}: must have string fields "id" and "expected"`);
        }
        const entry = {
            id: obj.id,
            expected: obj.expected,
            ...(typeof obj.match === 'string' &&
                (obj.match === 'exact' ||
                    obj.match === 'contains' ||
                    obj.match === 'regex' ||
                    obj.match === 'llm')
                ? { match: obj.match }
                : {}),
        };
        map.set(entry.id, entry);
    }
    return map;
}
function freshId() {
    // Short slug + uuid suffix so file names are sortable + collision-proof.
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${ts}-${randomUUID().slice(0, 8)}`;
}
function notFound(kind, id) {
    return new EthosError({
        code: 'INVALID_INPUT',
        cause: `${kind} run "${id}" not found.`,
        action: `Use ${kind}.list to see recent runs.`,
    });
}
