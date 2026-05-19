import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { SecretRef, SecretsResolver } from '@ethosagent/types';

export interface AwsSecretsManagerResolverConfig {
  region: string;
  prefix: string;
  endpoint?: string;
  client?: SecretsManagerClient;
}

const CREDENTIAL_ERROR = `AWS Secrets Manager is enabled (aws.secrets.enabled: true) but the AWS SDK
could not resolve any credentials. Confirm one of:
  - the EC2 instance has an IAM role attached (Actions -> Security -> Modify IAM role)
  - the ECS task definition has a taskRoleArn set
  - the EKS pod has an IAM role for service accounts (IRSA) annotation
See https://ethosagent.ai/docs/aws-secrets#iam-role for the canonical policy.`;

export class AwsSecretsManagerResolver implements SecretsResolver {
  private readonly region: string;
  private readonly prefix: string;
  private readonly endpoint: string | undefined;
  private readonly injectedClient: SecretsManagerClient | undefined;
  private lazyClient: SecretsManagerClient | undefined;
  private readonly cache = new Map<string, string>();
  private readonly onSighup: () => void;
  private credentialVerified = false;

  constructor(config: AwsSecretsManagerResolverConfig) {
    this.region = config.region;
    this.prefix = config.prefix;
    this.endpoint = config.endpoint;
    this.injectedClient = config.client;

    this.onSighup = () => this.cache.clear();
    process.on('SIGHUP', this.onSighup);
  }

  dispose(): void {
    process.removeListener('SIGHUP', this.onSighup);
  }

  async get(ref: SecretRef): Promise<string | null> {
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
    } catch (err: unknown) {
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

  async set(ref: SecretRef, value: string): Promise<void> {
    const key = this.secretId(ref);
    const client = this.getClient();

    try {
      try {
        await client.send(new PutSecretValueCommand({ SecretId: key, SecretString: value }));
      } catch (err: unknown) {
        if (isAwsError(err, 'ResourceNotFoundException')) {
          try {
            await client.send(new CreateSecretCommand({ Name: key, SecretString: value }));
          } catch (createErr: unknown) {
            if (isAwsError(createErr, 'ResourceExistsException')) {
              await client.send(new PutSecretValueCommand({ SecretId: key, SecretString: value }));
            } else {
              throw createErr;
            }
          }
        } else {
          throw err;
        }
      }
      this.cache.set(key, value);
      this.credentialVerified = true;
    } catch (err: unknown) {
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

  async delete(ref: SecretRef): Promise<void> {
    const key = this.secretId(ref);
    const client = this.getClient();

    try {
      await client.send(
        new DeleteSecretCommand({ SecretId: key, ForceDeleteWithoutRecovery: true }),
      );
      this.cache.delete(key);
      this.credentialVerified = true;
    } catch (err: unknown) {
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

  async list(prefix?: string): Promise<SecretRef[]> {
    const client = this.getClient();
    const filterPrefix = prefix ? `${this.prefix}/${prefix}` : `${this.prefix}/`;

    const refs: SecretRef[] = [];
    let nextToken: string | undefined;

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
    } catch (err: unknown) {
      if (isAwsError(err, 'AccessDeniedException')) {
        return [];
      }
      throw err;
    }

    return refs;
  }

  private getClient(): SecretsManagerClient {
    if (this.injectedClient) return this.injectedClient;
    if (!this.lazyClient) {
      this.lazyClient = new SecretsManagerClient({
        region: this.region,
        ...(this.endpoint ? { endpoint: this.endpoint } : {}),
      });
    }
    return this.lazyClient;
  }

  private secretId(ref: SecretRef): string {
    return `${this.prefix}/${ref}`;
  }

  private stripPrefix(name: string): SecretRef {
    const full = `${this.prefix}/`;
    return name.startsWith(full) ? name.slice(full.length) : name;
  }
}

function isAwsError(err: unknown, code: string): boolean {
  return err instanceof Error && 'name' in err && err.name === code;
}

function isCredentialError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  return (
    name === 'CredentialsProviderError' ||
    name === 'InvalidIdentityToken' ||
    name === 'ExpiredTokenException'
  );
}
