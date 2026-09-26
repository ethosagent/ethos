// Two config keys mean something when their value is EMPTY, distinct from the
// key being absent (packages/config `parseConfigYaml`):
//   voice.trustedPlugins:          — arms the local-only voice-egress gate, trusting nothing non-local
//   security.trusted_github_orgs:  — trusts no GitHub org (absent = the shipped default)
// A web save is a read-modify-write through `ConfigRepository`, so dropping an
// empty line on read silently changes what the deployment trusts.

import { join } from 'node:path';
import { parseConfigYaml } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';

const DATA = '/data';
const PATH = join(DATA, 'config.yaml');

async function saveUnrelated(src: string): Promise<string> {
  const storage = new InMemoryStorage();
  await storage.mkdir(DATA);
  await storage.write(PATH, src);
  const repo = new ConfigRepository({
    dataDir: DATA,
    storage,
    secrets: new InMemorySecretsResolver(),
  });
  await repo.update({ skin: 'mono' });
  return (await storage.read(PATH)) ?? '';
}

describe('ConfigRepository preserves empty-but-meaningful values', () => {
  it.each([
    ['bare `key:`', 'voice.trustedPlugins:\nsecurity.trusted_github_orgs:\n'],
    ['quoted empty', 'voice.trustedPlugins: ""\nsecurity.trusted_github_orgs: ""\n'],
    ['trailing space', 'voice.trustedPlugins: \nsecurity.trusted_github_orgs: \n'],
  ])('keeps both keys empty-but-present across a web save (%s)', async (_label, lines) => {
    const src = `provider: anthropic\nmodel: claude-sonnet-5\npersonality: engineer\n${lines}`;
    // The CLI parser reads the ORIGINAL file as "empty list", not "absent".
    const before = parseConfigYaml(src);
    expect(before.voice?.trustedPlugins).toEqual([]);
    expect(before.security?.trustedGitHubOrgs).toEqual([]);

    const after = parseConfigYaml(await saveUnrelated(src));

    expect(after.voice?.trustedPlugins).toEqual([]);
    expect(after.security?.trustedGitHubOrgs).toEqual([]);
  });
});
