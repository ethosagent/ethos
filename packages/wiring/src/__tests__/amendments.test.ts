// plan personality-memory-boundary-and-self-amendment G2 — the review service
// (`createAmendmentService`, packages/wiring/src/amendments.ts): list, get (live
// recompute), apply, decline, rollback, plus the headline invariant (G2-1: no
// automated path applies an amendment) and hot reload through the real
// composition root.
//
// Real FsStorage, real `.apply.lock`, and the production personality loader
// (`amendmentPersonalityLoader` — a user-dir-aware FilePersonalityRegistry over
// the package's real built-ins) under a temp data dir.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultToolRegistry, InMemorySessionStore } from '@ethosagent/core';
import {
  amendmentAppliedPath,
  amendmentPriorPath,
  amendmentProposalPath,
  createAmendment,
  expectedAfterHash,
  listAmendments,
  opsHash,
  readAmendment,
} from '@ethosagent/learning-inbox';
import { OpenAICompatProvider } from '@ethosagent/llm-openai-compat';
import { noopLogger } from '@ethosagent/logger';
import { runNightlyPass } from '@ethosagent/nightly-loop';
import { hashDefinitionBytes } from '@ethosagent/personalities';
import { FsStorage } from '@ethosagent/storage-fs';
import { PROPOSE_SELF_AMENDMENT_TOOL } from '@ethosagent/tools-personality-design';
import type {
  AmendmentOp,
  AmendmentProvenance,
  AmendmentRecord,
  CompletionChunk,
  ExecutionPosture,
  Tool,
  ToolContext,
} from '@ethosagent/types';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import {
  type AmendmentObservability,
  type AmendmentPersonalities,
  type AmendmentService,
  type AmendmentServiceDeps,
  acquireAmendmentLock,
  amendmentPersonalityLoader,
  createAmendmentIntake,
  createAmendmentService,
} from '../amendments';
import { createAgentLoop, type WiringConfig } from '../index';
import {
  learningPolicyFor,
  pendingReplayCandidateIds,
  promoteLearningCandidate,
} from '../learning-pipeline';

const SCOUT_TOOLSET = `- read_file\n- ${PROPOSE_SELF_AMENDMENT_TOOL}\n`;
const ADD_TERMINAL: AmendmentOp[] = [{ op: 'add_tool', tool: 'terminal' }];
const ADD_WEB_FETCH: AmendmentOp[] = [{ op: 'add_tool', tool: 'web_fetch' }];

let root: string;
let dataDir: string;
let storage: FsStorage;
let tools: DefaultToolRegistry;
let posture: ExecutionPosture['backend'];
let recordSafetyApproval: Mock<AmendmentObservability['recordSafetyApproval']>;
let service: AmendmentService;

function tool(name: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: name,
    schema: { type: 'object' },
    capabilities: {},
    execute: async () => ({ ok: true, value: 'ok' }),
    ...extra,
  };
}

const personalityDir = (id: string) => join(dataDir, 'personalities', id);
const toolsetPath = (id: string) => join(personalityDir(id), 'toolset.yaml');
const toolsetOf = (id: string) => readFileSync(toolsetPath(id), 'utf-8');

function seed(id: string, toolset: string, config = `name: ${id}\n`): void {
  mkdirSync(personalityDir(id), { recursive: true });
  writeFileSync(join(personalityDir(id), 'config.yaml'), config);
  writeFileSync(join(personalityDir(id), 'SOUL.md'), `# ${id}\n`);
  writeFileSync(toolsetPath(id), toolset);
}

function provenance(extra: Partial<AmendmentProvenance> = {}): AmendmentProvenance {
  return {
    sessionId: 's-1',
    sessionKey: 'cli:amend',
    platform: 'cli',
    initiator: 'user',
    roomAudience: 'private',
    executionPosture: 'docker',
    holdsShellTool: false,
    ...extra,
  };
}

