import { basename, join } from 'node:path';
import type { Attachment, Storage, ToolProgressEvent } from '@ethosagent/types';
import { type HandlerTable, RpcError } from './connection';
import { HOST_ERROR } from './errors';
import type { HostEventSink } from './events';
import type { LiveCall } from './handles';
import type { HandlerContext } from './host-types';
import type { CallHandle } from './protocol';
import { MAX_FRAME_BYTES, RPC_ERROR } from './protocol';
import { decodeBytes, encodeBytes, isRecord } from './util';

/** Refuses a secret ref the plugin may not touch. Lane C replaces the default (`secrets.ts`). */
export type SecretRefAuthorizer = (
  pluginId: string,
  ref: string,
  op: 'get' | 'set' | 'list' | 'capability',
) => boolean;

export interface CapabilityDeps {
  /** Unscoped parent storage: used only to copy an attachment into the host's per-call dir. */
  storage: Storage;
  hostHome: (pluginId: string) => string;
  authorizeSecretRef: SecretRefAuthorizer;
  onEvent: HostEventSink;
}

const bad = (message: string): RpcError => new RpcError(RPC_ERROR.invalidParams, message);

function str(args: unknown[], i: number, what: string): string {
  const v = args[i];
  if (typeof v !== 'string') throw bad(`${what}: argument ${i} must be a string`);
  return v;
}

function content(args: unknown[], i: number): string | Uint8Array {
  const v = decodeBytes(args[i]);
  if (typeof v === 'string' || v instanceof Uint8Array) return v;
  throw bad(`argument ${i} must be a string or bytes`);
}

function opts<T extends object>(
  args: unknown[],
  i: number,
  pick: (r: Record<string, unknown>) => T,
): T | undefined {
  const v = args[i];
  return isRecord(v) ? pick(v) : undefined;
}

/**
 * Serves `ethos/capability.*` from the call's own live handles (plan §5.6).
 * A handle that is unknown, revoked, or issued to another host is refused with
 * PLUGIN_HOST_HANDLE_REVOKED and recorded as `plugin_host.denied`; a call that
 * lacks the requested handle (no `kvStore` declared, say) answers
 * PLUGIN_HOST_CAPABILITY_UNAVAILABLE.
 */
