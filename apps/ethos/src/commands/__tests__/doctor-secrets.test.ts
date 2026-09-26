// `ethos doctor`'s Secrets section checks the ref the config actually points at.
// It used to look up hard-coded refs (`anthropic-api-key`, `telegram-bot-token`)
// that nothing writes, so a correctly set-up install reported
// "ANTHROPIC_API_KEY missing". setup.ts and setup-from-env.ts store the provider
// key at `providers/<provider>/apiKey`; writeConfig externalizes to the same ref.

import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { checkSecrets } from '../doctor';

/** `${secrets:<ref>}` without a template-looking string literal. */
const refTo = (ref: string): string => `$\{secrets:${ref}}`;

async function rawConfigAfterWrite(config: EthosConfig) {
  const storage = new InMemoryStorage();
  const secrets = new InMemorySecretsResolver();
  await storage.mkdir(ethosDir());
  await writeConfig(storage, config, secrets);
  const raw = await readRawConfig(storage);
  if (!raw) throw new Error('config not written');
  return { raw, secrets };
}

describe('checkSecrets', () => {
  it('reports the anthropic key setup stored as present', async () => {
    const { raw, secrets } = await rawConfigAfterWrite({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant-0123456789',
      personality: 'researcher',
    });
    expect(raw.apiKey).toBe(refTo('providers/anthropic/apiKey'));
    expect(await checkSecrets(raw, secrets)).toEqual([
      {
        key: 'ANTHROPIC_API_KEY',
        present: true,
        required: false,
        applicable: true,
        fillWith: 'ethos secrets set providers/anthropic/apiKey <value>',
      },
    ]);
  });

  it('checks whichever provider is configured, not only anthropic', async () => {
    const { raw, secrets } = await rawConfigAfterWrite({
      provider: 'openrouter',
      model: 'x/y',
      apiKey: 'sk-or-0123456789',
      personality: 'researcher',
    });
    const [row] = await checkSecrets(raw, secrets);
    expect(row).toMatchObject({ key: 'OPENROUTER_API_KEY', present: true });
  });

  it('reports a referenced key whose secret is gone as missing, naming its ref', async () => {
    const secrets = new InMemorySecretsResolver();
    const [row] = await checkSecrets(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        apiKey: refTo('providers/anthropic/apiKey'),
        personality: 'researcher',
      },
      secrets,
    );
    expect(row).toMatchObject({
      key: 'ANTHROPIC_API_KEY',
      present: false,
      fillWith: 'ethos secrets set providers/anthropic/apiKey <value>',
    });
  });

  it('flags a keyed provider with no key at all, but not a keyless one', async () => {
    const secrets = new InMemorySecretsResolver();
    const base = { model: 'm', apiKey: '', personality: 'researcher' };
    expect(await checkSecrets({ ...base, provider: 'anthropic' }, secrets)).toMatchObject([
      { key: 'ANTHROPIC_API_KEY', present: false },
    ]);
    expect(await checkSecrets({ ...base, provider: 'ollama' }, secrets)).toEqual([]);
    expect(await checkSecrets({ ...base, provider: 'codex' }, secrets)).toEqual([]);
  });

  it('checks a channel token at the ref writeConfig stored it under', async () => {
    const { raw, secrets } = await rawConfigAfterWrite({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant-0123456789',
      personality: 'researcher',
      telegramToken: '123:telegram-token',
    });
    const rows = await checkSecrets(raw, secrets);
    expect(rows.map((r) => [r.key, r.present])).toEqual([
      ['ANTHROPIC_API_KEY', true],
      ['TELEGRAM_BOT_TOKEN', true],
    ]);
  });
});
