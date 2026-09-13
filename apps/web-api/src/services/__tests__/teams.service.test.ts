import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanbanStore } from '@ethosagent/kanban-store';
import { FsStorage } from '@ethosagent/storage-fs';
import { createTeamMemoryProvider } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KanbanService } from '../kanban.service';
import { TeamsService } from '../teams.service';

// Service-level tests over a temp teams dir (nothing touches ~/.ethos):
//   alpha — running, coordinator, tiered trust, a board with history
//   research  — stopped (no runtime), flat trust, a board
//   ops       — running, no board yet
//   idle      — manifest only
//   broken    — malformed YAML, must be skipped by list()

const ALPHA_YAML = `name: alpha
description: Alpha pod
domain_capabilities: [alpha]
coordinator: coordinator
trust_policy:
  mode: tiered
channels:
  - platform: slack
    botKey: alpha-bot
kanban:
  stale_ms: 60000
members:
  - personality: coordinator
    role: coordinator
    capabilities: [strategy]
  - personality: member-a
  - personality: member-b
`;

const RESEARCH_YAML = `name: research
description: Research pod
domain_capabilities: [research]
trust_policy:
  mode: flat
members:
  - personality: analyst
  - personality: librarian
`;

const OPS_YAML = `name: ops
description: Ops
domain_capabilities: [ops]
members:
  - personality: sre
`;

const IDLE_YAML = `name: idle
description: Idle
domain_capabilities: [x]
members: []
`;

