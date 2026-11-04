import type { ToolCapabilities } from '@ethosagent/types';
import type { Registration, ToolRegistration } from './protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : null;
}

/**
 * Rebuilds `ToolCapabilities` from an untrusted wire object, copying only the
 * known fields. `process` is dropped: a hosted tool's subprocesses run
 * host-local (D20), never spawned by the parent on its behalf.
 */
export function parseCapabilities(raw: unknown): ToolCapabilities {
  const out: ToolCapabilities = {};
  if (!isRecord(raw)) return out;
  const hosts = isRecord(raw.network) ? strings(raw.network.allowedHosts) : null;
  if (hosts) out.network = { allowedHosts: hosts };
  const secrets = strings(raw.secrets);
  if (secrets) out.secrets = secrets;
  const st = raw.storage;
  if (
    isRecord(st) &&
    (st.scope === 'tool-private' || st.scope === 'session' || st.scope === 'personality') &&
    st.kind === 'kv'
  ) {
    out.storage = {
      scope: st.scope,
      kind: 'kv',
      ...(typeof st.ttlSecondsDefault === 'number'
        ? { ttlSecondsDefault: st.ttlSecondsDefault }
        : {}),
    };
  }
  if (isRecord(raw.fs_reach)) {
    const reach = (v: unknown): string[] | 'from-personality' | undefined =>
      v === 'from-personality' ? v : (strings(v) ?? undefined);
    const read = reach(raw.fs_reach.read);
    const write = reach(raw.fs_reach.write);
    out.fs_reach = { ...(read ? { read } : {}), ...(write ? { write } : {}) };
  }
  if (isRecord(raw.attachments)) {
    const kinds = raw.attachments.kinds;
    if (kinds === '*') out.attachments = { kinds: '*' };
    else if (Array.isArray(kinds) && kinds.every((k) => k === 'image' || k === 'file')) {
      out.attachments = {
        kinds: kinds.filter((k): k is 'image' | 'file' => k === 'image' || k === 'file'),
      };
    }
  }
  return out;
}

export function parseToolRegistration(raw: Record<string, unknown>): ToolRegistration | null {
  if (typeof raw.name !== 'string' || raw.name === '') return null;
  const reg: ToolRegistration = {
    kind: 'tool',
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    schema: isRecord(raw.schema) ? raw.schema : { type: 'object', properties: {} },
    capabilities: parseCapabilities(raw.capabilities),
    available: raw.available !== false,
  };
  if (typeof raw.toolset === 'string') reg.toolset = raw.toolset;
  if (typeof raw.maxResultChars === 'number') reg.maxResultChars = raw.maxResultChars;
  if (typeof raw.requiresApproval === 'boolean') reg.requiresApproval = raw.requiresApproval;
  if (typeof raw.returnDirect === 'boolean') reg.returnDirect = raw.returnDirect;
  if (isRecord(raw.outputSchema)) reg.outputSchema = raw.outputSchema;
  if (typeof raw.preferredModel === 'string') reg.preferredModel = raw.preferredModel;
  if (typeof raw.strict === 'boolean') reg.strict = raw.strict;
  if (typeof raw.settingsKey === 'string') reg.settingsKey = raw.settingsKey;
  return reg;
}

/** One registration off the wire, or null when it is not a shape we replay. */
export function parseRegistration(raw: unknown): Registration | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === 'tool') return parseToolRegistration(raw);
  if (
    raw.kind === 'hook' &&
    typeof raw.name === 'string' &&
    (raw.model === 'void' || raw.model === 'modifying')
  ) {
    return { kind: 'hook', model: raw.model, name: raw.name };
  }
  return null;
}
