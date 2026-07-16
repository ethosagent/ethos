import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { isEthosError } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { NamedSecretsService, redactSecret } from '../../services/named-secrets.service';

describe('redactSecret', () => {
  it('masks the value and never returns it verbatim', () => {
    expect(redactSecret('sk-exa-1234567890abcdef')).toBe('sk-…cdef');
    expect(redactSecret('123456')).toBe('…3456');
    expect(redactSecret('abc')).toBe('<set>');
    expect(redactSecret('')).toBe('<unset>');
    expect(redactSecret(null)).toBe('<unset>');
  });
});

describe('NamedSecretsService', () => {
  let secrets: InMemorySecretsResolver;
  let service: NamedSecretsService;

  beforeEach(() => {
    secrets = new InMemorySecretsResolver();
    service = new NamedSecretsService({ secrets });
  });

  it('create writes to providers/<provider>/<name> in the vault', async () => {
    const res = await service.create({
      provider: 'exa',
      name: 'main',
      value: 'sk-exa-secret-value',
    });
    expect(res.ok).toBe(true);
    expect(await secrets.get('providers/exa/main')).toBe('sk-exa-secret-value');
    // The create response carries only a masked preview — never the raw value.
    expect(res.preview).not.toContain('secret-value');
    expect(res.preview).toBe('sk-…alue');
  });

  it('list returns masked previews only — the raw value never crosses the boundary', async () => {
    await service.create({ provider: 'tavily', name: 'work', value: 'tvly-abcdef123456' });
    const { secrets: list } = await service.list();
    expect(list).toHaveLength(1);
    const row = list[0];
    if (!row) throw new Error('expected one secret');
    expect(row.provider).toBe('tavily');
    expect(row.name).toBe('work');
    expect(row.kind).toBe('web-search');
    expect(row.preview).not.toContain('abcdef');
    // Nothing on the wire row equals the stored value.
    expect(JSON.stringify(row)).not.toContain('tvly-abcdef123456');
  });

  it('delete removes the secret from the vault', async () => {
    await service.create({ provider: 'brave', name: 'k1', value: 'brave-xxxxxxxx' });
    await service.delete({ provider: 'brave', name: 'k1' });
    expect(await secrets.get('providers/brave/k1')).toBeNull();
    expect((await service.list()).secrets).toHaveLength(0);
  });

  it('rejects providers outside the web_search namespaces', async () => {
    try {
      await service.create({ provider: 'openai', name: 'main', value: 'x' });
      throw new Error('expected throw');
    } catch (err) {
      expect(isEthosError(err)).toBe(true);
    }
  });

  it('rejects invalid secret names', async () => {
    try {
      await service.create({ provider: 'exa', name: 'bad/name', value: 'x' });
      throw new Error('expected throw');
    } catch (err) {
      expect(isEthosError(err)).toBe(true);
    }
  });
});
