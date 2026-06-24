import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import type { Logger } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { anthropicFactory } from '../index';

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('anthropicFactory plaintext apiKey deprecation', () => {
  it('warns when falling back to a plaintext config apiKey', async () => {
    const logger = fakeLogger();
    await anthropicFactory({
      config: { model: 'x', apiKey: 'sk-test' },
      secrets: new InMemorySecretsResolver(),
      logger: logger as unknown as Logger,
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message] = logger.warn.mock.calls[0] ?? [];
    expect(message).toContain('plaintext apiKey');
    expect(message).toContain('anthropic');
  });

  it('does not warn when the secret store holds the apiKey', async () => {
    const logger = fakeLogger();
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/anthropic/apiKey', 'sk-secret');

    await anthropicFactory({
      config: { model: 'x', apiKey: 'sk-test' },
      secrets,
      logger: logger as unknown as Logger,
    });

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