/** A pending amendment filed against the personality's live bytes (the intake's own tests cover filing). */
async function file(
  ops: AmendmentOp[] = ADD_TERMINAL,
  personalityId = 'scout',
  opts: { at?: number; provenance?: Partial<AmendmentProvenance>; baseHash?: string } = {},
): Promise<AmendmentRecord> {
  const live = existsSync(toolsetPath(personalityId)) ? toolsetOf(personalityId) : '';
  const created = await createAmendment(
    storage,
    dataDir,
    {
      personalityId,
      ops,
      baseHash: opts.baseHash ?? hashDefinitionBytes(live),
      rationale: 'needed',
      evidence: [],
      provenance: provenance(opts.provenance),
      preCheck: 'ok',
      status: 'pending',
    },
    opts.at === undefined ? Date.now : () => opts.at ?? 0,
  );
  if (created.kind !== 'created') throw new Error(`not created: ${created.kind}`);
  return created.record;
}

function build(extra: Partial<AmendmentServiceDeps> = {}): AmendmentService {
  return createAmendmentService({
    storage,
    dataDir,
    workingDir: root,
    loadPersonalities: amendmentPersonalityLoader({ storage, dataDir }),
    tools,
    executionPostureFor: () => ({ backend: posture }) as ExecutionPosture,
    observability: { recordSafetyApproval },
    log: noopLogger,
    acquireLock: (d) => acquireAmendmentLock(d, 100),
    ...extra,
  });
}

/** The loader, with `writeDefinitionBytes` wrapped — to inject a concurrent edit or a crash. */
function wrappedLoader(
  wrap: (
    real: AmendmentPersonalities['writeDefinitionBytes'],
  ) => AmendmentPersonalities['writeDefinitionBytes'],
): () => Promise<AmendmentPersonalities> {
  const load = amendmentPersonalityLoader({ storage, dataDir });
  return async () => {
    const registry = await load();
    const real = registry.writeDefinitionBytes.bind(registry);
    return { describe: (id) => registry.describe(id), writeDefinitionBytes: wrap(real) };
  };
}

async function approve(id: string, svc: AmendmentService = service) {
  const review = await svc.get(id);
  if (!review?.expectedAfterHash) throw new Error(`nothing to apply for ${id}`);
  return svc.apply(id, {
    actor: 'cli',
    decidedBy: 'owner',
    expectedAfterHash: review.expectedAfterHash,
  });
}

const statusOf = async (id: string) => (await readAmendment(storage, dataDir, id))?.status;
const codes = () => recordSafetyApproval.mock.calls.map(([row]) => row.code);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ethos-amendments-'));
  dataDir = join(root, '.ethos');
  seed('scout', SCOUT_TOOLSET);
  seed('closer', `- kanban_complete\n- ${PROPOSE_SELF_AMENDMENT_TOOL}\n`);
  seed('victim', '- read_file\n');
  storage = new FsStorage();
  tools = new DefaultToolRegistry();
  for (const name of ['read_file', 'terminal', 'web_fetch', 'kanban_complete']) {
    tools.register(tool(name));
  }
  tools.register(tool('offline_tool', { isAvailable: () => false }));
  posture = 'docker';
  recordSafetyApproval = vi.fn();
  service = build();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// --- surface -----------------------------------------------------------------