export function createCapabilityHandlers(ctx: HandlerContext, deps: CapabilityDeps): HandlerTable {
  const { pluginId, handles } = ctx;

  const deny = (method: string): never => {
    deps.onEvent('plugin_host.denied', { plugin_id: pluginId, kind: 'handle', ref: method });
    throw new RpcError(
      RPC_ERROR.denied,
      `${HOST_ERROR.handleRevoked}: '${method}' used a call handle that is not live`,
      { code: HOST_ERROR.handleRevoked },
    );
  };

  const live = (method: string, params: unknown): { live: LiveCall; call: CallHandle } => {
    if (!isRecord(params)) throw bad(`${method} needs params`);
    const found = handles.get(params.call);
    if (!found || typeof params.call !== 'string') return deny(method);
    return { live: found, call: params.call };
  };

  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) {
      throw new RpcError(
        RPC_ERROR.handlerFailed,
        `${HOST_ERROR.capabilityUnavailable}: this call has no ${what}`,
        { code: HOST_ERROR.capabilityUnavailable },
      );
    }
    return value;
  };

  const opAndArgs = (
    method: string,
    params: unknown,
  ): { live: LiveCall; call: CallHandle; op: string; args: unknown[] } => {
    const l = live(method, params);
    if (!isRecord(params) || typeof params.op !== 'string' || !Array.isArray(params.args)) {
      throw bad(`${method} needs op and args`);
    }
    return { ...l, op: params.op, args: params.args };
  };

  return {
    'ethos/capability.storage': async (params) => {
      const { live: l, op, args } = opAndArgs('ethos/capability.storage', params);
      const s = need(l.storage, 'storage');
      switch (op) {
        case 'read':
          return s.read(str(args, 0, op));
        case 'readBytes':
          return encodeBytes(await s.readBytes(str(args, 0, op)));
        case 'exists':
          return s.exists(str(args, 0, op));
        case 'mtime':
          return s.mtime(str(args, 0, op));
        case 'list':
          return s.list(str(args, 0, op));
        case 'listEntries':
          return s.listEntries(str(args, 0, op));
        case 'write':
          return s.write(
            str(args, 0, op),
            content(args, 1),
            opts(args, 2, (r) => (typeof r.mode === 'number' ? { mode: r.mode } : {})),
          );
        case 'append':
          return s.append(str(args, 0, op), str(args, 1, op));
        case 'writeAtomic':
          return s.writeAtomic(
            str(args, 0, op),
            content(args, 1),
            opts(args, 2, (r) => (typeof r.mode === 'number' ? { mode: r.mode } : {})),
          );
        case 'mkdir':
          return s.mkdir(str(args, 0, op));
        case 'remove':
          return s.remove(
            str(args, 0, op),
            opts(args, 1, (r) => (r.recursive === true ? { recursive: true } : {})),
          );
        case 'rename':
          return s.rename(str(args, 0, op), str(args, 1, op));
        case 'chmod': {
          const mode = args[1];
          if (typeof mode !== 'number') throw bad('chmod: argument 1 must be a number');
          return s.chmod(str(args, 0, op), mode);
        }
        default:
          throw bad(`unknown storage op '${op}'`);
      }
    },

    'ethos/capability.kv': async (params) => {
      const { live: l, op, args } = opAndArgs('ethos/capability.kv', params);
      const kv = need(l.kvStore, 'kvStore (declare capabilities.storage)');
      switch (op) {
        case 'get':
          return kv.get(str(args, 0, op));
        case 'set':
          return kv.set(
            str(args, 0, op),
            str(args, 1, op),
            opts(args, 2, (r) =>
              typeof r.ttlSeconds === 'number' ? { ttlSeconds: r.ttlSeconds } : {},
            ),
          );
        case 'delete':
          return kv.delete(str(args, 0, op));
        case 'list':
          return kv.list(str(args, 0, op));
        default:
          throw bad(`unknown kv op '${op}'`);
      }
    },

    'ethos/capability.secret': async (params) => {
      const { live: l, op, args } = opAndArgs('ethos/capability.secret', params);
      if (op !== 'get') throw bad(`unknown secret op '${op}'`);
      const ref = str(args, 0, op);
      if (!deps.authorizeSecretRef(pluginId, ref, 'capability')) {
        deps.onEvent('plugin_host.denied', { plugin_id: pluginId, kind: 'secret', ref });
        throw new RpcError(
          RPC_ERROR.denied,
          `${HOST_ERROR.secretDenied}: '${ref}' is not a secret this plugin may read`,
          {
            code: HOST_ERROR.secretDenied,
          },
        );
      }
      return need(l.secretsResolver, 'secretsResolver (declare capabilities.secrets)').get(ref);
    },

    'ethos/capability.fetch': async (params) => {
      const { live: l, call: _call } = live('ethos/capability.fetch', params);
      if (!isRecord(params) || !Array.isArray(params.args)) throw bad('fetch needs args');
      const fetcher = need(l.scopedFetch, 'scopedFetch (declare capabilities.network)');
      const url = str(params.args, 0, 'fetch');
      const init = isRecord(params.args[1]) ? params.args[1] : {};
      const headers: Record<string, string> = {};
      if (isRecord(init.headers)) {
        for (const [k, v] of Object.entries(init.headers))
          if (typeof v === 'string') headers[k] = v;
      }
      const body = decodeBytes(init.body);
      const request: RequestInit = { headers };
      if (typeof init.method === 'string') request.method = init.method;
      if (typeof body === 'string') request.body = body;
      else if (body instanceof Uint8Array) request.body = new Uint8Array(body);
      if (l.abortSignal) request.signal = l.abortSignal;
      const response = await fetcher.fetch(url, request);
      const bytes = await readCapped(response);
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        bodyBase64: Buffer.from(bytes).toString('base64'),
      };
    },

    'ethos/capability.fs': async (params) => {
      const { live: l, op, args } = opAndArgs('ethos/capability.fs', params);
      const fs = need(l.scopedFs, 'scopedFs (declare capabilities.fs_reach)');
      switch (op) {
        case 'read':
          return fs.read(str(args, 0, op));
        case 'readBytes':
          return encodeBytes(await fs.readBytes(str(args, 0, op)));
        case 'write':
          return fs.write(str(args, 0, op), content(args, 1));
        case 'exists':
          return fs.exists(str(args, 0, op));
        case 'list':
          return fs.list(str(args, 0, op));
        case 'mtime':
          return fs.mtime(str(args, 0, op));
        case 'mkdir':
          return fs.mkdir(str(args, 0, op));
        case 'listEntries':
          return fs.listEntries(str(args, 0, op));
        default:
          throw bad(`unknown fs op '${op}'`);
      }
    },

    'ethos/capability.attachments': async (params) => {
      const { live: l, call, op, args } = opAndArgs('ethos/capability.attachments', params);
      const att = need(l.attachments, 'attachments (declare capabilities.attachments)');
      let opened: { path: string };
      if (op === 'open') opened = await att.open(toAttachment(args[0]));
      else if (op === 'openByRef') opened = await att.openByRef(str(args, 0, op));
      else throw bad(`unknown attachments op '${op}'`);
      return copyIntoCallDir(deps, handles, pluginId, call, opened.path);
    },

    'ethos/capability.llm': async (params) => {
      const { live: l } = live('ethos/capability.llm', params);
      if (!isRecord(params) || !Array.isArray(params.args)) throw bad('llm needs args');
      const llm = need(l.llm, 'llm');
      const o = params.args[1];
      return llm.complete(
        str(params.args, 0, 'llm'),
        isRecord(o)
          ? {
              ...(typeof o.maxTokens === 'number' ? { maxTokens: o.maxTokens } : {}),
              ...(typeof o.model === 'string' ? { model: o.model } : {}),
              ...(typeof o.systemPrompt === 'string' ? { systemPrompt: o.systemPrompt } : {}),
            }
          : undefined,
      );
    },

    'ethos/capability.context': async (params) => {
      const { live: l, op, args } = opAndArgs('ethos/capability.context', params);
      if (op === 'get') return need(l.getContext, 'getContext')(str(args, 0, op)) ?? null;
      if (op === 'set') {
        need(l.setContext, 'setContext')(str(args, 0, op), args[1]);
        return null;
      }
      throw bad(`unknown context op '${op}'`);
    },

    'ethos/command.output': async (params) => {
      if (!isRecord(params) || typeof params.text !== 'string') return null;
      const found = handles.get(params.call);
      if (!found) {
        deps.onEvent('plugin_host.denied', {
          plugin_id: pluginId,
          kind: 'handle',
          ref: 'ethos/command.output',
        });
        return null;
      }
      const out = found.output;
      switch (params.stream) {
        case 'send':
          await out?.send(params.text);
          break;
        case 'stdout':
          out?.stdout(params.text);
          break;
        case 'stderr':
          out?.stderr(params.text);
          break;
        case 'emit':
          out?.emit(params.text);
          break;
        default:
          break;
      }
      return null;
    },

    'ethos/emit': (params) => {
      if (!isRecord(params)) return null;
      const found = handles.get(params.call);
      if (!found) {
        deps.onEvent('plugin_host.denied', {
          plugin_id: pluginId,
          kind: 'handle',
          ref: 'ethos/emit',
        });
        return null;
      }
      const event = toProgress(params.event);
      if (event) found.emit?.(event);
      return null;
    },
  };
}

