import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ProviderCapabilities,
  ToolDefinitionLite,
  UsageAttribution,
  UsageGate,
  UsageGateRequest,
  UsageGateVerdict,
  UsageMeterEvent,
  UsageRecord,
  UsageRecorder,
  UsageSourceKind,
} from '@ethosagent/types';
import { GATE_EXEMPT_KINDS, sourceClassOf } from '@ethosagent/types';
import { activeUsageScope } from '../usage-scope';

/**
 * A background call refused by its gate (plan background-usage-accounting §7.2):
 * the bot's daily cap has no money left for background work, so the call is not
 * made. A named `Error`, not an `EthosError` (library rule in
 * `@ethosagent/types` errors.ts); callers that drop a job on any LLM throw drop
 * it on this one too.
 */
export class BackgroundBudgetSkipped extends Error {
  readonly code = 'background_budget';
  constructor(readonly kind: UsageSourceKind) {
    super(`background ${kind} call skipped: the daily budget is spent`);
    this.name = 'BackgroundBudgetSkipped';
  }
}

export interface MeteredProviderOptions {
  inner: LLMProvider;
  recorder: UsageRecorder;
  kind: UsageSourceKind;
  /** Wins over the active usage scope field by field (`../usage-scope.ts`). */
  attribution?: UsageAttribution;
  /** Consulted before a `background` kind's call, except `GATE_EXEMPT_KINDS`; ignored for every other class. */
  gate?: UsageGate;
  /** `usage.background_skipped` / `usage.ledger_write_failed`. Never throws into the call. */
  onEvent?: (event: UsageMeterEvent) => void;
}

const METERED = Symbol.for('ethos.meteredProvider');

/** True for a provider wrapped by {@link MeteredProvider} (wiring tests, §5.5). */
export function isMeteredProvider(provider: LLMProvider): provider is MeteredProvider {
  return (provider as { [METERED]?: true })[METERED] === true;
}

/**
 * The one decorator that writes a usage ledger row for a model call made
 * outside a turn's own `streamStep` (§5.2). Every chunk is passed through as
 * the same object, in the same order. One row per stream, written when the
 * stream ends (completed, threw, or abandoned by its consumer) and only if at
 * least one `usage` chunk arrived — the cost is the provider's own
 * `estimatedCostUsd` (D7), so core never prices anything. A recorder that
 * throws never breaks the call (fail open, `usage.ledger_write_failed`). A
 * `turn_utility` call is then charged to the open usage scope. Pinned by
 * `../__tests__/metered-provider.test.ts`.
 */
export class MeteredProvider implements LLMProvider {
  readonly [METERED] = true as const;
  private readonly opts: MeteredProviderOptions;

  constructor(opts: MeteredProviderOptions) {
    this.opts = opts;
  }

  get kind(): UsageSourceKind {
    return this.opts.kind;
  }

  get name(): string {
    return this.opts.inner.name;
  }
  get model(): string {
    return this.opts.inner.model;
  }
  get maxContextTokens(): number {
    return this.opts.inner.maxContextTokens;
  }
  get supportsCaching(): boolean {
    return this.opts.inner.supportsCaching;
  }
  get supportsThinking(): boolean {
    return this.opts.inner.supportsThinking;
  }
  get supportsVision(): LLMProvider['supportsVision'] {
    return this.opts.inner.supportsVision;
  }
  get supportsCacheBreakpoints(): boolean | undefined {
    return this.opts.inner.supportsCacheBreakpoints;
  }
  get supportsTokenCounting(): LLMProvider['supportsTokenCounting'] {
    return this.opts.inner.supportsTokenCounting;
  }
  get capabilities(): ProviderCapabilities | undefined {
    return this.opts.inner.capabilities;
  }

  countTokens(messages: Message[]): Promise<number> {
    return this.opts.inner.countTokens(messages);
  }

  async *complete(
    messages: Message[],
    tools: ToolDefinitionLite[],
    options: CompletionOptions,
  ): AsyncIterable<CompletionChunk> {
    const sourceClass = sourceClassOf(this.kind);
    const scope = activeUsageScope();
    const attribution: UsageAttribution = { ...scope?.attribution, ...this.opts.attribution };

    if (sourceClass === 'background' && this.opts.gate && !GATE_EXEMPT_KINDS.has(this.kind)) {
      const verdict = await askGate(this.opts.gate, { kind: this.kind, attribution });
      if (verdict.decision === 'skip') {
        this.emit({
          type: 'usage.background_skipped',
          kind: this.kind,
          attribution,
          ...(verdict.spentUsd !== undefined ? { spentUsd: verdict.spentUsd } : {}),
          ...(verdict.capUsd !== undefined ? { capUsd: verdict.capUsd } : {}),
        });
        throw new BackgroundBudgetSkipped(this.kind);
      }
    }

    const sum = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 };
    let sawUsage = false;
    let costBasis: UsageRecord['costBasis'];
    let ended: 'ok' | 'error' | undefined; // undefined: the consumer stopped pulling early
    try {
      for await (const chunk of this.opts.inner.complete(messages, tools, options)) {
        if (chunk.type === 'usage') {
          sawUsage = true;
          sum.input += chunk.usage.inputTokens;
          sum.output += chunk.usage.outputTokens;
          sum.cacheRead += chunk.usage.cacheReadTokens;
          sum.cacheCreation += chunk.usage.cacheCreationTokens;
          sum.cost += chunk.usage.estimatedCostUsd;
          if (chunk.costBasis !== undefined) costBasis = chunk.costBasis;
        }
        yield chunk;
      }
      ended = 'ok';
    } catch (err) {
      ended = 'error';
      throw err;
    } finally {
      if (sawUsage) {
        const outcome = options.abortSignal?.aborted ? 'aborted' : (ended ?? 'aborted');
        this.write({
          ...attribution,
          ts: new Date().toISOString(),
          kind: this.kind,
          sourceClass,
          provider: this.opts.inner.name,
          model: options.modelOverride ?? this.opts.inner.model,
          inputTokens: sum.input,
          outputTokens: sum.output,
          cacheReadTokens: sum.cacheRead,
          cacheCreationTokens: sum.cacheCreation,
          estimatedCostUsd: sum.cost,
          ...(costBasis !== undefined ? { costBasis } : {}),
          outcome,
        });
        if (sourceClass === 'turn_utility' && scope?.open && scope.charge && sum.cost > 0) {
          scope.charge(sum.cost);
        }
      }
    }
  }

  private write(row: UsageRecord): void {
    try {
      this.opts.recorder.record(row);
    } catch (err) {
      this.emit({
        type: 'usage.ledger_write_failed',
        kind: this.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private emit(event: UsageMeterEvent): void {
    try {
      this.opts.onEvent?.(event);
    } catch {
      // An observability sink must never break the call it observes.
      return;
    }
  }
}

/** Fail open: a gate that cannot answer (an unreadable spend figure) allows the call. */
async function askGate(gate: UsageGate, request: UsageGateRequest): Promise<UsageGateVerdict> {
  try {
    return await gate(request);
  } catch {
    return { decision: 'allow' };
  }
}
