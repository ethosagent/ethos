import type { LLMProvider } from '@ethosagent/types';
import { type CompactionDeps, effectiveGate, evaluateGate } from './compaction';

/**
 * The whole-context token count at which `maybeCompact` fires once a request has
 * measured its static (system + tools) slice: `evaluateGate` with that slice and
 * no messages, then `effectiveGate` with the pressure (0.8 when unset) and the
 * ceiling. The context meter stamps it on the `llm_call` span. Lives here, not
 * in compaction.ts (file-size guardrail). Equality with `maybeCompact` is pinned by
 * `__tests__/meter-gate-equality.test.ts`.
 */
export function meterGateTokens(
  deps: {
    llm: Pick<LLMProvider, 'maxContextTokens' | 'capabilities'>;
    windowTokens?: number;
  } & Pick<
    CompactionDeps,
    'reservedOutputTokens' | 'maxSingleToolResultTokens' | 'pressure' | 'maxContextTokens'
  >,
  staticTokens: number,
): number {
  const g = evaluateGate({ ...deps, staticTokens }, [], '');
  return effectiveGate(g, deps.pressure ?? 0.8, deps.maxContextTokens);
}

/** Rendered character length of the memory and skills parts of the system prompt. */
export interface SystemSectionChars {
  memory: number;
  skills: number;
}

/** Which system-prompt section a `ContextInjector` id belongs to, if any. */
export function sectionKindOf(injectorId: string): keyof SystemSectionChars | undefined {
  if (injectorId === 'skills') return 'skills';
  if (injectorId === 'memory-guidance' || injectorId.startsWith('team-memory-index:')) {
    return 'memory';
  }
  return undefined;
}

/**
 * Split the provider-measured system tokens by character share, rounding down.
 * The denominator is at least the section total, so `memory + skills` never
 * exceeds `systemTokens`. Pinned by `__tests__/context-sections.test.ts`.
 */
export function apportionSystemSections(
  systemTokens: number,
  systemChars: number,
  sectionChars: SystemSectionChars,
): SystemSectionChars {
  const denom = Math.max(systemChars, sectionChars.memory + sectionChars.skills);
  if (denom <= 0 || systemTokens <= 0) return { memory: 0, skills: 0 };
  return {
    memory: Math.floor((systemTokens * sectionChars.memory) / denom),
    skills: Math.floor((systemTokens * sectionChars.skills) / denom),
  };
}

/** The compaction gate inputs the context meter reads. */
export type MeterCompaction = Pick<
  CompactionDeps,
  'pressure' | 'maxContextTokens' | 'maxSingleToolResultTokens'
>;

export interface ContextMeterInput {
  llm: Pick<LLMProvider, 'maxContextTokens' | 'capabilities'>;
  gateWindowTokens?: number;
  systemPrompt: string | undefined;
  systemSectionChars?: SystemSectionChars;
  compaction?: MeterCompaction;
  serverCompactionActive?: boolean;
  maxCompletionTokens?: number;
  requestTokens: { system: number; tools: number; messages: number } | undefined;
}

/** Span attrs for the context meter. Keys are omitted, never `undefined`. */
export function contextMeterAttrs(i: ContextMeterInput): {
  contextWindow?: number;
  compactAtTokens?: number;
  systemSections?: SystemSectionChars;
} {
  const out: {
    contextWindow?: number;
    compactAtTokens?: number;
    systemSections?: SystemSectionChars;
  } = {};
  const window =
    i.gateWindowTokens ?? (i.llm.maxContextTokens > 0 ? i.llm.maxContextTokens : undefined);
  if (window !== undefined) {
    out.contextWindow = window;
    if (i.requestTokens && !i.serverCompactionActive) {
      out.compactAtTokens = meterGateTokens(
        {
          llm: i.llm,
          ...(i.gateWindowTokens !== undefined ? { windowTokens: i.gateWindowTokens } : {}),
          ...(i.maxCompletionTokens !== undefined
            ? { reservedOutputTokens: i.maxCompletionTokens }
            : {}),
          ...(i.compaction?.pressure !== undefined ? { pressure: i.compaction.pressure } : {}),
          ...(i.compaction?.maxContextTokens !== undefined
            ? { maxContextTokens: i.compaction.maxContextTokens }
            : {}),
          ...(i.compaction?.maxSingleToolResultTokens !== undefined
            ? { maxSingleToolResultTokens: i.compaction.maxSingleToolResultTokens }
            : {}),
        },
        i.requestTokens.system + i.requestTokens.tools,
      );
    }
  }
  if (i.requestTokens && i.systemSectionChars) {
    out.systemSections = apportionSystemSections(
      i.requestTokens.system,
      (i.systemPrompt ?? '').length,
      i.systemSectionChars,
    );
  }
  return out;
}