describe('AmendmentService — surface', () => {
  it('has no filing path: list, get, apply, decline, rollback only', () => {
    expect(Object.keys(service).sort()).toEqual(['apply', 'decline', 'get', 'list', 'rollback']);
  });

  it('lists newest first and filters by status', async () => {
    const older = await file(ADD_TERMINAL, 'scout', { at: 1_000 });
    const newer = await file(ADD_WEB_FETCH, 'scout', { at: 2_000 });
    expect((await service.list()).map((r) => r.id)).toEqual([newer.id, older.id]);
    await service.decline(older.id, { actor: 'cli', decidedBy: 'owner', reason: 'no' });
    expect((await service.list({ status: 'pending' })).map((r) => r.id)).toEqual([newer.id]);
  });

  it('get answers null, apply/decline/rollback answer not_found, for an unknown id', async () => {
    expect(await service.get('a-none-000000')).toBeNull();
    const by = { actor: 'cli' as const, decidedBy: 'owner' };
    expect(await service.apply('a-none-000000', { ...by, expectedAfterHash: 'x' })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(await service.decline('a-none-000000', { ...by, reason: 'r' })).toMatchObject({
      code: 'not_found',
    });
    expect(await service.rollback('a-none-000000', by)).toMatchObject({ code: 'not_found' });
  });
});

// --- get ----------------------------------------------------------------------

describe('AmendmentService.get — recomputed from live state', () => {
  it('shows the after-bytes, the hash apply needs, the text and permission diffs, and flags', async () => {
    const record = await file();
    const review = await service.get(record.id);
    const after = `- read_file\n- ${PROPOSE_SELF_AMENDMENT_TOOL}\n- terminal\n`;
    expect(review).toMatchObject({
      personality: 'ok',
      liveBytes: SCOUT_TOOLSET,
      liveHash: record.baseHash,
      stale: false,
      interruptedApply: false,
      afterBytes: after,
      expectedAfterHash: expectedAfterHash(record.baseHash, opsHash(record.ops), after),
      textDiff: [' - read_file', ` - ${PROPOSE_SELF_AMENDMENT_TOOL}`, '+- terminal'],
    });
    expect(review?.permissionDiff?.changes).toEqual([
      expect.objectContaining({ field: 'toolset', detail: '+ terminal', flag: 'high-risk' }),
    ]);
    expect(review?.notCompared).toMatch(/^Not compared: .*mcp\.yaml/);
    expect(review?.flags.sort()).toEqual(['high-risk', 'no-recorded-refusal']);
  });

  it('flags local-terminal from the live posture, and from the recorded provenance alone', async () => {
    const record = await file();
    posture = 'local';
    expect((await service.get(record.id))?.flags).toContain('local-terminal');

    posture = 'docker';
    const recorded = await file(ADD_WEB_FETCH, 'scout', {
      provenance: { executionPosture: 'local', holdsShellTool: true },
    });
    expect((await service.get(recorded.id))?.flags).toContain('local-terminal');
    const neither = await file([{ op: 'remove_tool', tool: 'read_file' }]);
    expect((await service.get(neither.id))?.flags).not.toContain('local-terminal');
  });

  it('flags tool-unavailable and team-workflow', async () => {
    const offline = await file([{ op: 'add_tool', tool: 'offline_tool' }]);
    expect((await service.get(offline.id))?.flags).toContain('tool-unavailable');
    const closer = await file([{ op: 'remove_tool', tool: 'kanban_complete' }], 'closer');
    expect((await service.get(closer.id))?.flags).toContain('team-workflow');
  });

  it('reports a hand-edited toolset as stale and a vanished tool as an ops problem', async () => {
    const record = await file();
    writeFileSync(toolsetPath('scout'), `${SCOUT_TOOLSET}- web_fetch\n`);
    expect(await service.get(record.id)).toMatchObject({ stale: true });

    writeFileSync(toolsetPath('scout'), SCOUT_TOOLSET);
    tools.unregister('terminal');
    expect(await service.get(record.id)).toMatchObject({
      afterBytes: null,
      expectedAfterHash: null,
      opsProblem: expect.stringContaining('terminal'),
    });
  });
});

// --- apply --------------------------------------------------------------------

describe('AmendmentService.apply', () => {
  it('writes exactly the reviewed bytes, snapshots the prior bytes, and records the decision', async () => {
    const record = await file();
    const before = readdirSync(personalityDir('scout')).sort();
    const config = readFileSync(join(personalityDir('scout'), 'config.yaml'), 'utf-8');
    const review = await service.get(record.id);

    const result = await approve(record.id);

    expect(result).toMatchObject({ ok: true, record: { status: 'applied' } });
    expect(toolsetOf('scout')).toBe(review?.afterBytes);
    expect(result.ok && result.record.applied?.appliedHash).toBe(
      hashDefinitionBytes(review?.afterBytes ?? ''),
    );
    expect(result.ok && result.record.history.at(-1)).toMatchObject({
      action: 'approve',
      actor: 'cli',
      decidedBy: 'owner',
    });
    expect(readFileSync(amendmentPriorPath(dataDir, record.id), 'utf-8')).toBe(SCOUT_TOOLSET);
    expect(
      JSON.parse(readFileSync(amendmentAppliedPath(dataDir, record.id), 'utf-8')),
    ).toMatchObject({ amendmentId: record.id, priorHash: record.baseHash });
    // Only toolset.yaml changed.
    expect(readdirSync(personalityDir('scout')).sort()).toEqual(before);
    expect(readFileSync(join(personalityDir('scout'), 'config.yaml'), 'utf-8')).toBe(config);
    expect(toolsetOf('victim')).toBe('- read_file\n');
    expect(recordSafetyApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'approved', code: 'amendment.approve' }),
    );
  });

  it('refuses an expectedAfterHash other than the reviewed one, writing nothing', async () => {
    const record = await file();
    const result = await service.apply(record.id, {
      actor: 'cli',
      decidedBy: 'owner',
      expectedAfterHash: 'f'.repeat(64),
    });
    expect(result).toMatchObject({ ok: false, code: 'hash_mismatch' });
    expect(await statusOf(record.id)).toBe('pending');
    expect(toolsetOf('scout')).toBe(SCOUT_TOOLSET);
    expect(existsSync(amendmentPriorPath(dataDir, record.id))).toBe(false);
    expect(recordSafetyApproval).not.toHaveBeenCalled();
  });

  it('goes stale when toolset.yaml changed since filing', async () => {
    const record = await file();
    const hash = (await service.get(record.id))?.expectedAfterHash ?? '';
    const edited = `${SCOUT_TOOLSET}- web_fetch\n`;
    writeFileSync(toolsetPath('scout'), edited);

    const result = await service.apply(record.id, {
      actor: 'cli',
      decidedBy: 'owner',
      expectedAfterHash: hash,
    });
    expect(result).toMatchObject({ ok: false, code: 'stale', record: { status: 'stale' } });
    expect(result.ok ? null : result.record?.history.at(-1)).toMatchObject({ action: 'stale' });
    expect(toolsetOf('scout')).toBe(edited);
  });

  it('goes stale when an op no longer names a registered tool', async () => {
    const record = await file();
    const hash = (await service.get(record.id))?.expectedAfterHash ?? '';
    tools.unregister('terminal');
    const result = await service.apply(record.id, {
      actor: 'cli',
      decidedBy: 'owner',
      expectedAfterHash: hash,
    });
    expect(result).toMatchObject({ ok: false, code: 'stale' });
    expect(toolsetOf('scout')).toBe(SCOUT_TOOLSET);
  });

  it('goes stale when an edit lands between the check and the write (compare-and-swap)', async () => {
    const record = await file();
    const concurrent = `${SCOUT_TOOLSET}- web_fetch\n`;
    const racing = build({
      loadPersonalities: wrappedLoader((real) => async (id, f, bytes, o) => {
        writeFileSync(toolsetPath('scout'), concurrent);
        return real(id, f, bytes, o);
      }),
    });
    const result = await approve(record.id, racing);
    expect(result).toMatchObject({ ok: false, code: 'stale' });
    expect(toolsetOf('scout')).toBe(concurrent);
  });

  it('auto-rejects when the constitution was tightened after filing, with an audit row', async () => {
    const record = await file();
    const hash = (await service.get(record.id))?.expectedAfterHash ?? '';
    writeFileSync(join(dataDir, 'constitution.yaml'), 'forbidden:\n  tools:\n    - terminal\n');

    const result = await service.apply(record.id, {
      actor: 'cli',
      decidedBy: 'owner',
      expectedAfterHash: hash,
    });
    expect(result).toMatchObject({ ok: false, code: 'auto_rejected' });
    expect(await statusOf(record.id)).toBe('auto_rejected');
    expect(toolsetOf('scout')).toBe(SCOUT_TOOLSET);
    expect(recordSafetyApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'denied', code: 'amendment.auto_reject' }),
    );
  });

  it('refuses under a malformed constitution and leaves the record pending', async () => {
    const record = await file();
    const hash = (await service.get(record.id))?.expectedAfterHash ?? '';
    writeFileSync(join(dataDir, 'constitution.yaml'), 'forbidden: [unclosed\n');
    const result = await service.apply(record.id, {
      actor: 'cli',
      decidedBy: 'owner',
      expectedAfterHash: hash,
    });
    expect(result).toMatchObject({ ok: false, code: 'constitution_malformed' });
    expect(await statusOf(record.id)).toBe('pending');
    expect(toolsetOf('scout')).toBe(SCOUT_TOOLSET);
  });

  it('refuses a non-pending amendment', async () => {
    const record = await file();
    await approve(record.id);
    expect(
      await service.apply(record.id, { actor: 'cli', decidedBy: 'o', expectedAfterHash: 'x' }),
    ).toMatchObject({ ok: false, code: 'not_pending' });
  });

  it('refuses a built-in personality; the same loader lets a user personality be written', async () => {
    const loaded = await amendmentPersonalityLoader({ storage, dataDir })();
    expect(loaded.describe('researcher')?.builtin).toBe(true);
    expect(loaded.describe('scout')?.builtin).toBe(false);

    const record = await file(ADD_TERMINAL, 'researcher', { baseHash: 'b'.repeat(64) });
    expect(await service.get(record.id)).toMatchObject({ personality: 'builtin' });
    expect(
      await service.apply(record.id, { actor: 'cli', decidedBy: 'o', expectedAfterHash: 'x' }),
    ).toMatchObject({ ok: false, code: 'builtin' });
    expect(await statusOf(record.id)).toBe('pending');

    expect(await approve((await file()).id)).toMatchObject({ ok: true });
  });

  it('refuses a personality that no longer exists, never retargeting', async () => {
    const record = await file();
    rmSync(personalityDir('scout'), { recursive: true, force: true });
    expect(
      await service.apply(record.id, { actor: 'cli', decidedBy: 'o', expectedAfterHash: 'x' }),
    ).toMatchObject({ ok: false, code: 'personality_not_found' });
  });
});

