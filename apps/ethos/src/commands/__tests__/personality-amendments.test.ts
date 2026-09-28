// plan personality-memory-boundary-and-self-amendment G2 (D31, D32) —
// `ethos personality amendments`. The command is the v1 apply surface: what is
// pinned here is its gate (TTY, typed confirmation, the ETHOS_TOOL_PROCESS
// tripwire) and that `apply` hands the service the hash of the review it
// printed. The decisions themselves run through a REAL `createAmendmentService`
// over a temp data dir (FsStorage, the real `.apply.lock`, the production
// personality loader), so a happy path here writes real bytes.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultToolRegistry } from '@ethosagent/core';
import { createAmendment, readAmendment } from '@ethosagent/learning-inbox';
import { noopLogger } from '@ethosagent/logger';
import { hashDefinitionBytes } from '@ethosagent/personalities';
import { FsStorage } from '@ethosagent/storage-fs';
import {
  type AmendmentOp,
  type AmendmentProvenance,
  type AmendmentRecord,
  EthosError,
  type ExecutionPosture,
  type Tool,
} from '@ethosagent/types';
import {
  type AmendmentService,
  acquireAmendmentLock,
  amendmentPersonalityLoader,
  createAmendmentService,
} from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AmendmentsCliDeps,
  clean,
  cleanLine,
  runPersonalityAmendmentsCommand,
} from '../personality-amendments';

const TOOLSET = '- read_file\n- propose_self_amendment\n';
const ADD_TERMINAL: AmendmentOp[] = [{ op: 'add_tool', tool: 'terminal' }];

let root: string;
let dataDir: string;
let storage: FsStorage;
let posture: ExecutionPosture['backend'];
let service: AmendmentService;
let out: string[];

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const printed = () => out.join('\n').replace(ANSI, '');
const toolsetPath = (id: string) => join(dataDir, 'personalities', id, 'toolset.yaml');
const toolsetOf = (id: string) => readFileSync(toolsetPath(id), 'utf-8');

function tool(name: string): Tool {
  return {
    name,
    description: name,
    schema: { type: 'object' },
    capabilities: {},
    execute: async () => ({ ok: true, value: 'ok' }),
  };
}

function seed(id: string, toolset: string): void {
  const dir = join(dataDir, 'personalities', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), `name: ${id}\n`);
  writeFileSync(join(dir, 'SOUL.md'), `# ${id}\n`);
  writeFileSync(join(dir, 'toolset.yaml'), toolset);
}

async function file(
  ops: AmendmentOp[] = ADD_TERMINAL,
  extra: Partial<AmendmentProvenance> = {},
): Promise<AmendmentRecord> {
  const created = await createAmendment(storage, dataDir, {
    personalityId: 'scout',
    ops,
    baseHash: hashDefinitionBytes(toolsetOf('scout')),
    rationale: 'fetches keep failing',
    evidence: [],
    provenance: {
      sessionId: 's-1',
      sessionKey: 'cli:amend',
      platform: 'cli',
      initiator: 'user',
      roomAudience: 'private',
      executionPosture: 'docker',
      holdsShellTool: false,
      ...extra,
    },
    preCheck: 'ok',
    status: 'pending',
  });
  if (created.kind !== 'created') throw new Error(`not created: ${created.kind}`);
  return created.record;
}

function deps(extra: Partial<AmendmentsCliDeps> = {}): AmendmentsCliDeps {
  return {
    service,
    out: (line) => out.push(line),
    isTty: true,
    env: {},
    ask: async () => 'scout',
    decidedBy: 'cli:tester',
    ...extra,
  };
}

