// Plan openclaw-2026.9.6-gaps U4: every key `ConfigRepository.write` emits is
// either read by `parseConfigYaml` or listed in `EXTERNALLY_READ_CONFIG_KEYS`,
// so a web save can never leave a line the CLI then reports as having no
// effect. A new field on the writer that neither reads fails here.

import { join } from 'node:path';
import { configParseNotices, parseConfigYaml } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';

const DATA = '/data';

describe('ConfigRepository.write and the unknown-key notice', () => {
  it('writes no key the config parser reports as unread', async () => {
    const storage = new InMemoryStorage();
    const repo = new ConfigRepository({
      dataDir: DATA,
      storage,
      secrets: new InMemorySecretsResolver(),
    });
    await repo.update({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: 'sk-test',
      personality: 'engineer',
      memory: 'markdown',
      baseUrl: 'https://api.example.test',
      skin: 'mono',
      approvalMode: 'smart',
      verbosity: 'concise',
      debugMode: true,
      contextLayering: false,
      debugPanelEnabled: true,
      debugPanelModel: 'claude-haiku-4',
      voiceProvider: 'openai',
      voiceApiKey: 'sk-voice',
      voiceBaseUrl: 'https://stt.example.test',
      voiceModel: 'whisper-1',
      voiceTtsProvider: 'openai',
      voiceTtsApiKey: 'sk-tts',
      voiceTtsVoice: 'alloy',
      voiceTtsBaseUrl: 'https://tts.example.test',
      voiceTtsModel: 'tts-1',
      modelRouting: { engineer: 'claude-opus-4' },
      toolSettings: { _default: { web_search: { provider: 'exa', secret: 'exa-key' } } },
    });
    const yaml = (await storage.read(join(DATA, 'config.yaml'))) ?? '';
    const unread = configParseNotices(parseConfigYaml(yaml)).warnings.filter((w) =>
      w.includes('has no effect'),
    );
    expect(unread).toEqual([]);
  });
});
