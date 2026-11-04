import type {
  Attachment,
  KeyValueStore,
  ScopedAttachments,
  ScopedFetch,
  ScopedFs,
  ScopedFsEntry,
  ScopedSecretsResolver,
  SimpleCompletion,
} from '@ethosagent/types';
import type { HostConnection } from '../connection';
import type { CallHandle } from '../protocol';
import { decodeBytes, encodeBytes, isRecord } from '../util';

/** The reverse-call stubs of a hosted tool's derived handles (plan §5.6). Each is one `ethos/capability.*` request. */
type Call = (op: string, args: unknown[]) => Promise<unknown>;

const opCall =
  (conn: HostConnection, method: 'kv' | 'fs' | 'secret' | 'attachments', call: CallHandle): Call =>
  (op, args) =>
    conn.request(`ethos/capability.${method}`, { call, op, args });

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function ipcKv(conn: HostConnection, call: CallHandle): KeyValueStore {
  const c = opCall(conn, 'kv', call);
  return {
    async get(key) {
      const out = await c('get', [key]);
      return typeof out === 'string' ? out : null;
    },
    async set(key, value, opts) {
      await c('set', [key, value, opts]);
    },
    async delete(key) {
      await c('delete', [key]);
    },
    async list(prefix) {
      return stringArray(await c('list', [prefix]));
    },
  };
}

export function ipcSecretsResolver(conn: HostConnection, call: CallHandle): ScopedSecretsResolver {
  const c = opCall(conn, 'secret', call);
  return {
    async get(ref) {
      const out = await c('get', [ref]);
      if (typeof out !== 'string') throw new Error(`secret '${ref}' is not set`);
      return out;
    },
  };
}

export function ipcFs(conn: HostConnection, call: CallHandle): ScopedFs {
  const c = opCall(conn, 'fs', call);
  return {
    async read(path) {
      const out = await c('read', [path]);
      if (typeof out !== 'string') throw new Error(`could not read '${path}'`);
      return out;
    },
    async readBytes(path) {
      const out = decodeBytes(await c('readBytes', [path]));
      if (!(out instanceof Uint8Array)) throw new Error(`could not read '${path}'`);
      return out;
    },
    async write(path, content) {
      await c('write', [path, encodeBytes(content)]);
    },
    async exists(path) {
      return (await c('exists', [path])) === true;
    },
    async list(path) {
      return stringArray(await c('list', [path]));
    },
    async mtime(path) {
      const out = await c('mtime', [path]);
      return typeof out === 'number' ? out : null;
    },
    async mkdir(dir) {
      await c('mkdir', [dir]);
    },
    async listEntries(dir) {
      const out = await c('listEntries', [dir]);
      const entries: ScopedFsEntry[] = [];
      if (Array.isArray(out)) {
        for (const item of out) {
          if (isRecord(item) && typeof item.name === 'string' && typeof item.isDir === 'boolean') {
            entries.push({ name: item.name, isDir: item.isDir });
          }
        }
      }
      return entries;
    },
  };
}

/** Only the plain-data parts of a `RequestInit` cross; a stream body or `signal` does not. */
function serialiseInit(init: RequestInit | undefined): Record<string, unknown> {
  if (!init) return {};
  const headers: Record<string, string> = {};
  if (init.headers) {
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
  }
  const { body } = init;
  if (
    body !== undefined &&
    body !== null &&
    typeof body !== 'string' &&
    !(body instanceof Uint8Array)
  ) {
    throw new Error('scopedFetch in a plugin host accepts only a string or bytes body');
  }
  return {
    ...(init.method ? { method: init.method } : {}),
    headers,
    ...(body !== undefined && body !== null ? { body: encodeBytes(body) } : {}),
  };
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export function ipcFetch(conn: HostConnection, call: CallHandle): ScopedFetch {
  return {
    async fetch(url, init) {
      const out = await conn.request('ethos/capability.fetch', {
        call,
        args: [String(url), serialiseInit(init)],
      });
      if (!isRecord(out) || typeof out.status !== 'number' || typeof out.bodyBase64 !== 'string') {
        throw new Error('malformed fetch response from the parent');
      }
      const headers = new Headers();
      if (isRecord(out.headers)) {
        for (const [k, v] of Object.entries(out.headers))
          if (typeof v === 'string') headers.set(k, v);
      }
      const body = NULL_BODY_STATUS.has(out.status) ? null : Buffer.from(out.bodyBase64, 'base64');
      return new Response(body, { status: out.status, headers });
    },
  };
}

/** `list()` is synchronous, so it answers from the snapshot sent with the call. */
export function ipcAttachments(
  conn: HostConnection,
  call: CallHandle,
  snapshot: Attachment[],
): ScopedAttachments {
  const c = opCall(conn, 'attachments', call);
  const path = async (out: Promise<unknown>): Promise<{ path: string }> => {
    const r = await out;
    if (!isRecord(r) || typeof r.path !== 'string')
      throw new Error('attachment could not be opened');
    return { path: r.path };
  };
  return {
    list: () => snapshot,
    open: (att) => path(c('open', [att])),
    openByRef: (ref) => path(c('openByRef', [ref])),
  };
}

export function ipcLlm(conn: HostConnection, call: CallHandle): SimpleCompletion {
  return {
    async complete(prompt, options) {
      const out = await conn.request('ethos/capability.llm', { call, args: [prompt, options] });
      if (typeof out !== 'string') throw new Error('malformed llm response from the parent');
      return out;
    },
  };
}