async function refusal(run: Promise<void>): Promise<EthosError> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof EthosError)) throw new Error(`expected an EthosError, got ${String(err)}`);
  return err;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ethos-amend-cli-'));
  dataDir = join(root, '.ethos');
  seed('scout', TOOLSET);
  storage = new FsStorage();
  const tools = new DefaultToolRegistry();
  for (const name of ['read_file', 'terminal', 'web_fetch']) tools.register(tool(name));
  posture = 'docker';
  out = [];
  service = createAmendmentService({
    storage,
    dataDir,
    workingDir: root,
    loadPersonalities: amendmentPersonalityLoader({ storage, dataDir }),
    tools,
    executionPostureFor: () => ({ backend: posture }) as ExecutionPosture,
    log: noopLogger,
    acquireLock: (d) => acquireAmendmentLock(d, 100),
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('list and show', () => {
  it('list shows pending requests, and --json prints the records', async () => {
    const record = await file();
    await runPersonalityAmendmentsCommand(['list'], deps());
    expect(printed()).toContain(record.id);
    expect(printed()).toContain('+ terminal');
    out = [];
    await runPersonalityAmendmentsCommand(['list', '--json'], deps());
    const parsed: unknown = JSON.parse(out.join('\n'));
    expect(Array.isArray(parsed) && parsed.length).toBe(1);
  });

  it('show prints the permission diff with the high-risk flag, the not-compared line and the toolset diff', async () => {
    const record = await file();
    await runPersonalityAmendmentsCommand(['show', record.id], deps());
    const text = printed();
    expect(text).toMatch(/WIDENS\s+Toolset: \+ terminal\s+\[high-risk\]/);
    expect(text).toContain('Not compared:');
    expect(text).toContain('+- terminal');
    expect(text).toContain('no-recorded-refusal');
    expect(text).toContain('filed (intake)');
    expect(text).toContain('Review hash');
    expect(text).not.toContain('not a boundary');
  });

  it('show carries the local-terminal banner for a local shell personality', async () => {
    const record = await file(ADD_TERMINAL, { executionPosture: 'local', holdsShellTool: true });
    await runPersonalityAmendmentsCommand(['show', record.id], deps());
    expect(printed()).toContain(
      'this personality can already edit its own definition — this review is not a boundary for it',
    );
  });

  it('show --json prints the review', async () => {
    const record = await file();
    await runPersonalityAmendmentsCommand(['show', record.id, '--json'], deps());
    const review = JSON.parse(out.join('\n')) as { expectedAfterHash: string | null };
    expect(typeof review.expectedAfterHash).toBe('string');
  });

  it('an unknown id is NOT_FOUND', async () => {
    const err = await refusal(runPersonalityAmendmentsCommand(['show', 'a-nope-1'], deps()));
    expect(err.code).toBe('NOT_FOUND');
  });

  it('personality-written text is stripped of terminal control sequences', () => {
    expect(clean('ok\x1b[2Jgone\nnext')).toBe('ok?[2Jgone\nnext');
  });

  it('every record-derived string is cleaned, not only the rationale (verification round F4)', async () => {
    const osc = '\x1b]0;owned\x07';
    const created = await createAmendment(storage, dataDir, {
      personalityId: 'scout',
      ops: ADD_TERMINAL,
      baseHash: hashDefinitionBytes(toolsetOf('scout')),
      rationale: 'r',
      evidence: [
        {
          sessionId: 's-1',
          toolCallId: `call${osc}`,
          toolName: `terminal${osc}\u202E`,
          messageId: 'm-1',
          excerpt: 'Unknown tool',
        },
      ],
      provenance: {
        sessionId: 's-1',
        sessionKey: `cli:amend${osc}`,
        platform: `cli${osc}`,
        initiator: 'user',
        roomAudience: 'private',
        executionPosture: 'docker',
        holdsShellTool: false,
      },
      preCheck: 'ok',
      status: 'pending',
    });
    if (created.kind !== 'created') throw new Error(`not created: ${created.kind}`);
    await runPersonalityAmendmentsCommand(['show', created.record.id], deps());
    const raw = out.join('\n');
    expect(raw).not.toContain('\x07');
    expect(raw).not.toContain('\x1b]');
    expect(raw).not.toContain('\u202E');
    expect(printed()).toContain('terminal?]0;owned??');
  });

  // verification round G8 — a newline in a one-line field would print a line
  // that reads as the command's own.
  it('single-line fields collapse newlines and tabs too', async () => {
    expect(cleanLine('terminal\n  History\tforged')).toBe('terminal?  History?forged');
    const created = await createAmendment(storage, dataDir, {
      personalityId: 'scout',
      ops: ADD_TERMINAL,
      baseHash: hashDefinitionBytes(toolsetOf('scout')),
      rationale: 'line one\nline two',
      evidence: [
        {
          sessionId: 's-1',
          toolCallId: 'call\n  Review hash  forged',
          toolName: 'terminal\n  Flags        none',
          messageId: 'm-1',
          excerpt: 'Unknown tool',
        },
      ],
      provenance: {
        sessionId: 's-1',
        sessionKey: 'cli:amend\nFiled forged',
        platform: 'cli\nplatform forged',
        initiator: 'user',
        roomAudience: 'private',
        executionPosture: 'docker',
        holdsShellTool: false,
      },
      preCheck: 'ok',
      status: 'pending',
    });
    if (created.kind !== 'created') throw new Error(`not created: ${created.kind}`);
    await runPersonalityAmendmentsCommand(['show', created.record.id], deps());
    const lines = printed().split('\n');
    for (const forged of [
      '  Review hash  forged',
      '  Flags        none',
      'Filed forged',
      'platform forged',
    ]) {
      expect(
        lines.some((l) => l.trimStart().startsWith(forged.trimStart())),
        forged,
      ).toBe(false);
    }
    // The rationale keeps its own lines.
    expect(lines.some((l) => l.trim() === 'line two')).toBe(true);
  });

  it('bidi overrides, isolates and zero-width characters are replaced too', () => {
    expect(clean('a\u202Eb\u2066c\u2069d\u200Be\u200Ff\u2060g\uFEFFh')).toBe('a?b?c?d?e?f?g?h');
    expect(clean('\u202A\u202B\u202C\u202D\u2067\u2068\u200C\u200D\u200E')).toBe('?????????');
    expect(clean('plain — text')).toBe('plain — text');
  });
});

describe('apply', () => {
  it('happy path: prints the review, takes the typed id, writes the bytes', async () => {
    const record = await file();
    const ask = vi.fn(async () => 'scout');
    await runPersonalityAmendmentsCommand(['apply', record.id], deps({ ask }));
    expect(ask).toHaveBeenCalledWith(expect.stringContaining('(scout)'));
    expect(toolsetOf('scout')).toContain('- terminal');
    expect((await readAmendment(storage, dataDir, record.id))?.status).toBe('applied');
    expect(printed()).toContain('Permission diff');
  });

  it('passes the expectedAfterHash of the review it printed', async () => {
    const record = await file();
    const review = await service.get(record.id);
    const apply = vi.spyOn(service, 'apply');
    await runPersonalityAmendmentsCommand(['apply', record.id], deps());
    expect(apply).toHaveBeenCalledWith(record.id, {
      actor: 'cli',
      decidedBy: 'cli:tester',
      expectedAfterHash: review?.expectedAfterHash,
    });
  });

  it('refuses without a TTY, before asking or writing', async () => {
    const record = await file();
    const before = toolsetOf('scout');
    const ask = vi.fn(async () => 'scout');
    const err = await refusal(
      runPersonalityAmendmentsCommand(['apply', record.id], deps({ isTty: false, ask })),
    );
    expect(err.code).toBe('FORBIDDEN');
    expect(err.cause).toContain('TTY');
    expect(ask).not.toHaveBeenCalled();
    expect(toolsetOf('scout')).toBe(before);
  });

  it('refuses under ETHOS_TOOL_PROCESS=1 and names it a tripwire', async () => {
    const record = await file();
    const before = toolsetOf('scout');
    const err = await refusal(
      runPersonalityAmendmentsCommand(
        ['apply', record.id],
        deps({ env: { ETHOS_TOOL_PROCESS: '1' } }),
      ),
    );
    expect(err.code).toBe('FORBIDDEN');
    expect(err.action).toContain('tripwire, not a boundary');
    expect(toolsetOf('scout')).toBe(before);
  });

  it('refuses a wrong confirmation and writes nothing', async () => {
    const record = await file();
    const before = toolsetOf('scout');
    const err = await refusal(
      runPersonalityAmendmentsCommand(['apply', record.id], deps({ ask: async () => 'yes' })),
    );
    expect(err.code).toBe('FORBIDDEN');
    expect(toolsetOf('scout')).toBe(before);
    expect((await readAmendment(storage, dataDir, record.id))?.status).toBe('pending');
  });

  it('refuses when toolset.yaml changes after the review is printed (the bytes the owner read)', async () => {
    const record = await file();
    // The owner reads the review; before they finish typing, something appends
    // a line the review never showed. The live file no longer matches baseHash,
    // so the service refuses and nothing the owner did not read is written.
    const ask = async () => {
      writeFileSync(toolsetPath('scout'), `${TOOLSET}- web_fetch\n`);
      return 'scout';
    };
    const err = await refusal(runPersonalityAmendmentsCommand(['apply', record.id], deps({ ask })));
    expect(err.code).toBe('CONFIG_CONFLICT');
    expect(toolsetOf('scout')).toBe(`${TOOLSET}- web_fetch\n`);
    expect((await readAmendment(storage, dataDir, record.id))?.status).toBe('stale');
  });

  it('refuses a stale amendment before asking', async () => {
    const record = await file();
    writeFileSync(toolsetPath('scout'), `${TOOLSET}- web_fetch\n`);
    const ask = vi.fn(async () => 'scout');
    const err = await refusal(runPersonalityAmendmentsCommand(['apply', record.id], deps({ ask })));
    expect(err.code).toBe('CONFIG_CONFLICT');
    expect(err.cause).toContain('stale');
    expect(ask).not.toHaveBeenCalled();
    // Recorded, so it stops counting toward the pending limit (C3).
    expect((await readAmendment(storage, dataDir, record.id))?.status).toBe('stale');
  });

  it('records an interrupted apply as applied instead of refusing it (C4)', async () => {
    const record = await file();
    const review = await service.get(record.id);
    // The live write landed; the status update did not.
    await service.apply(record.id, {
      actor: 'cli',
      decidedBy: 'cli:tester',
      expectedAfterHash: review?.expectedAfterHash ?? '',
    });
    const proposal = join(dataDir, 'learning', 'amendments', record.id, 'proposal.json');
    const stored = JSON.parse(readFileSync(proposal, 'utf-8'));
    writeFileSync(
      proposal,
      JSON.stringify({
        ...stored,
        status: 'pending',
        applied: undefined,
        history: stored.history.slice(0, 1),
      }),
    );
    const ask = vi.fn(async () => 'scout');
    await runPersonalityAmendmentsCommand(['apply', record.id], deps({ ask }));
    expect(ask).not.toHaveBeenCalled();
    expect(printed()).toContain('Recorded');
    expect((await readAmendment(storage, dataDir, record.id))?.status).toBe('applied');
  });
});

describe('decline', () => {
  it('requires a reason', async () => {
    const record = await file();
    const err = await refusal(runPersonalityAmendmentsCommand(['decline', record.id], deps()));
    expect(err.code).toBe('INVALID_INPUT');
    expect((await readAmendment(storage, dataDir, record.id))?.status).toBe('pending');
  });

  it('declines with a reason, without a TTY', async () => {
    const record = await file();
    await runPersonalityAmendmentsCommand(
      ['decline', record.id, '--reason', 'not now'],
      deps({ isTty: false }),
    );
    const stored = await readAmendment(storage, dataDir, record.id);
    expect(stored?.status).toBe('declined');
    expect(stored?.history.at(-1)?.reason).toBe('not now');
  });
});

describe('rollback', () => {
  it('restores the prior bytes after a typed confirmation', async () => {
    const record = await file();
    const before = toolsetOf('scout');
    await runPersonalityAmendmentsCommand(['apply', record.id], deps());
    expect(toolsetOf('scout')).not.toBe(before);
    await runPersonalityAmendmentsCommand(['rollback', record.id], deps());
    expect(toolsetOf('scout')).toBe(before);
    expect((await readAmendment(storage, dataDir, record.id))?.status).toBe('rolled_back');
  });

  it('prints the toolset.yaml diff it would make, live → restored, before asking (C5)', async () => {
    const record = await file();
    await runPersonalityAmendmentsCommand(['apply', record.id], deps());
    out = [];
    let seenBeforeAsk = '';
    await runPersonalityAmendmentsCommand(
      ['rollback', record.id],
      deps({
        ask: async () => {
          seenBeforeAsk = printed();
          return 'scout';
        },
      }),
    );
    expect(seenBeforeAsk).toContain('live → restored');
    expect(seenBeforeAsk).toContain('-- terminal');
    expect(seenBeforeAsk).toContain(' - read_file');
  });

  it('is gated like apply: no TTY, the tripwire, a wrong confirmation', async () => {
    const record = await file();
    await runPersonalityAmendmentsCommand(['apply', record.id], deps());
    const applied = toolsetOf('scout');
    for (const extra of [
      { isTty: false },
      { env: { ETHOS_TOOL_PROCESS: '1' } },
      { ask: async () => 'nope' },
    ]) {
      const err = await refusal(
        runPersonalityAmendmentsCommand(['rollback', record.id], deps(extra)),
      );
      expect(err.code).toBe('FORBIDDEN');
    }
    expect(toolsetOf('scout')).toBe(applied);
  });

  it('refuses an amendment that was never applied', async () => {
    const record = await file();
    const err = await refusal(runPersonalityAmendmentsCommand(['rollback', record.id], deps()));
    expect(err.code).toBe('CONFIG_CONFLICT');
  });
});

describe('arguments', () => {
  it('a missing id and an unknown subcommand are INVALID_INPUT', async () => {
    expect((await refusal(runPersonalityAmendmentsCommand(['show'], deps()))).code).toBe(
      'INVALID_INPUT',
    );
    expect((await refusal(runPersonalityAmendmentsCommand(['frob'], deps()))).code).toBe(
      'INVALID_INPUT',
    );
  });
});