function toProgress(raw: unknown): ToolProgressEvent | null {
  if (!isRecord(raw) || typeof raw.toolName !== 'string' || typeof raw.message !== 'string')
    return null;
  const audience = raw.audience;
  return {
    type: 'progress',
    toolName: raw.toolName,
    message: raw.message,
    ...(typeof raw.percent === 'number' ? { percent: raw.percent } : {}),
    ...(audience === 'internal' || audience === 'user' || audience === 'dashboard'
      ? { audience }
      : {}),
  };
}

/** The attachment the plugin names must be a well-formed one; the call's own ScopedAttachments then checks it is on the turn. */
function toAttachment(raw: unknown): Attachment {
  if (
    !isRecord(raw) ||
    (raw.type !== 'image' && raw.type !== 'file' && raw.type !== 'audio') ||
    typeof raw.ref !== 'string' ||
    typeof raw.url !== 'string' ||
    typeof raw.mimeType !== 'string'
  ) {
    throw bad('attachment must be { type, ref, url, mimeType }');
  }
  return {
    type: raw.type,
    ref: raw.ref,
    url: raw.url,
    mimeType: raw.mimeType,
    ...(typeof raw.filename === 'string' ? { filename: raw.filename } : {}),
    ...(typeof raw.sizeBytes === 'number' ? { sizeBytes: raw.sizeBytes } : {}),
  };
}

/** Reads a response body, failing once it could not fit one frame once base64-encoded. */
async function readCapped(response: Response): Promise<Uint8Array> {
  const cap = Math.floor((MAX_FRAME_BYTES * 3) / 4) - 4096;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new RpcError(
        RPC_ERROR.handlerFailed,
        `fetch response exceeds the ${MAX_FRAME_BYTES}-byte plugin host frame limit`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * The host's sandbox may have no read access to the shared attachment cache, so
 * the bytes are copied into `<hostHome>/attachments/<callId>/`, which is
 * removed when the call's handle is revoked (plan §5.6).
 */
async function copyIntoCallDir(
  deps: CapabilityDeps,
  handles: HandlerContext['handles'],
  pluginId: string,
  call: CallHandle,
  source: string,
): Promise<{ path: string }> {
  const bytes = await deps.storage.readBytes(source);
  if (!bytes) throw new RpcError(RPC_ERROR.handlerFailed, 'attachment file is no longer available');
  const dir = join(deps.hostHome(pluginId), 'attachments', call);
  await deps.storage.mkdir(dir);
  handles.onRevoke(call, () => deps.storage.remove(dir, { recursive: true }));
  const target = join(dir, basename(source));
  await deps.storage.write(target, bytes);
  return { path: target };
}
