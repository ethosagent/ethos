import type { PluginHttpRequest } from '@ethosagent/plugin-sdk';
import type {
  CliSubcommandContext,
  PromptContext,
  SlashCommandContext,
  ToolResult,
} from '@ethosagent/types';
import { type HandlerTable, type HostConnection, RpcError } from '../connection';
import { RPC_ERROR } from '../protocol';
import { parseToolResult } from '../tool-result';
import { decodeBytes, encodeBytes, isRecord } from '../util';
import {
  buildChildContext,
  ipcStorageFor,
  isToolExecuteRequest,
  parseLiveSnapshot,
} from './context';
import type { BridgeEventBus, ChildRows } from './registries';

export interface RowHandlerDeps {
  conn: HostConnection;
  rows: () => ChildRows | null;
  bus: () => BridgeEventBus | null;
}

const invalid = (message: string): RpcError => new RpcError(RPC_ERROR.invalidParams, message);

function isPromptContext(raw: unknown): raw is PromptContext {
  return (
    isRecord(raw) &&
    typeof raw.sessionId === 'string' &&
    typeof raw.sessionKey === 'string' &&
    typeof raw.platform === 'string' &&
    typeof raw.model === 'string' &&
    Array.isArray(raw.history) &&
    typeof raw.isDm === 'boolean' &&
    typeof raw.turnNumber === 'number'
  );
}

function toHttpRequest(raw: unknown): PluginHttpRequest {
  if (!isRecord(raw) || typeof raw.method !== 'string' || typeof raw.path !== 'string') {
    throw invalid('route request needs method and path');
  }
  const headers: Record<string, string> = {};
  if (isRecord(raw.headers)) {
    for (const [k, v] of Object.entries(raw.headers)) if (typeof v === 'string') headers[k] = v;
  }
  const query: Record<string, string> = {};
  if (isRecord(raw.query)) {
    for (const [k, v] of Object.entries(raw.query)) if (typeof v === 'string') query[k] = v;
  }
  const body = typeof raw.body === 'string' ? raw.body : isRecord(raw.body) ? raw.body : {};
  return { method: raw.method, path: raw.path, headers, body, query };
}

function row<T>(rows: T[] | undefined, index: unknown, what: string): T {
  const found = typeof index === 'number' ? rows?.[index] : undefined;
  if (found === undefined)
    throw new RpcError(RPC_ERROR.handlerFailed, `no ${what} at index ${String(index)}`);
  return found;
}

/**
 * The child side of the injector, filter, evaluator, route, command, health,
 * extract and bus rows (plan §4.2). Each handler addresses a registration by
 * its index; a mismatch with what the host registered is an error, which the
 * parent proxy turns into its fail-open answer.
 */
