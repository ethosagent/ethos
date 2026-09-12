import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { MemoryContext, MemoryProvider } from '@ethosagent/types';
import { createTeamMemoryProvider } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KanbanService } from '../kanban.service';
import { TeamsService } from '../teams.service';

// F04 follow-up — team memory has ONE owner. The `team_memory_*` tools write
// through wiring's policy stack (LazyOnDemand + LastWriteWins over the markdown
// provider); the web team-memory editor used to construct a BARE provider over
// the same directory, so its write carried no mtime precondition and silently
// overwrote whatever an agent had written since the page last read. Both sides
// now come from `createTeamMemoryProvider`, one instance per caller (the
// precondition map is per-caller by contract — see LastWriteWinsPolicy).

const TEAM = 'ops';
const OPS_YAML = `name: ops
description: Ops
domain_capabilities: [ops]
members:
  - personality: sre
`;

const agentCtx: MemoryContext = {
  scopeId: `team:${TEAM}`,
  sessionId: 's',
  sessionKey: 'cli',
  platform: 'cli',
  workingDir: '',
};

/** A gap wide enough that the file's mtime moves (the precondition is mtime-based). */
const tick = () => new Promise((resolve) => setTimeout(resolve, 12));

describe('team memory: web editor and agent tools share one policy', () => {
  let dir: string;
  let service: TeamsService;
  let agentMemory: MemoryProvider;
  const storage = new FsStorage();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-team-memory-policy-'));
    mkdirSync(join(dir, TEAM, 'memory'), { recursive: true });
    writeFileSync(join(dir, `${TEAM}.yaml`), OPS_YAML);
    service = new TeamsService({
      kanban: new KanbanService({ teamsDir: dir }),
      storage,
      teamsDir: dir,
      teamMemory: (teamName) => createTeamMemoryProvider({ teamsDir: dir, teamName, storage }),
    });
    // The agent side: its own instance of the same stack, as a loop gets.
    agentMemory = createTeamMemoryProvider({ teamsDir: dir, teamName: TEAM, storage });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a web write that would overwrite an agent write made since the page read', async () => {
    await service.memoryWrite({ team: TEAM, key: 'decisions', action: 'replace', content: 'v1\n' });

    // The page reads (this is what records the precondition), then an agent writes.
    expect((await service.memoryRead(TEAM, 'decisions')).content).toContain('v1');
    await tick();
    await agentMemory.sync(
      [{ action: 'replace', key: 'decisions.md', content: 'agent decision\n' }],
      agentCtx,
    );

    await expect(
      service.memoryWrite({ team: TEAM, key: 'decisions', action: 'replace', content: 'v2\n' }),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' });

    // The agent's write survives; nothing was lost.
    expect((await service.memoryRead(TEAM, 'decisions')).content).toContain('agent decision');
  });

  it('refuses an agent write that would overwrite a web write made since the tool read', async () => {
    await service.memoryWrite({
      team: TEAM,
      key: 'onboarding',
      action: 'replace',
      content: 'v1\n',
    });

    expect((await agentMemory.read('onboarding.md', agentCtx))?.content).toContain('v1');
    await tick();
    await service.memoryWrite({
      team: TEAM,
      key: 'onboarding',
      action: 'replace',
      content: 'web edit\n',
    });

    await expect(
      agentMemory.sync([{ action: 'replace', key: 'onboarding.md', content: 'stale\n' }], agentCtx),
    ).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' });
    expect((await service.memoryRead(TEAM, 'onboarding')).content).toContain('web edit');
  });

  it('an uncontended web edit still writes, and lands where the tools read', async () => {
    await service.memoryWrite({
      team: TEAM,
      key: 'architecture',
      action: 'replace',
      content: 'one owner\n',
    });
    expect((await agentMemory.read('architecture.md', agentCtx))?.content).toContain('one owner');
    expect((await service.memoryList(TEAM)).items.map((i) => i.key)).toContain('architecture');
  });
});