describe('TeamsService', () => {
  let dir: string;
  let service: TeamsService;
  let taskIds: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'teams-service-'));
    writeFileSync(join(dir, 'alpha.yaml'), ALPHA_YAML);
    writeFileSync(join(dir, 'research.yaml'), RESEARCH_YAML);
    writeFileSync(join(dir, 'ops.yaml'), OPS_YAML);
    writeFileSync(join(dir, 'idle.yaml'), IDLE_YAML);
    writeFileSync(join(dir, 'broken.yaml'), 'name: [\n');

    const runtime = (name: string, members: Array<[string, string]>) =>
      writeFileSync(
        join(dir, `${name}.runtime.json`),
        JSON.stringify({
          name,
          manifestPath: join(dir, `${name}.yaml`),
          supervisorPid: 4242,
          startedAt: '2026-09-04T09:00:00.000Z',
          members: members.map(([personality, status], i) => ({
            personality,
            port: 7000 + i,
            pid: status === 'running' ? 100 + i : null,
            status,
            failureCount: 0,
            logFile: `/dev/null`,
          })),
        }),
      );
    runtime('alpha', [
      ['coordinator', 'running'],
      ['member-a', 'degraded'],
    ]);
    runtime('ops', [['sre', 'running']]);

    // alpha board: a little of everything the ledger reads.
    mkdirSync(join(dir, 'alpha'), { recursive: true });
    const store = new KanbanStore(join(dir, 'alpha', 'board.db'), { teamId: 'alpha' });
    const done = store.createTask({ title: 'Draft launch post', actor: 'human:control-center' });
    store.assign(done.id, 'coordinator', 'human:control-center');
    store.updateStatus(done.id, 'running', 'dispatched', 'dispatcher');
    store.completeRun(done.id, 'posted', 'coordinator');

    const reclaimed = store.createTask({ title: 'Scan r/startups', assignee: 'member-b' });
    store.updateStatus(reclaimed.id, 'running', 'dispatched', 'dispatcher');
    store.reclaimTask(reclaimed.id, 'orphan_stale', 'dispatcher');

    const rejected = store.createTask({ title: 'Weekly digest', assignee: 'member-a' });
    store.updateStatus(rejected.id, 'running', 'dispatched', 'dispatcher');
    store.updateStatus(rejected.id, 'needs_revision', 'no source links', 'member-a');
    store.updateStatus(rejected.id, 'done', 'approved — verifier bypassed', 'human:control-center');

    const blocked = store.createTask({ title: 'Pull X mentions', assignee: 'member-b' });
    store.updateStatus(blocked.id, 'running', 'dispatched', 'dispatcher');
    store.blockRun(blocked.id, 'waiting on API key', 'member-b');

    const archived = store.createTask({ title: 'Old idea' });
    store.updateStatus(archived.id, 'archived', undefined, 'human:control-center');
    store.close();
    taskIds = {
      done: done.id,
      reclaimed: reclaimed.id,
      rejected: rejected.id,
      blocked: blocked.id,
      archived: archived.id,
    };

    // research board: exists, no history worth a ledger line.
    mkdirSync(join(dir, 'research'), { recursive: true });
    new KanbanStore(join(dir, 'research', 'board.db'), { teamId: 'research' }).close();

    const storage = new FsStorage();
    service = new TeamsService({
      kanban: new KanbanService({ teamsDir: dir }),
      storage,
      teamsDir: dir,
      // The provider wiring hands the service in production (F04).
      teamMemory: (teamName) => createTeamMemoryProvider({ teamsDir: dir, teamName, storage }),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('list', () => {
    it('lists every parseable team, skips the malformed one and the global board', async () => {
      const { items } = await service.list();
      expect(items.map((t) => t.name).sort()).toEqual(['alpha', 'idle', 'ops', 'research']);
    });

    it('shapes a running team: coordinator, members with status/tier/role, channels, startedAt', async () => {
      const { items } = await service.list();
      const alpha = items.find((t) => t.name === 'alpha');
      expect(alpha).toBeDefined();
      if (!alpha) return;
      expect(alpha.health).toBe('running');
      expect(alpha.dispatchMode).toBe('coordinator');
      expect(alpha.coordinator).toBe('coordinator');
      expect(alpha.startedAt).toBe('2026-09-04T09:00:00.000Z');
      expect(alpha.channels).toEqual([{ platform: 'slack', botKey: 'alpha-bot' }]);
      expect(alpha.members).toEqual([
        {
          personalityId: 'coordinator',
          role: 'coordinator',
          tier: 'probationary',
          status: 'running',
          capabilities: ['strategy'],
        },
        {
          personalityId: 'member-a',
          role: 'member',
          tier: 'probationary',
          status: 'degraded',
          capabilities: [],
        },
        {
          personalityId: 'member-b',
          role: 'member',
          tier: 'probationary',
          status: 'offline',
          capabilities: [],
        },
      ]);
    });

    it('a stopped team with a flat policy and a board: everyone offline, standard tier', async () => {
      const { items } = await service.list();
      const research = items.find((t) => t.name === 'research');
      expect(research?.health).toBe('stopped');
      expect(research?.startedAt).toBeNull();
      expect(research?.coordinator).toBe('analyst');
      expect(research?.members.map((m) => [m.status, m.tier])).toEqual([
        ['offline', 'standard'],
        ['offline', 'standard'],
      ]);
    });

    it('a team without a board has null tiers; an empty team has no coordinator', async () => {
      const { items } = await service.list();
      const ops = items.find((t) => t.name === 'ops');
      expect(ops?.members).toEqual([
        { personalityId: 'sre', role: 'member', tier: null, status: 'running', capabilities: [] },
      ]);
      const idle = items.find((t) => t.name === 'idle');
      expect(idle?.coordinator).toBeNull();
      expect(idle?.members).toEqual([]);
      expect(idle?.channels).toEqual([]);
    });

    it('exposes the member sets the web derives the independent set from', async () => {
      const { items } = await service.list();
      const union = new Set(items.flatMap((t) => t.members.map((m) => m.personalityId)));
      expect([...union].sort()).toEqual([
        'analyst',
        'coordinator',
        'librarian',
        'member-a',
        'member-b',
        'sre',
      ]);
      const all = ['coordinator', 'solo', 'sre', 'member-b'];
      expect(all.filter((id) => !union.has(id))).toEqual(['solo']);
    });
  });

  describe('get', () => {
    it('returns the detail with the raw manifest, trust policy, kanban tuning and runtime', async () => {
      const detail = await service.get('alpha');
      expect(detail.name).toBe('alpha');
      expect(detail.manifestYaml).toBe(ALPHA_YAML);
      expect(detail.manifestPath).toBe(join(dir, 'alpha.yaml'));
      expect(detail.trustPolicy).toEqual({ mode: 'tiered' });
      expect(detail.kanban).toEqual({ staleMs: 60000, pollMs: 1000, stalenessThresholdMs: 300000 });
      expect(detail.memoryTopics).toEqual([]);
      expect(detail.runtime).toEqual({
        supervisorPid: 4242,
        startedAt: '2026-09-04T09:00:00.000Z',
        members: [
          { personality: 'coordinator', port: 7000, pid: 100, status: 'running', failureCount: 0 },
          {
            personality: 'member-a',
            port: 7001,
            pid: null,
            status: 'degraded',
            failureCount: 0,
          },
        ],
      });
    });

    it('a stopped team has a null runtime and a null trust policy when unset', async () => {
      const detail = await service.get('idle');
      expect(detail.runtime).toBeNull();
      expect(detail.trustPolicy).toBeNull();
      expect(detail.kanban).toEqual({ staleMs: 90000, pollMs: 1000, stalenessThresholdMs: 300000 });
    });

    it('rejects a malformed manifest instead of returning a half-team', async () => {
      await expect(service.get('broken')).rejects.toThrow(/YAML parse error/);
    });

    it('refuses names that could escape the teams dir', async () => {
      await expect(service.get('../x')).rejects.toThrow(/invalid team name/);
      await expect(service.get('..')).rejects.toThrow(/invalid team name/);
      await expect(service.get('a/b')).rejects.toThrow(/invalid team name/);
      await expect(service.ledger({ team: '../x' })).rejects.toThrow(/invalid team name/);
      await expect(service.memoryList('../x')).rejects.toThrow(/invalid team name/);
    });

    it('404s an unknown team', async () => {
      await expect(service.get('nope')).rejects.toThrow(/team not found/);
    });
  });

  describe('ledger', () => {
    it('labels the board history newest first, one line per decision', async () => {
      const { items } = await service.ledger({ team: 'alpha' });
      for (let i = 1; i < items.length; i++) {
        expect(items[i - 1]?.id).toBeGreaterThan(items[i]?.id ?? Number.POSITIVE_INFINITY);
      }
      const kinds = items.map((l) => l.kind);
      expect(kinds).toEqual([
        'operator_archived',
        'created',
        'blocked',
        'dispatched',
        'created',
        'operator_approved',
        'verifier_rejected',
        'dispatched',
        'created',
        'stale_reclaim',
        'dispatched',
        'created',
        'completed',
        'dispatched',
        'operator_assigned',
        'created',
      ]);
      const blocked = items.find((l) => l.kind === 'blocked');
      expect(blocked?.taskId).toBe(taskIds.blocked);
      expect(blocked?.taskTitle).toBe('Pull X mentions');
      expect(blocked?.detail).toBe('waiting on API key');
      expect(blocked?.personalityId).toBe('member-b');
      const rejected = items.find((l) => l.kind === 'verifier_rejected');
      expect(rejected?.detail).toBe('no source links · retry 0 of ∞');
      const reclaim = items.find((l) => l.kind === 'stale_reclaim');
      expect(reclaim?.severity).toBe('err');
      expect(reclaim?.taskId).toBe(taskIds.reclaimed);
      for (const l of items) expect(Number.isNaN(Date.parse(l.at))).toBe(false);
    });

    it('filters by personalityId and honors limit', async () => {
      const { items } = await service.ledger({ team: 'alpha', personalityId: 'member-b' });
      expect(items.length).toBeGreaterThan(0);
      for (const l of items) expect(l.personalityId).toBe('member-b');
      const capped = await service.ledger({ team: 'alpha', limit: 2 });
      expect(capped.items).toHaveLength(2);
    });

    it('is empty for a team with no board', async () => {
      expect((await service.ledger({ team: 'ops' })).items).toEqual([]);
    });
  });

  describe('memory', () => {
    it('round-trips a topic: replace → add → list → read → delete', async () => {
      expect((await service.memoryList('alpha')).items).toEqual([]);
      expect(await service.memoryRead('alpha', 'decisions')).toEqual({
        key: 'decisions',
        content: '',
      });

      await service.memoryWrite({
        team: 'alpha',
        key: 'decisions',
        action: 'replace',
        content: '# Decisions',
      });
      await service.memoryWrite({
        team: 'alpha',
        key: 'decisions',
        action: 'add',
        content: '- never post, only report',
      });
      expect((await service.memoryList('alpha')).items).toEqual([{ key: 'decisions' }]);
      expect((await service.get('alpha')).memoryTopics).toEqual(['decisions']);
      const { content } = await service.memoryRead('alpha', 'decisions');
      expect(content).toBe('# Decisions\n\n- never post, only report\n');

      await service.memoryWrite({ team: 'alpha', key: 'decisions', action: 'delete' });
      expect((await service.memoryList('alpha')).items).toEqual([]);
      expect((await service.memoryRead('alpha', 'decisions')).content).toBe('');
    });

    it('rejects unsafe keys and content-less writes', async () => {
      await expect(service.memoryRead('alpha', '../secrets')).rejects.toThrow(/invalid memory key/);
      await expect(service.memoryRead('alpha', 'a.b')).rejects.toThrow(/invalid memory key/);
      await expect(
        service.memoryWrite({ team: 'alpha', key: 'x', action: 'replace' }),
      ).rejects.toThrow(/content is required/);
      await expect(service.memoryList('nope')).rejects.toThrow(/team not found/);
    });
  });
});
