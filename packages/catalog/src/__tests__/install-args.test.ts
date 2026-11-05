import { describe, expect, it } from 'vitest';
import { installFlags as filterInstallFlags } from '../filter';
import { CATALOG_SKILLS_DIR, catalogSkillPath, installFlags } from '../index';

describe('installFlags', () => {
  it('builds --arg then --env placeholders from the entry', () => {
    const mcp = { argsAfterSpec: [], argVars: ['ALLOWED_PATH'], envVars: ['API_KEY'] };
    expect(installFlags({ mcp })).toEqual([
      '--arg ALLOWED_PATH=<allowed_path>',
      '--env API_KEY=<api_key>',
    ]);
  });

  it('is empty for an entry with no mcp block, and exported from ./filter too', () => {
    expect(installFlags({})).toEqual([]);
    expect(filterInstallFlags).toBe(installFlags);
  });
});

describe('catalogSkillPath', () => {
  it('is <dataDir>/catalog-skills/<id>', () => {
    expect(CATALOG_SKILLS_DIR).toBe('catalog-skills');
    expect(catalogSkillPath('/data', 'pdf')).toBe('/data/catalog-skills/pdf');
  });
});
