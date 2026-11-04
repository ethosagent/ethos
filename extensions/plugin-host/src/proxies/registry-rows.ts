import type { PluginHttpRequest, PluginHttpResponse } from '@ethosagent/plugin-sdk';
import type {
  ContextInjector,
  ExtractedDocument,
  HealthCheckResult,
  InjectionResult,
  PostTurnEvaluator,
  ToolInvocationFilter,
} from '@ethosagent/types';
import { RpcError } from '../connection';
import { liveSnapshot } from '../host-calls';
import type { HostLease } from '../pool';
import type {
  EvaluatorRegistration,
  ExtractorRegistration,
  FilterRegistration,
  HealthCheckRegistration,
  InjectorRegistration,
  RouteRegistration,
} from '../protocol';
import { parseToolResult } from '../tool-result';
import { decodeBytes, encodeBytes, isRecord } from '../util';
import { requestFromContext } from './request';

const ROUTE_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;
const EXTRACT_TIMEOUT_MS = 30_000;

function parseInjection(raw: unknown): InjectionResult | null {
  if (!isRecord(raw) || typeof raw.content !== 'string') return null;
  return {
    content: raw.content,
    ...(raw.position === 'prepend' || raw.position === 'append' ? { position: raw.position } : {}),
    ...(typeof raw.section === 'string' ? { section: raw.section } : {}),
  };
}

/**
 * `{ id, priority, inject }`. `shouldInject` (sync) is omitted: the host runs
 * it before `inject` and answers null when it is false. A failure is null (no
 * injection), like a throwing injector skipped by the prompt assembler.
 */
export function createInjectorProxy(reg: InjectorRegistration, lease: HostLease): ContextInjector {
  return {
    id: reg.id,
    priority: reg.priority,
    async inject(ctx) {
      try {
        const raw = await lease.request('ethos/injector.inject', {
          index: reg.index,
          label: reg.id,
          ctx,
        });
        if (!isRecord(raw)) return null;
        // The injector's `ctx.meta` writes are a side channel AgentLoop reads back.
        if (ctx.meta && isRecord(raw.meta)) Object.assign(ctx.meta, raw.meta);
        return parseInjection(raw.result);
      } catch {
        return null;
      }
    },
  };
}

/**
 * before/after over IPC with the call's handles. A timeout, crash or throw is a
 * pass-through (`null` / the unchanged result). NOTE: this is looser than
 * in-process, where `applyFilters` has no try/catch and a throwing filter
 * fails the call (packages/core/src/tool-registry.ts); hosted filters fail open.
 */
export function createFilterProxy(reg: FilterRegistration, lease: HostLease): ToolInvocationFilter {
  const filter: ToolInvocationFilter = {
    ...(reg.toolName !== undefined ? { toolName: reg.toolName } : {}),
    ...(reg.toolset !== undefined ? { toolset: reg.toolset } : {}),
  };
  if (reg.before) {
    filter.before = (args, ctx, meta) =>
      lease.withCall(ctx, async (call) => {
        try {
          const raw = await lease.request('ethos/filter.before', {
            index: reg.index,
            call,
            args,
            meta,
            request: requestFromContext(meta.toolName, args, ctx),
            live: liveSnapshot(ctx),
          });
          return raw === null ? null : parseToolResult(raw);
        } catch {
          return null;
        }
      });
  }
  if (reg.after) {
    filter.after = (result, ctx, meta) =>
      lease.withCall(ctx, async (call) => {
        try {
          const raw = await lease.request('ethos/filter.after', {
            index: reg.index,
            call,
            result,
            meta,
            request: requestFromContext(meta.toolName, undefined, ctx),
            live: liveSnapshot(ctx),
          });
          return parseToolResult(raw) ?? result;
        } catch {
          return result;
        }
      });
  }
  return filter;
}

/**
 * `shouldRun` (sync) is `true` in the parent; the host runs the real one and
 * answers `{ pass: true, reason: 'skipped' }` when it is false. A failure also
 * passes, so a broken evaluator never fails a turn.
 */
