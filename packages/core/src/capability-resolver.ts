import type {
  KeyValueStore,
  SecretRef,
  Storage,
  ToolCapabilities,
  ToolContext,
} from '@ethosagent/types';
import { ScopedFetchImpl } from './scoped/scoped-fetch';
import { ScopedFsImpl } from './scoped/scoped-fs';
import { ScopedProcessImpl } from './scoped/scoped-process';
import { ScopedSecretsImpl } from './scoped/scoped-secrets';

export interface CapabilityBackends {
  kvStoreFactory?: (tool: string, scopeId: string) => KeyValueStore;
  secretsBackend?: (ref: SecretRef) => Promise<string>;
  storage?: Storage;
  personalityFsReach?: { read: string[]; write: string[] };
  personalityNetworkAllow?: string[];
}

type ResolvedFields = Partial<
  Pick<ToolContext, 'kvStore' | 'secretsResolver' | 'scopedFetch' | 'scopedFs' | 'scopedProcess'>
>;

export function resolveCapabilities(
  toolName: string,
  capabilities: ToolCapabilities | undefined,
  scopeId: string,
  backends: CapabilityBackends,
): ResolvedFields {
  if (!capabilities) return {};

  const result: ResolvedFields = {};

  if (capabilities.network) {
    const declaredHosts = capabilities.network.allowedHosts;
    const hasInherit = declaredHosts.includes('*');
    const resolvedHosts = hasInherit
      ? new Set(backends.personalityNetworkAllow ?? [])
      : new Set(declaredHosts);
    result.scopedFetch = new ScopedFetchImpl(resolvedHosts);
  }

  if (capabilities.secrets && backends.secretsBackend) {
    result.secretsResolver = new ScopedSecretsImpl(
      new Set(capabilities.secrets),
      backends.secretsBackend,
    );
  }

  if (capabilities.storage && backends.kvStoreFactory) {
    const scope = capabilities.storage.scope;
    let resolvedScopeId: string;
    if (scope === 'tool-private') {
      resolvedScopeId = `tool:${toolName}`;
    } else if (scope === 'session') {
      resolvedScopeId = `session:${scopeId}`;
    } else {
      resolvedScopeId = `personality:${scopeId}`;
    }
    result.kvStore = backends.kvStoreFactory(toolName, resolvedScopeId);
  }

  if (capabilities.fs_reach && backends.storage) {
    const readDecl = capabilities.fs_reach.read;
    const writeDecl = capabilities.fs_reach.write;
    const readPaths =
      readDecl === 'from-personality'
        ? (backends.personalityFsReach?.read ?? [])
        : (readDecl ?? []);
    const writePaths =
      writeDecl === 'from-personality'
        ? (backends.personalityFsReach?.write ?? [])
        : (writeDecl ?? []);
    result.scopedFs = new ScopedFsImpl(backends.storage, new Set(readPaths), new Set(writePaths));
  }

  if (capabilities.process) {
    result.scopedProcess = new ScopedProcessImpl(new Set(capabilities.process.allowedBinaries));
  }

  return result;
}
