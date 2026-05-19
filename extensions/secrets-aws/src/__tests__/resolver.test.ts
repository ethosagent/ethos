import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  RestoreSecretCommand,
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
  it('calls PutSecretValue on existing ref and updates cache', async () => {
    smMock.on(PutSecretValueCommand).resolves({});

    await resolver.set('providers/anthropic/apiKey', 'new-key');

    const calls = smMock.commandCalls(PutSecretValueCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      SecretId: 'ethos/engineer/providers/anthropic/apiKey',
      SecretString: 'new-key',
    });

    // Cache updated — get should not call SDK
    smMock.on(GetSecretValueCommand).rejects(new Error('should not be called'));
    expect(await resolver.get('providers/anthropic/apiKey')).toBe('new-key');
  });

  it('handles CreateSecret ResourceExistsException by retrying PutSecretValue', async () => {
    const notFound = new Error('not found');
    notFound.name = 'ResourceNotFoundException';
    const exists = new Error('already exists');
    exists.name = 'ResourceExistsException';

    // First PutSecretValue fails (secret doesn't exist)
    // Then CreateSecret fails (race: another process created it)
    // Then retry PutSecretValue succeeds
    smMock.on(PutSecretValueCommand).rejectsOnce(notFound).resolves({});
    smMock.on(CreateSecretCommand).rejects(exists);

    await resolver.set('mcp/foo/access_token', 'xyz');

    expect(smMock.commandCalls(PutSecretValueCommand)).toHaveLength(2);
    expect(smMock.commandCalls(CreateSecretCommand)).toHaveLength(1);

    // Cache should still be updated
    smMock.on(GetSecretValueCommand).rejects(new Error('should not be called'));
    expect(await resolver.get('mcp/foo/access_token')).toBe('xyz');
  });

  it('falls back to CreateSecret on ResourceNotFoundException from PutSecretValue', async () => {
    const notFound = new Error('not found');
    notFound.name = 'ResourceNotFoundException';
    smMock.on(PutSecretValueCommand).rejects(notFound);
    smMock.on(CreateSecretCommand).resolves({});

    await resolver.set('mcp/foo/access_token', 'xyz');

    expect(smMock.commandCalls(PutSecretValueCommand)).toHaveLength(1);
    const createCalls = smMock.commandCalls(CreateSecretCommand);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].args[0].input).toEqual({
      Name: 'ethos/engineer/mcp/foo/access_token',
      SecretString: 'xyz',
    });

    // Cache contains the new value
    smMock.on(GetSecretValueCommand).rejects(new Error('should not be called'));
    expect(await resolver.get('mcp/foo/access_token')).toBe('xyz');
  });

  it('restores a scheduled-for-deletion secret and writes the new value', async () => {
    const invalidReq = new Error('secret scheduled for deletion');
    invalidReq.name = 'InvalidRequestException';

    smMock.on(PutSecretValueCommand).rejectsOnce(invalidReq).resolves({});
    smMock.on(RestoreSecretCommand).resolves({});

    await resolver.set('mcp/foo/access_token', 'new-token');

    expect(smMock.commandCalls(RestoreSecretCommand)).toHaveLength(1);
    expect(smMock.commandCalls(RestoreSecretCommand)[0].args[0].input).toEqual({
      SecretId: 'ethos/engineer/mcp/foo/access_token',
    });
    expect(smMock.commandCalls(PutSecretValueCommand)).toHaveLength(2);

    // Cache updated
    smMock.on(GetSecretValueCommand).rejects(new Error('should not be called'));
    expect(await resolver.get('mcp/foo/access_token')).toBe('new-token');
  });

  it('throws on AccessDeniedException with IAM remediation pointer', async () => {
    const err = new Error('access denied');
    err.name = 'AccessDeniedException';
    smMock.on(PutSecretValueCommand).rejects(err);

    await expect(resolver.set('some/ref', 'val')).rejects.toThrow(
      'AccessDeniedException for ethos/engineer/some/ref',
    );
    await expect(resolver.set('some/ref', 'val')).rejects.toThrow(
      'See https://ethosagent.ai/docs/aws-secrets#iam-policy',
    );
  });

  it('throws credential error on first set() call when creds are missing', async () => {
    const err = new Error('Could not load credentials');
    err.name = 'CredentialsProviderError';
    smMock.on(PutSecretValueCommand).rejects(err);

    await expect(resolver.set('some/ref', 'val')).rejects.toThrow('AWS Secrets Manager is enabled');
  });

  it('round-trip: set then get returns cached value without SDK call', async () => {
    smMock.on(PutSecretValueCommand).resolves({});

    await resolver.set('mcp/foo/access_token', 'xyz');

    smMock.reset();
    smMock.on(GetSecretValueCommand).rejects(new Error('should not be called'));

    expect(await resolver.get('mcp/foo/access_token')).toBe('xyz');
  });
});

describe('delete', () => {
  it('calls DeleteSecret on existing ref and invalidates cache', async () => {
    // Pre-populate cache via get
    smMock
      .on(GetSecretValueCommand, { SecretId: 'ethos/engineer/some/ref' })
      .resolves({ SecretString: 'val' });
    await resolver.get('some/ref');

    smMock.on(DeleteSecretCommand).resolves({});

    await resolver.delete('some/ref');

    expect(smMock.commandCalls(DeleteSecretCommand)).toHaveLength(1);
    expect(smMock.commandCalls(DeleteSecretCommand)[0].args[0].input).toEqual({
      SecretId: 'ethos/engineer/some/ref',
    });

    // Cache cleared — get should re-fetch
    smMock.reset();
    smMock
      .on(GetSecretValueCommand, { SecretId: 'ethos/engineer/some/ref' })
      .resolves({ SecretString: 'refetched' });
    expect(await resolver.get('some/ref')).toBe('refetched');
  });

  it('swallows ResourceNotFoundException (idempotent delete)', async () => {
    const err = new Error('not found');
    err.name = 'ResourceNotFoundException';
    smMock.on(DeleteSecretCommand).rejects(err);

    await expect(resolver.delete('missing/ref')).resolves.toBeUndefined();
  });

  it('throws on AccessDeniedException', async () => {
    const err = new Error('access denied');
    err.name = 'AccessDeniedException';
    smMock.on(DeleteSecretCommand).rejects(err);

    await expect(resolver.delete('some/ref')).rejects.toThrow(
      'AccessDeniedException for ethos/engineer/some/ref',
    );
  });

  it('throws credential error on first delete() call when creds are missing', async () => {
    const err = new Error('Could not load credentials');
    err.name = 'CredentialsProviderError';
    smMock.on(DeleteSecretCommand).rejects(err);

    await expect(resolver.delete('some/ref')).rejects.toThrow('AWS Secrets Manager is enabled');
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