export function createEvaluatorProxy(
  reg: EvaluatorRegistration,
  lease: HostLease,
): PostTurnEvaluator {
  const skipped = { pass: true, reason: 'skipped' };
  return {
    name: reg.name,
    shouldRun: () => true,
    evaluate: (payload, ctx) =>
      lease.withCall(ctx, async (call) => {
        try {
          const raw = await lease.request('ethos/evaluator.evaluate', {
            index: reg.index,
            call,
            payload,
          });
          if (!isRecord(raw) || typeof raw.pass !== 'boolean') return skipped;
          return {
            pass: raw.pass,
            ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
            ...(typeof raw.score === 'number' ? { score: raw.score } : {}),
          };
        } catch {
          return skipped;
        }
      }),
  };
}

/** The parent route forwards the request; binary bodies cross as base64 (`{ $bytes }`). */
export function createRouteHandler(
  reg: RouteRegistration,
  lease: HostLease,
): (req: PluginHttpRequest) => Promise<PluginHttpResponse> {
  return async (req) => {
    try {
      const raw = await lease.request(
        'ethos/route.handle',
        { index: reg.index, req },
        { timeoutMs: ROUTE_TIMEOUT_MS },
      );
      if (!isRecord(raw)) throw new Error('malformed route response');
      const headers: Record<string, string> = {};
      if (isRecord(raw.headers)) {
        for (const [k, v] of Object.entries(raw.headers)) if (typeof v === 'string') headers[k] = v;
      }
      const decoded = decodeBytes(raw.body);
      return {
        ...(typeof raw.status === 'number' ? { status: raw.status } : {}),
        body: decoded instanceof Uint8Array ? Buffer.from(decoded) : raw.body,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
    } catch (err) {
      const message = err instanceof RpcError || err instanceof Error ? err.message : String(err);
      return {
        status: 502,
        body: {
          error: `Plugin '${lease.pluginId}' route ${reg.method} ${reg.path} failed: ${message}`,
        },
      };
    }
  };
}

export function createHealthCheck(reg: HealthCheckRegistration, lease: HostLease) {
  return {
    name: reg.name,
    description: reg.description,
    async run(): Promise<HealthCheckResult> {
      try {
        const raw = await lease.request(
          'ethos/health.run',
          { index: reg.index },
          { timeoutMs: HEALTH_TIMEOUT_MS },
        );
        if (
          isRecord(raw) &&
          (raw.status === 'ok' || raw.status === 'warn' || raw.status === 'error') &&
          typeof raw.message === 'string'
        ) {
          return {
            status: raw.status,
            message: raw.message,
            ...(isRecord(raw.details) ? { details: raw.details } : {}),
          };
        }
        return { status: 'error', message: 'plugin host returned a malformed health result' };
      } catch (err) {
        return { status: 'error', message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function createExtractor(reg: ExtractorRegistration, lease: HostLease) {
  return {
    name: reg.name,
    mimeTypes: reg.mimeTypes,
    ...(reg.maxInputBytes !== undefined ? { maxInputBytes: reg.maxInputBytes } : {}),
    async extract(bytes: Uint8Array, mime: string): Promise<ExtractedDocument> {
      const raw = await lease.request(
        'ethos/extract',
        { index: reg.index, bytes: encodeBytes(bytes), mime },
        { timeoutMs: EXTRACT_TIMEOUT_MS },
      );
      if (!isRecord(raw) || typeof raw.text !== 'string') {
        throw new Error(
          `Plugin '${lease.pluginId}' extractor '${reg.name}' returned a malformed result`,
        );
      }
      return {
        text: raw.text,
        format: raw.format === 'markdown' ? 'markdown' : 'text',
        ...(typeof raw.truncatedFromChars === 'number'
          ? { truncatedFromChars: raw.truncatedFromChars }
          : {}),
        ...(typeof raw.pages === 'number' ? { pages: raw.pages } : {}),
      };
    },
  };
}
