// compose() adds `<dataDir>/catalog-skills` as the `catalog` source (D16), so a
// skill installed there is discovered as `catalog/<id>`, and the data dir is the
// one passed in (ETHOS_STATE_DIR-style), not ~/.ethos.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultHookRegistry } from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig, PersonalityRegistry, WiringContext } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compose } from '../compose';
import { filterSkill } from '../ingest-filter';

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ethos-compose-catalog-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const SKILL = '---\nname: pdf\ndescription: Work with PDFs\n---\n\n# PDF\n\nExtract text.\n';

describe('compose: the catalog skill source', () => {
  it('discovers <dataDir>/catalog-skills/<id>/SKILL.md as catalog/<id>, hidden until allowed', async () => {
    await mkdir(join(dataDir, 'catalog-skills', 'pdf'), { recursive: true });
    await writeFile(join(dataDir, 'catalog-skills', 'pdf', 'SKILL.md'), SKILL);

    const ctx = {
      storage: new FsStorage(),
      dataDir,
      workingDir: dataDir,
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    } as unknown as WiringContext;
    const out = await compose(ctx, {
      personalities: {} as PersonalityRegistry,
      activePerson: { id: 'p', name: 'P' } as PersonalityConfig,
      hooks: new DefaultHookRegistry(),
      platformPrompts: new Map(),
      log: ctx.log,
    });

    const skill = out.skillPool.get('catalog/pdf');
    expect(skill?.source).toBe('catalog');

    const personality: PersonalityConfig = { id: 'p', name: 'P', toolset: [] };
    expect(skill && filterSkill(skill, personality, new Set()).include).toBe(false);
    const allowed: PersonalityConfig = {
      ...personality,
      skills: { global_ingest: { allow: ['catalog/pdf'] } },
    };
    expect(skill && filterSkill(skill, allowed, new Set()).include).toBe(true);
  });
});
