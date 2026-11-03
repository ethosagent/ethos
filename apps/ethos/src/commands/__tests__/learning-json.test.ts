import { join } from 'node:path';
import { submitCandidate } from '@ethosagent/learning-inbox';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { EthosErrorCode } from '@ethosagent/types';
import { createLearningInbox, type LearningInbox } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLearningCommand } from '../learning';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 16 (context-budget-2): `ethos learning <sub> --json` prints exactly one JSON document.

const DATA = '/ethos';
const SKILL = '---\nname: cite-sources\ndescription: "Always cite"\n---\n\nCite every claim.\n';

let h: JsonCliHarness;
let storage: InMemoryStorage;
let inbox: LearningInbox;
const io = {
  out: (l: string) => {
    throw new Error(`io.out leaked under --json: ${l}`);
  },
  err: (l: string) => {
    throw new Error(`io.err leaked under --json: ${l}`);
  },
};

beforeEach(async () => {
  h = await setupJsonCli('ethos-learning-json-');
  storage = new InMemoryStorage();
  const dir = join(DATA, 'personalities', 'scout');
  await storage.mkdir(dir);
  await storage.write(join(dir, 'config.yaml'), 'name: Scout\n');
  const registry = new FilePersonalityRegistry(storage, DATA);
  await registry.loadFromDirectory(join(DATA, 'personalities'));
  inbox = createLearningInbox({
    storage,
    dataDir: DATA,
    personalities: registry,
    expressions: registry,
    defaultPersonalityId: 'scout',
  });
});

afterEach(async () => {
  await h.teardown();
});

function submit() {
  return submitCandidate(storage, DATA, {
    kind: 'skill',
    op: 'create',
    personalityId: 'scout',
    origin: 'nightly',
    destination: join(DATA, 'skills', 'cite-sources.md'),
    content: SKILL,
    evidence: { digest: 'three sessions where sources were missing' },
  });
}

describe('learning --json', () => {
  it('--json success is one JSON doc', async () => {
    const candidate = await submit();
    expect(await runLearningCommand(['list', '--json'], inbox, io)).toBe(0);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.count).toBe(1);
    expect(doc.candidates).toMatchObject([{ id: candidate.id, personalityId: 'scout' }]);
  });

  it('--json show is one JSON doc with the candidate and timeline', async () => {
    const candidate = await submit();
    expect(await runLearningCommand(['show', candidate.id, '--json'], inbox, io)).toBe(0);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.candidate).toMatchObject({ id: candidate.id });
    expect(Array.isArray(doc.timeline)).toBe(true);
  });

  it('--json reject is one JSON doc', async () => {
    const candidate = await submit();
    await runLearningCommand(['reject', candidate.id, '--reason', 'no', '--json'], inbox, io);
    expect(parseOneDoc(h)).toEqual({ ok: true, id: candidate.id, rejected: true });
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runLearningCommand(['show', '--json'], inbox, io)).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    const code: EthosErrorCode = 'INVALID_INPUT';
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe(code);
  });

  it('--json unknown candidate is one NOT_FOUND doc', async () => {
    await expect(runLearningCommand(['show', 'ghost', '--json'], inbox, io)).rejects.toThrow(
      `${EXIT}(1)`,
    );
    const code: EthosErrorCode = 'NOT_FOUND';
    expect(parseOneDoc(h).error?.code).toBe(code);
  });

  it('--json unknown subcommand is one INVALID_INPUT doc', async () => {
    await expect(runLearningCommand(['bogus', '--json'], inbox, io)).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });
});
