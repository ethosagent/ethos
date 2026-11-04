import type { EthosPluginApi } from '@ethosagent/plugin-sdk';
import type {
  PersonalityConfig,
  PluginPageSpec,
  PluginRendererSpec,
  ToolCapabilities,
} from '@ethosagent/types';
import type { Registration, ToolRegistration } from './protocol';
import { isRecord, isStringArray } from './util';

function strings(value: unknown): string[] | null {
  return isStringArray(value) ? value : null;
}

export function isPersonalityConfig(raw: unknown): raw is PersonalityConfig {
  return isRecord(raw) && typeof raw.id === 'string' && typeof raw.name === 'string';
}

export function isPageSpec(raw: unknown): raw is PluginPageSpec {
  return isRecord(raw) && typeof raw.title === 'string' && Array.isArray(raw.sections);
}

export function isRendererSpec(raw: unknown): raw is PluginRendererSpec {
  return isRecord(raw) && typeof raw.type === 'string';
}

export type OAuthProfile = Parameters<EthosPluginApi['registerOAuthProfile']>[0];

export function isOAuthProfile(raw: unknown): raw is OAuthProfile {
  return (
    isRecord(raw) &&
    typeof raw.id === 'string' &&
    isRecord(raw.flow) &&
    typeof raw.flow.kind === 'string'
  );
}

const DATA_VALIDATORS: Record<string, (raw: unknown) => boolean> = {
  personality: isPersonalityConfig,
  oauth_profile: isOAuthProfile,
  page: isPageSpec,
  renderer: isRendererSpec,
};

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
  return parseOtherRegistration(raw);
}

const str = (v: unknown): v is string => typeof v === 'string';
const idx = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The non-tool, non-hook rows. Every field is checked: the child is untrusted input. */
function parseOtherRegistration(raw: Record<string, unknown>): Registration | null {
  switch (raw.kind) {
    case 'injector':
      return idx(raw.index) && str(raw.id) && typeof raw.priority === 'number'
        ? { kind: 'injector', index: raw.index, id: raw.id, priority: raw.priority }
        : null;
    case 'filter': {
      const toolName = str(raw.toolName) ? raw.toolName : strings(raw.toolName);
      if (!idx(raw.index)) return null;
      return {
        kind: 'filter',
        index: raw.index,
        ...(toolName ? { toolName } : {}),
        ...(str(raw.toolset) ? { toolset: raw.toolset } : {}),
        before: raw.before === true,
        after: raw.after === true,
      };
    }
    case 'evaluator':
      return idx(raw.index) && str(raw.name)
        ? { kind: 'evaluator', index: raw.index, name: raw.name }
        : null;
    case 'route':
      return idx(raw.index) && str(raw.method) && str(raw.path) && raw.path.startsWith('/')
        ? { kind: 'route', index: raw.index, method: raw.method, path: raw.path }
        : null;
    case 'health_check':
      return idx(raw.index) && str(raw.name) && str(raw.description)
        ? {
            kind: 'health_check',
            index: raw.index,
            name: raw.name,
            description: raw.description,
          }
        : null;
    case 'slash':
      return str(raw.name) && str(raw.description) && str(raw.usage)
        ? { kind: 'slash', name: raw.name, description: raw.description, usage: raw.usage }
        : null;
    case 'cli':
      return str(raw.name) && str(raw.description)
        ? { kind: 'cli', name: raw.name, description: raw.description }
        : null;
    case 'extractor': {
      const mimeTypes = strings(raw.mimeTypes);
      return idx(raw.index) && str(raw.name) && mimeTypes
        ? {
            kind: 'extractor',
            index: raw.index,
            name: raw.name,
            mimeTypes,
            ...(typeof raw.maxInputBytes === 'number' ? { maxInputBytes: raw.maxInputBytes } : {}),
          }
        : null;
    }
    case 'data_source':
      return str(raw.id) && str(raw.path)
        ? { kind: 'data_source', id: raw.id, path: raw.path }
        : null;
    case 'personality':
    case 'oauth_profile':
    case 'page':
    case 'renderer':
      return isRecord(raw.data) && DATA_VALIDATORS[raw.kind]?.(raw.data)
        ? { kind: raw.kind, data: raw.data }
        : null;
    default:
      return null;
  }
}