// --- lock ---------------------------------------------------------------------

describe('the .apply.lock is shared by filing, apply and decline', () => {
  it('a held lock refuses apply, decline and filing, and nothing changes', async () => {
    const record = await file();
    const hash = (await service.get(record.id))?.expectedAfterHash ?? '';
    const sessions = new InMemorySessionStore();
    const intake = createAmendmentIntake({
      storage,
      dataDir,
      workingDir: root,
      personalities: await amendmentPersonalityLoader({ storage, dataDir })().then((r) => ({
        get: (id: string) => r.describe(id)?.config,
      })),
      tools,
      sessions,
      log: noopLogger,
      acquireLock: (d) => acquireAmendmentLock(d, 100),
    });
    const ctx = {
      sessionId: 'no-such-session',
      sessionKey: 'cli:amend',
      platform: 'cli',
      personalityId: 'scout',
      initiator: 'user',
      roomAudience: 'private',
      workingDir: root,
      currentTurn: 1,
      messageCount: 1,
      abortSignal: new AbortController().signal,
      emit: () => {},
      resultBudgetChars: 80_000,
    } as ToolContext;

    const release = await acquireAmendmentLock(dataDir);
    try {
      expect(
        await service.apply(record.id, { actor: 'cli', decidedBy: 'o', expectedAfterHash: hash }),
      ).toMatchObject({ ok: false, code: 'locked' });
      expect(
        await service.decline(record.id, { actor: 'cli', decidedBy: 'o', reason: 'no' }),
      ).toMatchObject({ ok: false, code: 'locked' });
      expect(await intake.submit({ ops: ADD_WEB_FETCH, rationale: 'r' }, ctx)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('.apply.lock'),
      });
    } finally {
      release();
    }
    expect(await statusOf(record.id)).toBe('pending');
    expect(toolsetOf('scout')).toBe(SCOUT_TOOLSET);
    expect(await listAmendments(storage, dataDir)).toHaveLength(1);
  });
});