export function installRowHandlers(handlers: HandlerTable, deps: RowHandlerDeps): void {
  const { conn } = deps;
  const rows = (): ChildRows => {
    const r = deps.rows();
    if (!r) throw new RpcError(RPC_ERROR.invalidRequest, 'host is not activated');
    return r;
  };

  handlers['ethos/injector.inject'] = async (params) => {
    if (!isRecord(params) || !isPromptContext(params.ctx))
      throw invalid('injector.inject needs ctx');
    const inj = row(rows().injectors, params.index, 'injector');
    if (inj.id !== params.label) throw new RpcError(RPC_ERROR.handlerFailed, 'injector changed');
    const ctx = params.ctx;
    // `shouldInject` is synchronous, so it runs here and a false answer is null (plan §4.2).
    if (inj.shouldInject && !inj.shouldInject(ctx)) return { result: null };
    const result = await inj.inject(ctx);
    return { result, ...(ctx.meta ? { meta: ctx.meta } : {}) };
  };

  const filterCtx = (params: Record<string, unknown>) => {
    if (!isToolExecuteRequest(params.request) || typeof params.call !== 'string') {
      throw invalid('filter call needs request and call');
    }
    return buildChildContext(
      params.request,
      params.call,
      new AbortController().signal,
      conn,
      {},
      parseLiveSnapshot(params.live),
    );
  };
  const filterMeta = (
    params: Record<string, unknown>,
  ): { toolName: string; toolCallId: string } => {
    const m = params.meta;
    if (!isRecord(m) || typeof m.toolName !== 'string' || typeof m.toolCallId !== 'string') {
      throw invalid('filter call needs meta');
    }
    return { toolName: m.toolName, toolCallId: m.toolCallId };
  };

  handlers['ethos/filter.before'] = async (params): Promise<ToolResult | null> => {
    if (!isRecord(params)) throw invalid('filter.before needs params');
    const filter = row(rows().filters, params.index, 'filter');
    if (!filter.before) return null;
    return filter.before(params.args, filterCtx(params), filterMeta(params));
  };

  handlers['ethos/filter.after'] = async (params) => {
    if (!isRecord(params)) throw invalid('filter.after needs params');
    const filter = row(rows().filters, params.index, 'filter');
    if (!filter.after) return params.result;
    const result = parseToolResult(params.result);
    if (!result) throw invalid('filter.after needs a result');
    return filter.after(result, filterCtx(params), filterMeta(params));
  };

  handlers['ethos/evaluator.evaluate'] = async (params) => {
    if (!isRecord(params) || !isRecord(params.payload)) throw invalid('evaluator needs payload');
    const ev = row(rows().evaluators, params.index, 'evaluator');
    const p = params.payload;
    if (
      typeof p.text !== 'string' ||
      typeof p.sessionId !== 'string' ||
      typeof p.turnIndex !== 'number'
    ) {
      throw invalid('evaluator payload needs text, sessionId and turnIndex');
    }
    const payload = { text: p.text, sessionId: p.sessionId, turnIndex: p.turnIndex };
    // The host runs the real `shouldRun`; the parent's is always true (plan §4.2).
    if (!ev.shouldRun(payload)) return { pass: true, reason: 'skipped' };
    return ev.evaluate(payload, { sessionId: payload.sessionId });
  };

  handlers['ethos/route.handle'] = async (params) => {
    if (!isRecord(params)) throw invalid('route.handle needs params');
    const route = row(rows().routes, params.index, 'route');
    const res = await route.handler(toHttpRequest(params.req));
    return {
      ...(res.status !== undefined ? { status: res.status } : {}),
      body: encodeBytes(res.body instanceof Uint8Array ? new Uint8Array(res.body) : res.body),
      ...(res.headers ? { headers: res.headers } : {}),
    };
  };

  handlers['ethos/health.run'] = async (params) => {
    if (!isRecord(params)) throw invalid('health.run needs params');
    return row(rows().healthChecks, params.index, 'health check').run();
  };

  handlers['ethos/extract'] = async (params) => {
    if (!isRecord(params) || typeof params.mime !== 'string') throw invalid('extract needs mime');
    const bytes = decodeBytes(params.bytes);
    if (!(bytes instanceof Uint8Array)) throw invalid('extract needs bytes');
    return row(rows().extractors, params.index, 'extractor').extract(bytes, params.mime);
  };

  handlers['ethos/command.run'] = async (params) => {
    if (
      !isRecord(params) ||
      typeof params.name !== 'string' ||
      typeof params.call !== 'string' ||
      !isRecord(params.input)
    ) {
      throw invalid('command.run needs kind, name, call and input');
    }
    const call = params.call;
    const input = params.input;
    const out = (stream: 'send' | 'stdout' | 'stderr' | 'emit', text: string): void =>
      conn.notify('ethos/command.output', { call, stream, text });
    const storage = input.hasStorage === true ? ipcStorageFor(conn, call) : undefined;
    if (params.kind === 'slash') {
      const handler = rows().slash.get(params.name);
      if (!handler)
        throw new RpcError(RPC_ERROR.handlerFailed, `no slash command '${params.name}'`);
      const sender = input.sender;
      const ctx: SlashCommandContext = {
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
        platform: typeof input.platform === 'string' ? input.platform : '',
        ...(typeof input.personalityId === 'string' ? { personalityId: input.personalityId } : {}),
        ...(isRecord(sender) &&
        typeof sender.userId === 'string' &&
        typeof sender.isOwner === 'boolean' &&
        typeof sender.isDm === 'boolean'
          ? { sender: { userId: sender.userId, isOwner: sender.isOwner, isDm: sender.isDm } }
          : {}),
        // `toolRegistry` is absent on purpose: live object identity does not cross (plan §4.2).
        send: async (text) => out('send', text),
        ...(storage ? { storage } : {}),
      };
      return handler(typeof input.args === 'string' ? input.args : '', ctx);
    }
    if (params.kind === 'cli') {
      const handler = rows().cli.get(params.name);
      if (!handler)
        throw new RpcError(RPC_ERROR.handlerFailed, `no CLI subcommand '${params.name}'`);
      const ctx: CliSubcommandContext = {
        argv: Array.isArray(input.argv)
          ? input.argv.filter((a): a is string => typeof a === 'string')
          : [],
        cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(),
        stdout: (text) => out('stdout', text),
        stderr: (text) => out('stderr', text),
        ...(storage ? { storage } : {}),
      };
      return handler(ctx);
    }
    throw invalid(`unknown command kind '${String(params.kind)}'`);
  };

  handlers['ethos/event'] = (params) => {
    if (isRecord(params) && params.type === 'bus' && typeof params.event === 'string') {
      deps.bus()?.deliver(params.event, params.payload);
    }
    return null;
  };
}
