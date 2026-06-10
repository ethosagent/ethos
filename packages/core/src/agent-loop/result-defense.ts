import type { AgentSafety, InjectionVerdict, PersonalityConfig } from '@ethosagent/types';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';

// Best-effort origin label for `<untrusted source="…">`. Picks from common
// argument shapes: `path` (file tools), `url` (web tools), `command`
// (terminal). Returns undefined when nothing recognizable is on the args
// — wrapUntrusted will fall back to "unknown".
export function describeSource(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  if (typeof a.path === 'string') return `${toolName === 'read_file' ? 'file:' : ''}${a.path}`;
  if (typeof a.url === 'string') return a.url;
  if (typeof a.command === 'string') return `cmd:${a.command}`;
  if (typeof a.query === 'string') return `query:${a.query}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Ch.3a + 3c — provenance wrap + injection classification
// ---------------------------------------------------------------------------
//
// Returns the wrapped content (always — wrap is the floor) plus whether
// any defense layer flagged the payload. Tier-1 is always evaluated;
// Tier-2 (LLM classifier) fires when Tier-1 hit, content is > 500 chars,
// or `injectionDefense.classifier.alwaysCallLLM` is true.
export async function handleUntrustedResult(
  toolName: string,
  args: unknown,
  rawValue: string,
  personality: PersonalityConfig,
  traceId: string | undefined,
  safety: AgentSafety,
  observability?: AgentLoopObservability,
): Promise<{
  wrappedContent: string;
  containsInstructions: boolean;
  reason?: string;
}> {
  const source = describeSource(toolName, args);
  const wrapped = safety.injection.wrapUntrusted({
    content: rawValue,
    toolName,
    ...(source ? { source } : {}),
  });
  const tier1 = safety.injection.shortPatternCheck(rawValue);
  const c2 = safety.injection.c2PatternCheck(rawValue);
  const tier1Hit =
    tier1.containsInstructions || c2.containsInstructions || wrapped.strippedTokens > 0;

  const classifierConfig = personality.safety?.injectionDefense?.classifier;
  const activeClassifier = safety.injection.classifier;
  const shouldCallLLM =
    activeClassifier !== undefined &&
    (classifierConfig?.alwaysCallLLM === true || tier1Hit || rawValue.length > 500);

  let verdict: InjectionVerdict | null = null;
  if (shouldCallLLM && activeClassifier) {
    try {
      verdict = await activeClassifier({ content: rawValue });
    } catch (err) {
      // Tier-2 failure must not silently disappear — record it so an
      // operator can see when a configured safety control is offline.
      // We continue with Tier-1 only (fail-open by design: blocking the
      // turn on classifier outage would brick every tool call).
      observability?.recordSafetyBlock({
        traceId,
        code: 'injection_classifier_failed',
        cause: err instanceof Error ? err.message : String(err),
      });
      verdict = null;
    }
  }

  const containsInstructions = tier1Hit || (verdict?.containsInstructions ?? false);
  const reason = tier1Hit
    ? wrapped.strippedTokens > 0
      ? `stripped ${wrapped.strippedTokens} template token${wrapped.strippedTokens === 1 ? '' : 's'}`
      : (tier1.hits[0]?.rule ?? 'pattern-hit')
    : verdict?.reason;

  return {
    wrappedContent: wrapped.content,
    containsInstructions,
    ...(reason ? { reason } : {}),
  };
}