// --- crash points -----------------------------------------------------------------

describe('crash safety (the promote.ts snapshot order)', () => {
  it('a crash after the snapshot and before the live write leaves it pending; a retry applies', async () => {
    const record = await file();
    const crashing = build({
      loadPersonalities: wrappedLoader(() => async () => {
        throw new Error('crash before the write');
      }),
    });
    await expect(approve(record.id, crashing)).rejects.toThrow('crash before the write');
    expect(await statusOf(record.id)).toBe('pending');
    expect(existsSync(amendmentPriorPath(dataDir, record.id))).toBe(true);
    expect(existsSync(amendmentAppliedPath(dataDir, record.id))).toBe(true);
    expect(toolsetOf('scout')).toBe(SCOUT_TOOLSET);

    expect(await approve(record.id)).toMatchObject({ ok: true, record: { status: 'applied' } });
  });

  it('a crash after the live write and before the status update is shown, goes stale, and is closed by decline', async () => {
    const record = await file();
    const crashing = build({
      loadPersonalities: wrappedLoader((real) => async (...args) => {
        await real(...args);
        throw new Error('crash after the write');
      }),
    });
    const review = await service.get(record.id);
    await expect(approve(record.id, crashing)).rejects.toThrow('crash after the write');
    expect(await statusOf(record.id)).toBe('pending');
    expect(toolsetOf('scout')).toBe(review?.afterBytes);

    expect(await service.get(record.id)).toMatchObject({ stale: true, interruptedApply: true });
    const retry = await service.apply(record.id, {
      actor: 'cli',
      decidedBy: 'owner',
      expectedAfterHash: review?.expectedAfterHash ?? '',
    });
    expect(retry).toMatchObject({
      ok: false,
      code: 'stale',
      reason: expect.stringMatching(/decline/),
    });
    expect(
      await service.decline(record.id, {
        actor: 'cli',
        decidedBy: 'owner',
        reason: 'already live',
      }),
    ).toMatchObject({ ok: true, record: { status: 'declined' } });
    expect(toolsetOf('scout')).toBe(review?.afterBytes);
  });
});

