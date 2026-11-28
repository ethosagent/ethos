import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSchemaYaml } from '../schema-model';
import { isTemplateName, loadTemplate, TEMPLATE_AUDIENCE, TEMPLATE_NAMES } from '../templates';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../templates');

describe('schema templates', () => {
  it.each(TEMPLATE_NAMES)('template text matches templates/%s.schema.yaml', (name) => {
    expect(loadTemplate(name)).toBe(readFileSync(join(dir, `${name}.schema.yaml`), 'utf8'));
  });

  it.each(TEMPLATE_NAMES)('%s parses at version 1', (name) => {
    const r = parseSchemaYaml(loadTemplate(name));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.schema.version).toBe(1);
  });

  it('company is owner_only and watchlist is shareable (O-2)', () => {
    expect(TEMPLATE_AUDIENCE).toEqual({ company: 'owner_only', watchlist: 'shareable' });
    expect(isTemplateName('company')).toBe(true);
    expect(isTemplateName('nope')).toBe(false);
  });

  it('company has Company, Team and Person joined by part_of and member_of', () => {
    const r = parseSchemaYaml(loadTemplate('company'));
    if (!r.ok) throw new Error('company template does not parse');
    expect(Object.keys(r.schema.entities)).toEqual(
      expect.arrayContaining(['Company', 'Team', 'Person']),
    );
    expect(Object.keys(r.schema.edges)).toEqual(expect.arrayContaining(['part_of', 'member_of']));
  });
});
