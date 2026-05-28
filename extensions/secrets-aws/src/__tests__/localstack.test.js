import {
  CreateSecretCommand,
  DeleteSecretCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { afterEach, describe, expect, it } from 'vitest';
import { AwsSecretsManagerResolver } from '../index';

const ENDPOINT = process.env.LOCALSTACK_ENDPOINT;
describe.skipIf(!ENDPOINT)('AwsSecretsManagerResolver (LocalStack)', () => {
  const region = 'us-east-1';
  const prefix = 'ethos/localstack-test';
  const secretName = `${prefix}/providers/test/apiKey`;
  const secretValue = 'sk-test-localstack-value';
  let client;
  let resolver;
  afterEach(async () => {
    resolver?.dispose();
    if (client) {
      try {
        await client.send(
          new DeleteSecretCommand({
            SecretId: secretName,
            ForceDeleteWithoutRecovery: true,
          }),
        );
      } catch {
        // ignore — secret may not exist
      }
    }
  });
  it('creates a secret and reads it back through the resolver', async () => {
    client = new SecretsManagerClient({
      region,
      endpoint: ENDPOINT,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await client.send(
      new CreateSecretCommand({
        Name: secretName,
        SecretString: secretValue,
      }),
    );
    resolver = new AwsSecretsManagerResolver({
      region,
      prefix,
      endpoint: ENDPOINT,
      client,
    });
    const result = await resolver.get('providers/test/apiKey');
    expect(result).toBe(secretValue);
  });
  it('returns null for a missing secret', async () => {
    client = new SecretsManagerClient({
      region,
      endpoint: ENDPOINT,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    resolver = new AwsSecretsManagerResolver({
      region,
      prefix,
      endpoint: ENDPOINT,
      client,
    });
    const result = await resolver.get('providers/nonexistent/apiKey');
    expect(result).toBeNull();
  });
  it('lists secrets under the prefix', async () => {
    client = new SecretsManagerClient({
      region,
      endpoint: ENDPOINT,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await client.send(
      new CreateSecretCommand({
        Name: secretName,
        SecretString: secretValue,
      }),
    );
    resolver = new AwsSecretsManagerResolver({
      region,
      prefix,
      endpoint: ENDPOINT,
      client,
    });
    const refs = await resolver.list();
    expect(refs).toContain('providers/test/apiKey');
  });
  it('set() creates a secret and reads it back', async () => {
    client = new SecretsManagerClient({
      region,
      endpoint: ENDPOINT,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    resolver = new AwsSecretsManagerResolver({
      region,
      prefix,
      endpoint: ENDPOINT,
      client,
    });
    await resolver.set('providers/test/apiKey', secretValue);
    const result = await resolver.get('providers/test/apiKey');
    expect(result).toBe(secretValue);
  });
  it('set() updates an existing secret', async () => {
    client = new SecretsManagerClient({
      region,
      endpoint: ENDPOINT,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    resolver = new AwsSecretsManagerResolver({
      region,
      prefix,
      endpoint: ENDPOINT,
      client,
    });
    await resolver.set('providers/test/apiKey', 'first-value');
    await resolver.set('providers/test/apiKey', 'second-value');
    const result = await resolver.get('providers/test/apiKey');
    expect(result).toBe('second-value');
  });
  it('delete() removes a secret and allows re-creation', async () => {
    client = new SecretsManagerClient({
      region,
      endpoint: ENDPOINT,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    resolver = new AwsSecretsManagerResolver({
      region,
      prefix,
      endpoint: ENDPOINT,
      client,
    });
    await resolver.set('providers/test/apiKey', secretValue);
    await resolver.delete('providers/test/apiKey');
    // Clear cache by creating a new resolver
    resolver.dispose();
    resolver = new AwsSecretsManagerResolver({
      region,
      prefix,
      endpoint: ENDPOINT,
      client,
    });
    expect(await resolver.get('providers/test/apiKey')).toBeNull();
    // Re-creation must succeed (not blocked by scheduled deletion)
    await resolver.set('providers/test/apiKey', 'recreated-value');
    expect(await resolver.get('providers/test/apiKey')).toBe('recreated-value');
  });
});
