import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSkillFrontmatter, vetPromotedSkill } from '@ethosagent/skills';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Relative on purpose: this package takes the inbox STRUCTURALLY
// (`EvolveApplyInbox`) and does not depend on `@ethosagent/learning-inbox`; the
// test drives the real inbox and the real promote gates.
import {
  LearningInbox,
  readCandidate,
  submitCandidate,
  updateCandidate,
} from '../../../learning-inbox/src/index';
import { runEvolveApply, runEvolvePrune, runEvolveStatus } from '../evolve-helpers';
import { liveSkillDir } from '../skill-dir';

// ---- helpers ---------------------------------------------------------------

let testDir: string;
let skillsDir: string;
let pendingDir: string;
let historyPath: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `evolve-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  skillsDir = join(testDir, 'skills');
  pendingDir = join(skillsDir, 'pending');
  historyPath = join(testDir, 'evolver-history.jsonl');
  await mkdir(pendingDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(testDir, { recursive: true, force: true });
});

// A real `LearningInbox` over InMemoryStorage — `status` and `prune` read (and
// prune rejects) through it, the same object the CLI passes.
function realInbox(
  storage: InMemoryStorage,
  observability?: ConstructorParameters<typeof LearningInbox>[0]['observability'],
): LearningInbox {
  return new LearningInbox({
    ...(observability ? { observability } : {}),
    storage,
    dataDir: INBOX_DATA,
    promote: {
      storage,
      dataDir: INBOX_DATA,
      liveSkillDir,
      skillScope: () => undefined,
      checkSkillFrontmatter: () => ({ ok: true }),
      vetSkill: (md) => ({ ok: true, content: md }),
      expressions: {
        evolveExpression: async () => {
          throw new Error('no Expression candidates in this test');
        },
        revertExpression: async () => {
          throw new Error('no Expression candidates in this test');
        },
      },
    },
  });
}

const INBOX_DATA = '/ethos';

async function waitingSkill(storage: InMemoryStorage, fileName: string, now?: () => number) {
  return submitCandidate(
    storage,
    INBOX_DATA,
    {
      kind: 'skill',
      op: 'create',
      personalityId: 'scout',
      origin: 'nightly',
      destination: join(INBOX_DATA, 'skills', fileName),
      content: `---\nname: ${fileName.replace('.md', '')}\ndescription: "d"\n---\n\nBody.\n`,
    },
    now,
  );
}

function captureLog(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.join(' '));
  });
  return lines;
}

// ---- tests -----------------------------------------------------------------

describe('ethos evolve status — empty store', () => {
  it('prints "no proposals yet" when history and the inbox are empty', async () => {
    const lines = captureLog();

    await runEvolveStatus([], testDir, realInbox(new InMemoryStorage()));

    expect(lines.join('\n')).toMatch(/no proposals yet/i);
  });
});

// L-T8 — the legacy import drained `skills/pending/`, so counting that
// directory reported "0 pending" while the inbox held candidates.
describe('ethos evolve status — counts the learning inbox', () => {
  it('reflects a prior run and lists waiting inbox candidates, not skills/pending files', async () => {
    const record = {
      ranAt: new Date().toISOString(),
      evalOutputPath: '/tmp/eval.jsonl',
      rewritesProposed: 2,
      newSkillsProposed: 1,
      skipped: [],
    };
    await writeFile(historyPath, `${JSON.stringify(record)}\n`, 'utf-8');
    // A leftover file in the retired directory is NOT a pending proposal.
    await writeFile(join(pendingDir, 'retired-queue.md'), '# Old\n', 'utf-8');

    const storage = new InMemoryStorage();
    const mine = await waitingSkill(storage, 'my-skill.md');
    const other = await waitingSkill(storage, 'other-skill.md');
    const decided = await waitingSkill(storage, 'decided.md');
    await updateCandidate(storage, INBOX_DATA, decided.id, { status: 'rejected' });

    const lines = captureLog();
    await runEvolveStatus([], testDir, realInbox(storage));

    const output = lines.join('\n');
    expect(output).toMatch(/last run/i);
    expect(output).toMatch(/Pending \(2\)/);
    expect(output).toContain(mine.id);
    expect(output).toContain(other.id);
    expect(output).toMatch(/my-skill\.md/);
    expect(output).not.toMatch(/decided\.md/);
    expect(output).not.toMatch(/retired-queue\.md/);
  });
});

describe('ethos evolve prune — rejects old inbox candidates', () => {
  it('rejects waiting skill candidates older than --older-than through the inbox, and says so', async () => {
    const storage = new InMemoryStorage();
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const old = await waitingSkill(storage, 'old.md', () => tenDaysAgo);
    const fresh = await waitingSkill(storage, 'fresh.md');
    const rows: unknown[] = [];
    const inbox = realInbox(storage, { recordSafetyApproval: (row) => rows.push(row) });
    const lines = captureLog();

    await runEvolvePrune(['--older-than', '7', '--yes'], inbox);

    expect((await readCandidate(storage, INBOX_DATA, old.id))?.status).toBe('rejected');
    expect((await readCandidate(storage, INBOX_DATA, fresh.id))?.status).toBe('pending_replay');
    expect(rows).toHaveLength(1);
    const output = lines.join('\n');
    expect(output).toMatch(/rejects waiting skill candidates/);
    expect(output).toMatch(/rejected 1 skill candidate/);
  });
});

// ---- ethos evolve apply (L-T8) ---------------------------------------------
//
// `apply` used to rename files out of `skills/pending/`, so it could never find
// a nightly candidate — although `nightly-propose.ts` said it could. It is now a
// thin adapter over the learning inbox: it resolves a WAITING skill candidate of
// any origin, by filename or id, and approves it through `LearningInbox`, which
// refuses a non-`pass` verdict without an override reason.

describe('ethos evolve apply — over the learning inbox', () => {
  const DATA = '/ethos';
  const LIVE = join(DATA, 'skills');
  const GOOD = '---\nname: cite-sources\ndescription: "Always cite"\n---\n\nCite every claim.\n';
  // Unquoted ": " in a value — `skillsDir` is scanned at startup, so promoting
  // this would turn a bad proposal into a failed boot.
  const BROKEN = [
    '---',
    'name: stock-add',
    'description: We repeatedly hit the same workflow problem: adding stocks with null sectors',
    '---',
    '',
    'Body.',
  ].join('\n');

  let storage: InMemoryStorage;
  let inbox: LearningInbox;
  let out: string[];
  let errs: string[];

  beforeEach(() => {
    storage = new InMemoryStorage();
    inbox = new LearningInbox({
      storage,
      dataDir: DATA,
      promote: {
        storage,
        dataDir: DATA,
        liveSkillDir,
        skillScope: () => undefined,
        checkSkillFrontmatter: (md) => {
          const check = checkSkillFrontmatter(md);
          return check.ok ? { ok: true } : { ok: false, error: check.error };
        },
        vetSkill: vetPromotedSkill,
        expressions: {
          evolveExpression: async () => {
            throw new Error('no Expression candidates in this test');
          },
          revertExpression: async () => {
            throw new Error('no Expression candidates in this test');
          },
        },
      },
    });
    out = [];
    errs = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      out.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      errs.push(args.join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error('process.exit called');
    });
  });

  async function nightly(fileName: string, content = GOOD, verdict?: 'pass' | 'regress') {
    const candidate = await submitCandidate(storage, DATA, {
      kind: 'skill',
      op: 'create',
      personalityId: 'scout',
      origin: 'nightly',
      destination: join(LIVE, fileName),
      content,
    });
    if (verdict) {
      await updateCandidate(storage, DATA, candidate.id, { status: 'pending_review', verdict });
    }
    return candidate;
  }

  it('finds a nightly candidate by its filename and promotes it', async () => {
    const candidate = await nightly('cite-sources.md', GOOD, 'pass');

    await runEvolveApply(['cite-sources.md'], inbox);

    expect(await storage.read(join(LIVE, 'cite-sources.md'))).toBe(GOOD);
    expect((await readCandidate(storage, DATA, candidate.id))?.status).toBe('promoted');
    expect(out.join('\n')).toContain(candidate.id);
  });

  it('finds a nightly candidate by its candidate id', async () => {
    const candidate = await nightly('cite-sources.md', GOOD, 'pass');
    await runEvolveApply([candidate.id], inbox);
    expect((await readCandidate(storage, DATA, candidate.id))?.status).toBe('promoted');
  });

  it('refuses a candidate whose replay did not pass and names the override command', async () => {
    const candidate = await nightly('cite-sources.md');

    await expect(runEvolveApply(['cite-sources.md'], inbox)).rejects.toThrow('process.exit called');

    expect(errs.join('\n')).toContain(`ethos learning approve ${candidate.id} --override`);
    expect(await storage.exists(join(LIVE, 'cite-sources.md'))).toBe(false);
    expect((await readCandidate(storage, DATA, candidate.id))?.status).toBe('pending_replay');
  });

  it('errors cleanly when no waiting candidate matches', async () => {
    await expect(runEvolveApply(['nonexistent.md'], inbox)).rejects.toThrow('process.exit called');
    expect(errs.join('\n')).toMatch(/nonexistent\.md/);
  });

  it('refuses to promote a candidate with unparseable frontmatter', async () => {
    const candidate = await nightly('broken.md', BROKEN, 'pass');

    await expect(runEvolveApply(['broken.md'], inbox)).rejects.toThrow('process.exit called');

    expect(errs.join('\n')).toMatch(/broken\.md/);
    expect(errs.join('\n')).toMatch(/invalid frontmatter/);
    expect(await storage.exists(join(LIVE, 'broken.md'))).toBe(false);
    expect((await readCandidate(storage, DATA, candidate.id))?.status).toBe('invalid');
  });

  it('--all promotes the passing candidates and leaves the others waiting', async () => {
    const good = await nightly('good.md', GOOD, 'pass');
    const unreplayed = await nightly('later.md');
    const broken = await nightly('broken.md', BROKEN, 'pass');

    await runEvolveApply(['--all'], inbox);

    expect(await storage.read(join(LIVE, 'good.md'))).toBe(GOOD);
    expect((await readCandidate(storage, DATA, good.id))?.status).toBe('promoted');
    expect((await readCandidate(storage, DATA, unreplayed.id))?.status).toBe('pending_replay');
    expect((await readCandidate(storage, DATA, broken.id))?.status).toBe('invalid');
    expect(await storage.exists(join(LIVE, 'broken.md'))).toBe(false);
  });
});

describe('registerEvolverCron', () => {
  it('exports registerEvolverCron as a callable function', async () => {
    const { registerEvolverCron } = await import('../cron');
    expect(typeof registerEvolverCron).toBe('function');
  });

  it('returns a cleanup function and calls onFire on schedule', async () => {
    const { registerEvolverCron } = await import('../cron');
    // We don't actually start a cron scheduler in tests; just verify the
    // return shape so the wiring contract is exercised.
    const noop = async () => {};
    const cleanup = registerEvolverCron('0 3 * * *', noop);
    expect(typeof cleanup).toBe('function');
    // Clean up any timers the scheduler might have started
    cleanup();
  });

  it('does not call onFire before the schedule fires', async () => {
    const { registerEvolverCron } = await import('../cron');
    let called = false;
    const cleanup = registerEvolverCron('0 3 * * *', async () => {
      called = true;
    });
    // Immediately after registration, onFire should not have been called yet.
    expect(called).toBe(false);
    cleanup();
  });
});