// --- decline --------------------------------------------------------------------

describe('AmendmentService.decline', () => {
  it('needs a reason, records the decision and the audit row, and is final', async () => {
    const record = await file();
    expect(
      await service.decline(record.id, { actor: 'cli', decidedBy: 'owner', reason: '  ' }),
    ).toMatchObject({ ok: false, code: 'reason_required' });

    const result = await service.decline(record.id, {
      actor: 'cli',
      decidedBy: 'owner',
      reason: 'not now',
    });
    expect(result).toMatchObject({ ok: true, record: { status: 'declined' } });
    expect(result.ok && result.record.history.at(-1)).toMatchObject({
      action: 'decline',
      decidedBy: 'owner',
      reason: 'not now',
    });
    expect(codes()).toEqual(['amendment.decline']);
    expect(
      await service.apply(record.id, { actor: 'cli', decidedBy: 'o', expectedAfterHash: 'x' }),
    ).toMatchObject({ code: 'not_pending' });
    expect(toolsetOf('scout')).toBe(SCOUT_TOOLSET);
  });
});

// --- rollback -------------------------------------------------------------------

describe('AmendmentService.rollback', () => {
  it('restores the prior bytes exactly and records the decision', async () => {
    const record = await file();
    await approve(record.id);
    const result = await service.rollback(record.id, { actor: 'cli', decidedBy: 'owner' });
    expect(result).toMatchObject({ ok: true, record: { status: 'rolled_back' } });
    expect(toolsetOf('scout')).toBe(SCOUT_TOOLSET);
    expect(codes()).toEqual(['amendment.approve', 'amendment.rollback']);
  });

  it('refuses a pending amendment', async () => {
    const record = await file();
    expect(await service.rollback(record.id, { actor: 'cli', decidedBy: 'o' })).toMatchObject({
      code: 'not_applied',
    });
  });

  it('refuses live_edited when toolset.yaml changed after apply, writing nothing', async () => {
    const record = await file();
    await approve(record.id);
    const edited = `${toolsetOf('scout')}- web_fetch\n`;
    writeFileSync(toolsetPath('scout'), edited);
    expect(await service.rollback(record.id, { actor: 'cli', decidedBy: 'o' })).toMatchObject({
      ok: false,
      code: 'live_edited',
    });
    expect(toolsetOf('scout')).toBe(edited);
    expect(await statusOf(record.id)).toBe('applied');
  });

  it('stacked applies unwind LIFO: the older one refuses until the newer is rolled back', async () => {
    const a = await file(ADD_TERMINAL);
    await approve(a.id);
    const b = await file(ADD_WEB_FETCH);
    await approve(b.id);

    expect(await service.rollback(a.id, { actor: 'cli', decidedBy: 'o' })).toMatchObject({
      code: 'live_edited',
    });
    expect(await service.rollback(b.id, { actor: 'cli', decidedBy: 'o' })).toMatchObject({
      ok: true,
    });
    expect(await service.rollback(a.id, { actor: 'cli', decidedBy: 'o' })).toMatchObject({
      ok: true,
    });
    expect(toolsetOf('scout')).toBe(SCOUT_TOOLSET);
  });

  it('refuses when the constitution forbids the restored toolset, or is malformed', async () => {
    const record = await file();
    await approve(record.id);
    const applied = toolsetOf('scout');

    writeFileSync(join(dataDir, 'constitution.yaml'), 'forbidden:\n  tools:\n    - read_file\n');
    // The after-state holds read_file too, but only the RESTORED state is checked here.
    expect(await service.rollback(record.id, { actor: 'cli', decidedBy: 'o' })).toMatchObject({
      ok: false,
      code: 'constitution_violation',
    });
    writeFileSync(join(dataDir, 'constitution.yaml'), 'forbidden: [unclosed\n');
    expect(await service.rollback(record.id, { actor: 'cli', decidedBy: 'o' })).toMatchObject({
      ok: false,
      code: 'constitution_malformed',
    });
    expect(toolsetOf('scout')).toBe(applied);
    expect(await statusOf(record.id)).toBe('applied');
  });

  it('ignores a forged destination in the record: writes are recomputed from the personality id', async () => {
    const record = await file();
    const path = amendmentProposalPath(dataDir, record.id);
    const forged = {
      ...JSON.parse(readFileSync(path, 'utf-8')),
      destination: toolsetPath('victim'),
      toolsetPath: toolsetPath('victim'),
      priorPath: toolsetPath('victim'),
    };
    writeFileSync(path, JSON.stringify(forged));

    expect(await approve(record.id)).toMatchObject({ ok: true });
    expect(await service.rollback(record.id, { actor: 'cli', decidedBy: 'o' })).toMatchObject({
      ok: true,
    });
    expect(toolsetOf('scout')).toBe(SCOUT_TOOLSET);
    expect(toolsetOf('victim')).toBe('- read_file\n');
  });
});

