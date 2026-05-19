import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AwsSecretsManagerResolver } from '../index';

const smMock = mockClient(SecretsManagerClient);

let resolver: AwsSecretsManagerResolver;

beforeEach(() => {
  smMock.reset();
  resolver = new AwsSecretsManagerResolver({
    region: 'us-east-1',
    prefix: 'ethos/engineer',
  });
});

afterEach(() => {
  resolver.dispose();
});

describe('get', () => {
  it('fetches from AWS on first call and returns cached on second call', async () => {
    smMock
      .on(GetSecretValueCommand, {
        SecretId: 'ethos/engineer/providers/anthropic/apiKey',
      })
      .resolves({ SecretString: 'sk-ant-test-key' });

    const first = await resolver.get('providers/anthropic/apiKey');
    expect(first).toBe('sk-ant-test-key');

    smMock.reset();
    smMock
      .on(GetSecretValueCommand, {
        SecretId: 'ethos/engineer/providers/anthropic/apiKey',
      })
      .rejects(new Error('should not be called'));

    const second = await resolver.get('providers/anthropic/apiKey');
    expect(second).toBe('sk-ant-test-key');
  });

  it('returns null on ResourceNotFoundException', async () => {
    const err = new Error('not found');
    err.name = 'ResourceNotFoundException';
    smMock.on(GetSecretValueCommand).rejects(err);

    expect(await resolver.get('missing/secret')).toBeNull();
  });

  it('propagates ThrottlingException as-is', async () => {
    const err = new Error('throttled');
    err.name = 'ThrottlingException';
    smMock.on(GetSecretValueCommand).rejects(err);

    await expect(resolver.get('some/ref')).rejects.toThrow('throttled');
    await expect(resolver.get('some/ref')).rejects.toMatchObject({
      name: 'ThrottlingException',
    });
  });

  it('throws actionable error on AccessDeniedException', async () => {
    const err = new Error('access denied');
    err.name = 'AccessDeniedException';
    smMock.on(GetSecretValueCommand).rejects(err);

    const result = resolver.get('some/ref');
    await expect(result).rejects.toThrow('AccessDeniedException for ethos/engineer/some/ref');
    await expect(resolver.get('some/ref')).rejects.toThrow(
      'See https://ethosagent.ai/docs/aws-secrets#iam-policy',
    );
  });

  it('throws credential error message when SDK throws CredentialsProviderError', async () => {
    const err = new Error('Could not load credentials');
    err.name = 'CredentialsProviderError';
    smMock.on(GetSecretValueCommand).rejects(err);

    await expect(resolver.get('some/ref')).rejects.toThrow('AWS Secrets Manager is enabled');
  });
});

describe('set', () => {
  it('writes via PutSecretValueCommand', async () => {
    smMock
      .on(PutSecretValueCommand, {
        SecretId: 'ethos/engineer/providers/anthropic/apiKey',
        SecretString: 'sk-ant-new',
      })
      .resolves({});

    await expect(resolver.set('providers/anthropic/apiKey', 'sk-ant-new')).resolves.toBeUndefined();
  });

  it('creates secret when it does not exist yet', async () => {
    const notFound = new Error('not found');
    notFound.name = 'ResourceNotFoundException';
    smMock.on(PutSecretValueCommand).rejectsOnce(notFound);
    smMock
      .on(CreateSecretCommand, {
        Name: 'ethos/engineer/providers/anthropic/apiKey',
        SecretString: 'sk-ant-new',
      })
      .resolves({});

    await expect(resolver.set('providers/anthropic/apiKey', 'sk-ant-new')).resolves.toBeUndefined();
  });

  it('throws actionable error on AccessDeniedException', async () => {
    const err = new Error('access denied');
    err.name = 'AccessDeniedException';
    smMock.on(PutSecretValueCommand).rejects(err);

    await expect(resolver.set('providers/anthropic/apiKey', 'val')).rejects.toThrow(
      'AccessDeniedException for ethos/engineer/providers/anthropic/apiKey',
    );
  });
});

describe('delete', () => {
  it('deletes via DeleteSecretCommand', async () => {
    smMock
      .on(DeleteSecretCommand, {
        SecretId: 'ethos/engineer/providers/anthropic/apiKey',
      })
      .resolves({});

    await expect(resolver.delete('providers/anthropic/apiKey')).resolves.toBeUndefined();
  });

  it('ignores ResourceNotFoundException (idempotent delete)', async () => {
    const notFound = new Error('not found');
    notFound.name = 'ResourceNotFoundException';
    smMock.on(DeleteSecretCommand).rejects(notFound);

    await expect(resolver.delete('providers/anthropic/apiKey')).resolves.toBeUndefined();
  });
});

describe('list', () => {
  it('returns refs with prefix stripped', async () => {
    smMock.on(ListSecretsCommand).resolves({
      SecretList: [
        { Name: 'ethos/engineer/providers/anthropic/apiKey' },
        { Name: 'ethos/engineer/channels/telegram/default/botToken' },
      ],
    });

    const refs = await resolver.list();
    expect(refs).toEqual(['providers/anthropic/apiKey', 'channels/telegram/default/botToken']);
  });

  it('returns empty array on AccessDeniedException', async () => {
    const err = new Error('access denied');
    err.name = 'AccessDeniedException';
    smMock.on(ListSecretsCommand).rejects(err);

    expect(await resolver.list()).toEqual([]);
  });
});

describe('SIGHUP', () => {
  it('clears the cache so next get re-fetches from SDK', async () => {
    smMock
      .on(GetSecretValueCommand, { SecretId: 'ethos/engineer/some/ref' })
      .resolves({ SecretString: 'value' });

    await resolver.get('some/ref');

    smMock.reset();
    smMock
      .on(GetSecretValueCommand, { SecretId: 'ethos/engineer/some/ref' })
      .resolves({ SecretString: 'new-value' });

    expect(await resolver.get('some/ref')).toBe('value');

    process.emit('SIGHUP' as NodeJS.Signals);

    expect(await resolver.get('some/ref')).toBe('new-value');
  });
});

describe('dispose', () => {
  it('removes SIGHUP listener so cache is not cleared after dispose', async () => {
    smMock
      .on(GetSecretValueCommand, { SecretId: 'ethos/engineer/some/ref' })
      .resolves({ SecretString: 'value' });

    await resolver.get('some/ref');

    smMock.reset();
    smMock
      .on(GetSecretValueCommand, { SecretId: 'ethos/engineer/some/ref' })
      .resolves({ SecretString: 'new-value' });

    resolver.dispose();

    process.emit('SIGHUP' as NodeJS.Signals);

    expect(await resolver.get('some/ref')).toBe('value');
  });
});
