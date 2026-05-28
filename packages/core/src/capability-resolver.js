import { ScopedAttachmentsImpl } from './scoped/scoped-attachments';
import { ScopedFetchImpl } from './scoped/scoped-fetch';
import { ScopedFsImpl } from './scoped/scoped-fs';
import { ScopedProcessImpl } from './scoped/scoped-process';
import { ScopedSecretsImpl } from './scoped/scoped-secrets';
export function resolveCapabilities(toolName, capabilities, scopeIds, backends) {
    if (!capabilities)
        return {};
    const result = {};
    if (capabilities.network) {
        const declaredHosts = capabilities.network.allowedHosts;
        const policy = backends.personalityNetworkPolicy ?? {};
        const personalityAllow = policy.allow;
        let resolvedHosts;
        if (declaredHosts.includes('*')) {
            resolvedHosts = new Set(personalityAllow ?? []);
        }
        else if (personalityAllow) {
            // Intersect: only keep declared hosts covered by a personality pattern
            resolvedHosts = new Set(declaredHosts.filter((host) => personalityAllow.some((pattern) => {
                if (pattern === host || pattern === '*')
                    return true;
                if (pattern.startsWith('*.')) {
                    const suffix = pattern.slice(1);
                    return host.endsWith(suffix) && host.length > suffix.length;
                }
                return false;
            })));
        }
        else {
            resolvedHosts = new Set(declaredHosts);
        }
        result.scopedFetch = new ScopedFetchImpl(resolvedHosts, policy);
    }
    if (capabilities.secrets && backends.secretsBackend) {
        result.secretsResolver = new ScopedSecretsImpl(new Set(capabilities.secrets), backends.secretsBackend);
    }
    if (capabilities.storage && backends.kvStoreFactory) {
        const scope = capabilities.storage.scope;
        let resolvedScopeId;
        if (scope === 'tool-private') {
            resolvedScopeId = `tool:${toolName}`;
        }
        else if (scope === 'session') {
            resolvedScopeId = `session:${scopeIds.sessionId}`;
        }
        else {
            resolvedScopeId = `personality:${scopeIds.personalityId ?? scopeIds.sessionId}`;
        }
        result.kvStore = backends.kvStoreFactory(toolName, resolvedScopeId);
    }
    if (capabilities.fs_reach && backends.storage) {
        const readDecl = capabilities.fs_reach.read;
        const writeDecl = capabilities.fs_reach.write;
        const readPaths = readDecl === 'from-personality'
            ? (backends.personalityFsReach?.read ?? [])
            : (readDecl ?? []);
        const writePaths = writeDecl === 'from-personality'
            ? (backends.personalityFsReach?.write ?? [])
            : (writeDecl ?? []);
        result.scopedFs = new ScopedFsImpl(backends.storage, new Set(readPaths), new Set(writePaths));
    }
    if (capabilities.process) {
        result.scopedProcess = new ScopedProcessImpl(new Set(capabilities.process.allowedBinaries));
    }
    if (capabilities.attachments && backends.attachmentCache && backends.inboundAttachments) {
        result.attachments = new ScopedAttachmentsImpl(backends.inboundAttachments, capabilities.attachments.kinds, backends.attachmentCache);
        // Per-turn reach extension: merge attachment cache directories into
        // ScopedFs read paths so tools using file_path (back-compat) can read
        // cached attachment files through the normal ScopedFs path.
        const attachmentDirs = new Set();
        for (const att of backends.inboundAttachments) {
            if (att.url.startsWith('file://')) {
                const localPath = backends.attachmentCache.resolveLocalPath(att.url);
                const dir = localPath.slice(0, localPath.lastIndexOf('/'));
                if (dir)
                    attachmentDirs.add(dir);
            }
        }
        if (attachmentDirs.size > 0) {
            if (result.scopedFs && backends.storage) {
                // Reconstruct with merged read paths
                const readDecl = capabilities.fs_reach?.read;
                const readPaths = readDecl === 'from-personality'
                    ? (backends.personalityFsReach?.read ?? [])
                    : (readDecl ?? []);
                const writeDecl = capabilities.fs_reach?.write;
                const writePaths = writeDecl === 'from-personality'
                    ? (backends.personalityFsReach?.write ?? [])
                    : (writeDecl ?? []);
                const mergedRead = new Set([...readPaths, ...attachmentDirs]);
                result.scopedFs = new ScopedFsImpl(backends.storage, mergedRead, new Set(writePaths));
            }
            else if (!result.scopedFs && backends.storage) {
                // No fs_reach declared but attachments present — create read-only ScopedFs
                result.scopedFs = new ScopedFsImpl(backends.storage, attachmentDirs, new Set());
            }
        }
    }
    return result;
}
