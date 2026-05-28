import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  RestoreSecretCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

const CREDENTIAL_ERROR = `AWS Secrets Manager is enabled (aws.secrets.enabled: true) but the AWS SDK
could not resolve any credentials. Confirm one of:
  - the EC2 instance has an IAM role attached (Actions -> Security -> Modify IAM role)
  - the ECS task definition has a taskRoleArn set
  - the EKS pod has an IAM role for service accounts (IRSA) annotation
See https://ethosagent.ai/docs/aws-secrets#iam-role for the canonical policy.`;
export class AwsSecretsManagerResolver {
  region;
  prefix;
  endpoint;
  injectedClient;
  lazyClient;
  cache = new Map();
  onSighup;
  credentialVerified = false;
  constructor(config) {
    this.region = config.region;
    this.prefix = config.prefix;
    this.endpoint = config.endpoint;
    this.injectedClient = config.client;
    this.onSighup = () => this.cache.clear();
    process.on('SIGHUP', this.onSighup);
  }
  dispose() {
    process.removeListener('SIGHUP', this.onSighup);
  }
  async get(ref) {
    const key = this.secretId(ref);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const client = this.getClient();
    try {
      const result = await client.send(new GetSecretValueCommand({ SecretId: key }));
      const value = result.SecretString ?? null;
      if (value !== null) {
        this.cache.set(key, value);
      }
      this.credentialVerified = true;
      return value;
    } catch (err) {
      if (isAwsError(err, 'ResourceNotFoundException')) {
        this.credentialVerified = true;
        return null;
      }
      if (isAwsError(err, 'AccessDeniedException')) {
        this.credentialVerified = true;
        throw new Error(
          `AWS Secrets Manager GetSecretValue failed: AccessDeniedException for ${key}. ` +
            `Confirm the IAM policy allows secretsmanager:GetSecretValue on ${this.prefix}/*. ` +
            `See https://ethosagent.ai/docs/aws-secrets#iam-policy.`,
        );
      }
      if (!this.credentialVerified && isCredentialError(err)) {
        throw new Error(CREDENTIAL_ERROR);
      }
      throw err;
    }
  }
  async set(ref, value) {
    const key = this.secretId(ref);
    const client = this.getClient();
    try {
      try {
        await client.send(new PutSecretValueCommand({ SecretId: key, SecretString: value }));
      } catch (err) {
        if (isAwsError(err, 'ResourceNotFoundException')) {
          try {
            await client.send(new CreateSecretCommand({ Name: key, SecretString: value }));
          } catch (createErr) {
            if (isAwsError(createErr, 'ResourceExistsException')) {
              await client.send(new PutSecretValueCommand({ SecretId: key, SecretString: value }));
            } else {
              throw createErr;
            }
          }
        } else if (isAwsError(err, 'InvalidRequestException')) {
          await client.send(new RestoreSecretCommand({ SecretId: key }));
          await client.send(new PutSecretValueCommand({ SecretId: key, SecretString: value }));
        } else {
          throw err;
        }
      }
      this.cache.set(key, value);
      this.credentialVerified = true;
    } catch (err) {
      if (isAwsError(err, 'AccessDeniedException')) {
        this.credentialVerified = true;
        throw new Error(
          `AWS Secrets Manager write failed: AccessDeniedException for ${key}. ` +
            `Confirm the IAM policy allows secretsmanager:PutSecretValue and secretsmanager:CreateSecret on ${this.prefix}/*. ` +
            `See https://ethosagent.ai/docs/aws-secrets#iam-policy.`,
        );
      }
      if (!this.credentialVerified && isCredentialError(err)) {
        throw new Error(CREDENTIAL_ERROR);
      }
      throw err;
    }
  }
  async delete(ref) {
    const key = this.secretId(ref);
    const client = this.getClient();
    try {
      await client.send(new DeleteSecretCommand({ SecretId: key }));
      this.cache.delete(key);
      this.credentialVerified = true;
    } catch (err) {
      if (isAwsError(err, 'ResourceNotFoundException')) {
        this.credentialVerified = true;
        this.cache.delete(key);
        return;
      }
      if (isAwsError(err, 'AccessDeniedException')) {
        this.credentialVerified = true;
        throw new Error(
          `AWS Secrets Manager delete failed: AccessDeniedException for ${key}. ` +
            `Confirm the IAM policy allows secretsmanager:DeleteSecret on ${this.prefix}/*. ` +
            `See https://ethosagent.ai/docs/aws-secrets#iam-policy.`,
        );
      }
      if (!this.credentialVerified && isCredentialError(err)) {
        throw new Error(CREDENTIAL_ERROR);
      }
      throw err;
    }
  }
  async list(prefix) {
    const client = this.getClient();
    const filterPrefix = prefix ? `${this.prefix}/${prefix}` : `${this.prefix}/`;
    const refs = [];
    let nextToken;
    try {
      do {
        const result = await client.send(
          new ListSecretsCommand({
            Filters: [{ Key: 'name', Values: [filterPrefix] }],
            NextToken: nextToken,
          }),
        );
        for (const entry of result.SecretList ?? []) {
          const name = entry.Name;
          if (name) {
            refs.push(this.stripPrefix(name));
          }
        }
        nextToken = result.NextToken;
      } while (nextToken);
    } catch (err) {
      if (isAwsError(err, 'AccessDeniedException')) {
        return [];
      }
      throw err;
    }
    return refs;
  }
  getClient() {
    if (this.injectedClient) return this.injectedClient;
    if (!this.lazyClient) {
      this.lazyClient = new SecretsManagerClient({
        region: this.region,
        ...(this.endpoint ? { endpoint: this.endpoint } : {}),
      });
    }
    return this.lazyClient;
  }
  secretId(ref) {
    return `${this.prefix}/${ref}`;
  }
  stripPrefix(name) {
    const full = `${this.prefix}/`;
    return name.startsWith(full) ? name.slice(full.length) : name;
  }
}
function isAwsError(err, code) {
  return err instanceof Error && 'name' in err && err.name === code;
}
function isCredentialError(err) {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  return (
    name === 'CredentialsProviderError' ||
    name === 'InvalidIdentityToken' ||
    name === 'ExpiredTokenException'
  );
}