// --- G2-1 headline invariant ------------------------------------------------------

describe('G2-1: a pending amendment is never applied by any automated path', () => {
  it('survives a nightly pass, the replay listing and an auto promote with every auto knob on', async () => {
    seed(
      'scout',
      SCOUT_TOOLSET,
      'name: scout\nevolution_approval_mode: auto\nskill_evolution.promotion: auto\nskill_evolution.scope: personality\n',
    );
    writeFileSync(join(dataDir, 'evolve-config.json'), JSON.stringify({ autoApprove: true }));
    const record = await file();
    const proposal = readFileSync(amendmentProposalPath(dataDir, record.id), 'utf-8');

    const loaded = await amendmentPersonalityLoader({ storage, dataDir })();
    const personalities = { get: (id: string) => loaded.describe(id)?.config };
    const ctx = { storage, dataDir, personalities };
    // The knobs really are all on for this personality.
    const policy = await learningPolicyFor(ctx)({ personalityId: 'scout' } as never);
    expect(policy.knobs).toEqual({
      promotion: 'auto',
      approvalMode: 'auto',
      globalAutoApprove: true,
    });

    const replayed: string[] = [];
    const result = await runNightlyPass(
      'scout',
      {
        readLivingSoul: async () => ({ core: 'c', expression: 'e' }),
        gatherEvidence: async () => ({
          recentPrompts: [{ id: 'p1', prompt: 'hello' }],
          evidenceDigest: 'user: hi',
          windowStart: '2026-09-27T00:00:00.000Z',
          windowEnd: '2026-09-28T00:00:00.000Z',
          elapsedHours: 24,
        }),
        scoreAlignment: async () => {
          throw new Error('judge gated off');
        },
        readJudgeStreak: async () => 0,
        writeJudgeStreak: async () => {},
        draftExpression: async () => ({ newExpression: 'e2', rationale: 'r' }),
        submitExpression: async () => ({ candidateId: 'c-1' }),
        learning: {
          enabled: true,
          budget: { take: () => true },
          freezeCases: async () => ({ frozen: 0, pinned: 0, overflow: 0 }),
          pendingReplay: (id) => pendingReplayCandidateIds(ctx, id),
          replay: async (_id, candidateId) => {
            replayed.push(candidateId);
            return { verdict: 'pass', promoted: true };
          },
        },
        readMemory: async () => ({ memory: '', user: '' }),
        consolidate: async () => ({ memory: '', user: '' }),
        applyMemoryUpdates: async () => {},
        readState: async () => null,
        writeState: async () => {},
      },
      { judge: false, expression: false },
    );
    expect(result.steps.length).toBeGreaterThan(0);
    expect(replayed).toEqual([]);

    const unused = async (): Promise<never> => {
      throw new Error('unused');
    };
    expect(
      await promoteLearningCandidate(
        {
          ...ctx,
          expressions: { evolveExpression: unused, revertExpression: unused },
          observability: { recordSafetyApproval: () => {} },
        },
        record.id,
        { actor: 'auto' },
      ),
    ).toMatchObject({ ok: false, code: 'not_found' });

    expect(readFileSync(amendmentProposalPath(dataDir, record.id), 'utf-8')).toBe(proposal);
    expect(toolsetOf('scout')).toBe(SCOUT_TOOLSET);
    expect(existsSync(amendmentAppliedPath(dataDir, record.id))).toBe(false);
  });
});

