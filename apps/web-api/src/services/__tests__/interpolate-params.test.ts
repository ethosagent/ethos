import { describe, expect, it } from 'vitest';
import {
  assertSelectOnlySql,
  findInvalidParamKeys,
  type ParamDef,
  parseImportPayload,
  validateParamValue,
} from '../interpolate-params';

describe('validateParamValue — empty-options wildcard (WEB-004 4a)', () => {
  it('rejects any value for a select def with no options', () => {
    const def: ParamDef = { key: 'region', label: 'Region', type: 'select', default: '' };
    expect(validateParamValue(def, 'region', "us' OR 1=1")).toBe(false);
  });

  it('rejects any value for a select def with an empty options array', () => {
    const def: ParamDef = {
      key: 'region',
      label: 'Region',
      type: 'options',
      options: [],
      default: '',
    };
    expect(validateParamValue(def, 'region', 'anything')).toBe(false);
  });

  it('still accepts a listed option when options are present', () => {
    const def: ParamDef = {
      key: 'region',
      label: 'Region',
      type: 'select',
      options: ['us', 'eu'],
      default: 'us',
    };
    expect(validateParamValue(def, 'region', 'eu')).toBe(true);
    expect(validateParamValue(def, 'region', 'apac')).toBe(false);
  });

  it('findInvalidParamKeys flags a value against an empty-options def', () => {
    const schema: ParamDef[] = [{ key: 'region', label: 'Region', type: 'select', default: '' }];
    expect(findInvalidParamKeys(schema, { region: 'us' })).toEqual(['region']);
  });
});

describe('assertSelectOnlySql (WEB-004 4c shared guard)', () => {
  it('accepts a single SELECT', () => {
    expect(() => assertSelectOnlySql('SELECT * FROM t')).not.toThrow();
    expect(() => assertSelectOnlySql('  select 1 ;')).not.toThrow();
  });

  it('rejects a non-SELECT statement', () => {
    expect(() => assertSelectOnlySql('DROP TABLE users')).toThrow(
      'SQL query must start with SELECT',
    );
  });

  it('rejects stacked statements', () => {
    expect(() => assertSelectOnlySql('SELECT 1; DROP TABLE users')).toThrow(
      'SQL query must not contain multiple statements',
    );
  });
});

describe('parseImportPayload (WEB-004 4c/4d)', () => {
  it('rejects a payload that is not an object', () => {
    expect(() => parseImportPayload(42)).toThrow(/malformed/i);
  });

  it('rejects a panel whose sqlQuery is not a SELECT', () => {
    const payload = {
      version: 1,
      title: 'X',
      panels: [{ queryType: 'sql', blockType: 'table', content: '[]', sqlQuery: 'DELETE FROM t' }],
    };
    expect(() => parseImportPayload(payload)).toThrow(/SELECT/i);
  });

  it('rejects paramsCurrent outside the imported schema allowlist', () => {
    const payload = {
      version: 1,
      title: 'X',
      paramsSchema: [
        { key: 'region', label: 'Region', type: 'select', options: ['us'], default: 'us' },
      ],
      paramsCurrent: { region: "us' UNION SELECT secret FROM users --" },
      panels: [],
    };
    expect(() => parseImportPayload(payload)).toThrow(/param/i);
  });

  it('rejects a panel paramDefault outside the imported schema allowlist (4d)', () => {
    const payload = {
      version: 1,
      title: 'X',
      paramsSchema: [
        { key: 'region', label: 'Region', type: 'select', options: ['us'], default: 'us' },
      ],
      panels: [
        { queryType: 'sql', blockType: 'table', content: '[]', paramDefaults: { region: 'evil' } },
      ],
    };
    expect(() => parseImportPayload(payload)).toThrow(/param/i);
  });

  it('accepts a well-formed payload with allowed params and a SELECT', () => {
    const payload = {
      version: 1,
      title: 'Imported',
      paramsSchema: [
        { key: 'region', label: 'Region', type: 'select', options: ['us', 'eu'], default: 'us' },
      ],
      paramsCurrent: { region: 'eu' },
      panels: [
        {
          queryType: 'sql',
          blockType: 'table',
          content: '[]',
          sqlQuery: 'SELECT * FROM sales',
          paramDefaults: { region: 'us' },
        },
      ],
    };
    const data = parseImportPayload(payload);
    expect(data.title).toBe('Imported');
    expect(data.panels).toHaveLength(1);
  });
});
