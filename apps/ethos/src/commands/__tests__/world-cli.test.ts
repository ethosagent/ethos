import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultWorldGraphProviderRegistry } from '@ethosagent/core';
import { noopLogger } from '@ethosagent/logger';
import { FsStorage } from '@ethosagent/storage-fs';
import { EthosError } from '@ethosagent/types';
import { createWorldRuntime, type WorldRuntime } from '@ethosagent/wiring';
import { SQLiteWorldGraphProvider, worldGraphDbPath } from '@ethosagent/world-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorldCommand, type WorldCliDeps } from '../world';

// plan world-model 7.7: `ethos world` over the REAL world runtime (WorldService,
// WorldSchemaService, WorldConfigService, the sqlite backend) in a temp data dir, with the
// terminal, stdout and the personality list injected.

const ORG = `schema: null
facts:
  entities:
    - { type: Company, name: Acme, source: t, author: user }
    - { type: Team, name: Platform, source: t, author: user }
    - { type: Team, name: Growth, source: t, author: user }
    - { type: Person, name: Mei, source: t, author: user }
    - { type: Person, name: Tom, source: t, author: user }
    - { type: Skill, name: Go, source: t, author: user }
  edges:
    - { type: part_of, from: { type: Team, name: Platform }, to: { type: Company, name: Acme }, source: t, author: user, confidence: 1 }
    - { type: part_of, from: { type: Team, name: Growth }, to: { type: Company, name: Acme }, source: t, author: user, confidence: 1 }
    - { type: member_of, from: { type: Person, name: Mei }, to: { type: Team, name: Platform }, attrs: { role: lead }, source: t, author: user, confidence: 1 }
    - { type: member_of, from: { type: Person, name: Tom }, to: { type: Team, name: Growth }, valid_from: 2026-06-01, source: t, author: user, confidence: 1 }
`;