// --- hot reload through the composition root -------------------------------------

describe('hot reload: after apply the next turn of that personality sees the new tool', () => {
  const OPTED = 'amender';
  let home: string;
  let loopDataDir: string;
  let runtime: Awaited<ReturnType<typeof createAgentLoop>>;
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'ethos-amendments-loop-'));
    loopDataDir = join(home, '.ethos');
    const dir = join(loopDataDir, 'personalities', OPTED);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.yaml'), `name: ${OPTED}\n`);
    writeFileSync(join(dir, 'SOUL.md'), '# Core\nI amend.\n');
    writeFileSync(join(dir, 'toolset.yaml'), `- read_file\n- ${PROPOSE_SELF_AMENDMENT_TOOL}\n`);
    for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = loopDataDir;
    const config: WiringConfig = {
      provider: 'ollama',
      model: 'offline-test',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'sk-dummy',
      personality: OPTED,
      memory: 'markdown',
    };
    runtime = await createAgentLoop(config, {
      dataDir: loopDataDir,
      workingDir: home,
      disableDocker: true,
      profile: 'cli',
    });
  }, 120_000);

  afterAll(async () => {
    await runtime?.dispose();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function toolsSeenOnATurn(): Promise<string[]> {
    const seen: string[][] = [];
    vi.spyOn(OpenAICompatProvider.prototype, 'complete').mockImplementation((_messages, defs) => {
      seen.push(defs.map((d) => d.name));
      return (async function* (): AsyncGenerator<CompletionChunk> {
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', finishReason: 'end_turn' };
      })();
    });
    await runtime.refreshPersonalities();
    for await (const _ of runtime.loop.run('hi', {
      personalityId: OPTED,
      sessionKey: `cli:${OPTED}-${Math.random()}`,
    })) {
      // drain to exhaustion
    }
    vi.restoreAllMocks();
    return seen[0] ?? [];
  }

  it('files through the wired tool, applies through the returned service, and the next turn has the tool', async () => {
    expect(await toolsSeenOnATurn()).not.toContain('web_search');

    const tool = runtime.toolRegistry.get(PROPOSE_SELF_AMENDMENT_TOOL);
    const ctx = {
      sessionId: 'no-such-session',
      sessionKey: 'cli:amendments-loop',
      platform: 'cli',
      personalityId: OPTED,
      initiator: 'user',
      roomAudience: 'private',
      workingDir: home,
      currentTurn: 1,
      messageCount: 1,
      abortSignal: new AbortController().signal,
      emit: () => {},
      resultBudgetChars: 80_000,
    } as ToolContext;
    await tool?.execute(
      { ops: [{ op: 'add_tool', tool: 'web_search' }], rationale: 'searches were refused' },
      ctx,
    );
    const [record] = await runtime.amendments.list({ status: 'pending' });
    if (!record) throw new Error('nothing filed');
    const review = await runtime.amendments.get(record.id);
    expect(review?.personality).toBe('ok');
    const applied = await runtime.amendments.apply(record.id, {
      actor: 'cli',
      decidedBy: 'owner',
      expectedAfterHash: review?.expectedAfterHash ?? '',
    });
    expect(applied).toMatchObject({ ok: true });

    expect(await toolsSeenOnATurn()).toContain('web_search');
  });
});