describe('ethos world', () => {
  let dataDir: string;
  let runtime: WorldRuntime;
  let lines: string[];
  let raw: string;
  let files: Map<string, string>;
  let tty: boolean;
  let answer: boolean;
  let asked: string[];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-world-cli-'));
    const providers = new DefaultWorldGraphProviderRegistry();
    providers.register(
      'sqlite',
      ({ dataDir: dir }) => new SQLiteWorldGraphProvider(worldGraphDbPath(dir)),
    );
    runtime = createWorldRuntime({
      dataDir,
      storage: new FsStorage(),
      config: { enabled: true },
      providers,
      secrets: {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      },
      logger: noopLogger,
      sanitize: (s) => s,
    });
    lines = [];
    raw = '';
    files = new Map();
    tty = true;
    answer = true;
    asked = [];
  });

  afterEach(async () => {
    runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const deps = (): WorldCliDeps => ({
    runtime,
    out: (l) => lines.push(l),
    write: (t) => {
      raw += t;
    },
    readText: async (p) => files.get(p) ?? null,
    personalityExists: async (id) => ['engineer', 'curator'].includes(id),
    isTty: tty,
    confirm: async (q) => {
      asked.push(q);
      return answer;
    },
    by: 'cli:test',
    now: () => new Date('2026-11-28T00:00:00Z'),
  });
  const run = (...args: string[]) => runWorldCommand(args, deps());
  const text = () => lines.join('\n');

  async function failure(...args: string[]): Promise<EthosError> {
    try {
      await run(...args);
    } catch (e) {
      if (e instanceof EthosError) return e;
      throw e;
    }
    throw new Error(`expected ethos world ${args.join(' ')} to fail`);
  }

  async function seedOrg(): Promise<void> {
    await run('create', 'acme', '--template', 'company');
    files.set('org.yaml', ORG);
    await run('import', 'acme', 'org.yaml');
    lines = [];
  }

  it('list shows every world with its counts', async () => {
    await run('list');
    expect(text()).toContain('No worlds');
    await seedOrg();
    await run('list');
    expect(text()).toMatch(/acme\s+acme\s+owner_only\s+sqlite\s+6\s+0/);
    lines = [];
    await run('list', '--json');
    const body = JSON.parse(text()) as { worlds: Array<{ slug: string; entities: number }> };
    expect(body.worlds).toEqual([expect.objectContaining({ slug: 'acme', entities: 6 })]);
  });

  it('create seeds a world from a template with its default audience', async () => {
    await run('create', 'acme', '--template', 'company', '--title', 'Acme Inc');
    const acme = await runtime.configService.readWorld('acme');
    expect(acme).toMatchObject({ title: 'Acme Inc', audience: 'owner_only' });
    const loaded = await runtime.schema.load('world:acme');
    expect(Object.keys(loaded.schema.entities)).toContain('Team');

    await run('create', 'stocks', '--template', 'watchlist');
    expect((await runtime.configService.readWorld('stocks'))?.audience).toBe('shareable');
    await run('create', 'open', '--template', 'company', '--audience', 'shareable');
    expect((await runtime.configService.readWorld('open'))?.audience).toBe('shareable');

    expect((await failure('create', 'acme')).code).toBe('WORLD_CONFLICT');
    expect((await failure('create', 'x', '--template', 'nope')).code).toBe('WORLD_SCHEMA_INVALID');
    expect((await failure('create', 'Bad Slug')).code).toBe('INVALID_INPUT');
  });

  it('show prints the world summary, one entity, and as-of slices', async () => {
    await seedOrg();
    await run('show', 'acme');
    expect(text()).toContain('world:acme');
    expect(text()).toContain('6 entities');
    expect(text()).toContain('schema v1');
    lines = [];
    await run('show', 'acme', '--entity', 'mei');
    expect(text()).toContain('Mei (Person)');
    expect(text()).toContain('-> member_of Platform');
    lines = [];
    await run('show', 'acme', '--as-of', '2026-01-01');
    expect(text()).toContain('3 live edges');
    expect((await failure('show', 'nope')).code).toBe('WORLD_NOT_FOUND');
    expect((await failure('show', 'acme', '--entity', 'ghost')).code).toBe('WORLD_NOT_FOUND');
    expect((await failure('show', 'acme', '--as-of', 'soon')).code).toBe('INVALID_INPUT');
  });

  it('show --tree prints the org chart', async () => {
    await seedOrg();
    await run('show', 'acme', '--tree');
    expect(text()).toBe(
      [
        'Acme (Company)',
        '|- Growth (Team)',
        '|  `- Tom (Person)',
        '`- Platform (Team)',
        '   `- Mei (Person) - lead',
        '',
        'Not in the tree:',
        '  Skill: Go',
      ].join('\n'),
    );
  });

  it('export writes only to stdout in each format', async () => {
    await seedOrg();
    const formats: Array<[string, RegExp]> = [
      ['--yaml', /^facts:/m],
      ['--csv', /# entities\.csv/],
      ['--json', /"entities"/],
      ['--graphml', /<graphml/],
      ['--mermaid', /graph|flowchart/],
      ['--jsonl', /Acme/],
    ];
    for (const [flag, pattern] of formats) {
      raw = '';
      await run('export', 'acme', flag);
      expect(raw, flag).toMatch(pattern);
    }
    expect(lines).toEqual([]);
    expect((await failure('export', 'acme')).code).toBe('INVALID_INPUT');
    expect((await failure('export', 'acme', '--yaml', '--json')).code).toBe('INVALID_INPUT');
  });

  it('import reads a facts file into the world', async () => {
    await run('create', 'acme', '--template', 'company');
    files.set('org.yaml', ORG);
    await run('import', 'acme', 'org.yaml');
    expect(text()).toContain('Imported 6 entities');
    expect(text()).toContain('4 edges');
    expect((await failure('import', 'acme', 'missing.yaml')).code).toBe('FILE_NOT_FOUND');
    expect((await failure('import', 'acme', 'notes.txt')).code).toBe('INVALID_INPUT');
    files.set('bad.yaml', 'facts: [');
    expect((await failure('import', 'acme', 'bad.yaml')).code).toBe('WORLD_SCHEMA_INVALID');
  });

  async function proposeAsAgent(): Promise<string> {
    await run('grant', 'acme', 'engineer', '--propose');
    await run('mount', 'engineer', 'acme', '--mode', 'propose');
    const out = await runtime.service.writeFacts(
      { personalityId: 'engineer', audience: 'private', sessionId: 's1', surface: 'tool' },
      'acme',
      [{ kind: 'entity', type: 'Person', name: 'Ada', sourceRef: 'chat:1', author: 'agent' }],
      'seen in chat',
    );
    expect(out.proposed).toHaveLength(1);
    lines = [];
    return out.proposed[0] ?? '';
  }

  it('proposals lists the pending ones', async () => {
    await seedOrg();
    await run('proposals', 'acme');
    expect(text()).toBe('No pending proposals.');
    const id = await proposeAsAgent();
    await run('proposals', 'acme');
    expect(text()).toContain(id);
    expect(text()).toContain('engineer');
  });

  it('accept writes the proposed fact', async () => {
    await seedOrg();
    const id = await proposeAsAgent();
    await run('accept', id);
    expect(text()).toContain(`Accepted ${id}`);
    const bundle = await runtime.service.ownerExport('world:acme');
    expect(bundle.entities.map((e) => e.name)).toContain('Ada');
    expect((await failure('accept', id)).code).toBe('WORLD_NOT_FOUND');
  });

  it('reject closes the proposal without writing', async () => {
    await seedOrg();
    const id = await proposeAsAgent();
    await run('reject', id, '--reason', 'not ours');
    expect(text()).toContain(`Rejected ${id}`);
    expect(runtime.service.ownerProposal(id)).toMatchObject({
      status: 'rejected',
      reason: 'not ours',
      decidedBy: 'cli:test',
    });
    const bundle = await runtime.service.ownerExport('world:acme');
    expect(bundle.entities.map((e) => e.name)).not.toContain('Ada');
    expect((await failure('reject', id)).code).toBe('WORLD_NOT_FOUND');
  });

  it('grant adds a reader or proposer', async () => {
    await run('create', 'acme');
    await run('grant', 'acme', 'curator', '--read');
    await run('grant', 'acme', 'engineer', '--propose');
    expect(await runtime.configService.readWorld('acme')).toMatchObject({
      readers: ['curator'],
      proposers: ['engineer'],
    });
    await run('grant', 'acme', 'curator', '--read');
    expect(text()).toContain('already in acme readers');
    expect((await failure('grant', 'acme', 'ghost', '--read')).code).toBe('WORLD_NOT_FOUND');
    expect((await failure('grant', 'acme', 'curator')).code).toBe('INVALID_INPUT');
    expect((await failure('grant', 'nope', 'curator', '--read')).code).toBe('WORLD_NOT_FOUND');
  });

  it('revoke removes every grant of a personality', async () => {
    await run('create', 'acme');
    await run('grant', 'acme', 'curator', '--read');
    await run('grant', 'acme', 'engineer', '--propose');
    await run('revoke', 'acme', 'curator');
    await run('revoke', 'acme', 'engineer');
    expect(await runtime.configService.readWorld('acme')).toMatchObject({
      readers: [],
      proposers: [],
    });
    expect((await failure('revoke', 'acme', 'curator')).code).toBe('WORLD_NOT_FOUND');
  });

  it('mount writes the personality worlds.yaml, with an alias', async () => {
    await run('create', 'acme');
    await run('mount', 'engineer', 'acme', '--mode', 'read', '--as', 'co');
    expect((await runtime.configService.readMounts('engineer')).mounts).toEqual([
      { world: 'acme', mode: 'read', as: 'co' },
    ]);
    expect(text()).toContain('inert until the world grants it');
    await run('mount', 'engineer', 'acme', '--mode', 'propose');
    expect((await runtime.configService.readMounts('engineer')).mounts).toEqual([
      { world: 'acme', mode: 'propose' },
    ]);
    expect((await failure('mount', 'engineer', 'acme')).code).toBe('INVALID_INPUT');
    expect((await failure('mount', 'ghost', 'acme', '--mode', 'read')).code).toBe(
      'WORLD_NOT_FOUND',
    );
    expect((await failure('mount', 'engineer', 'nope', '--mode', 'read')).code).toBe(
      'WORLD_NOT_FOUND',
    );
  });

  it('unmount removes the mount', async () => {
    await run('create', 'acme');
    await run('mount', 'engineer', 'acme', '--mode', 'read');
    await run('unmount', 'engineer', 'acme');
    expect((await runtime.configService.readMounts('engineer')).mounts).toEqual([]);
    expect((await failure('unmount', 'engineer', 'acme')).code).toBe('WORLD_NOT_FOUND');
  });

  it('purge deletes an entity after confirmation, or the whole world with --yes', async () => {
    await seedOrg();
    await run('purge', 'acme', '--entity', 'Tom', '--reason', 'left the company');
    expect(asked[0]).toContain('Tom (Person)');
    expect(
      (await runtime.service.ownerExport('world:acme')).entities.map((e) => e.name),
    ).not.toContain('Tom');
    answer = false;
    await run('purge', 'acme', '--reason', 'reset');
    expect(text()).toContain('Cancelled');
    expect((await runtime.service.ownerExport('world:acme')).entities.length).toBeGreaterThan(0);
    await run('purge', 'acme', '--reason', 'reset', '--yes');
    expect((await runtime.service.ownerExport('world:acme')).entities).toEqual([]);
    expect((await failure('purge', 'acme', '--yes')).code).toBe('INVALID_INPUT');
    expect(
      (await failure('purge', 'acme', '--entity', 'ghost', '--reason', 'x', '--yes')).code,
    ).toBe('WORLD_NOT_FOUND');
  });

  it('purge without --yes refuses in a non-TTY', async () => {
    await seedOrg();
    tty = false;
    const e = await failure('purge', 'acme', '--reason', 'reset');
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.cause).toContain('terminal');
    expect(asked).toEqual([]);
    expect((await runtime.service.ownerExport('world:acme')).entities).toHaveLength(6);
  });

  it('an unknown subcommand is INVALID_INPUT and help prints usage', async () => {
    expect((await failure('frobnicate')).code).toBe('INVALID_INPUT');
    await run('help');
    expect(text()).toContain('Usage: ethos world');
  });
});
