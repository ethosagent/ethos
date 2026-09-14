// ModelTestOutcome — what one `modelRegistry.test` learned, drawn the same way
// wherever a Test button sits: Settings → Models (a registry row, the Add/Edit
// drawer) and the personality model picker (plan/phases/model-registry.md D19).
//
// Three rules from D19, each pinned in `__tests__/model-test-outcome.test.ts`:
//
//   • A vendor refusal shows the vendor's own body VERBATIM and UNTRUNCATED —
//     no max-height, no ellipsis, no paraphrase — and the fix after it.
//   • An unreachable probe is never phrased or coloured as a bad key: no
//     answer came back, so it is not a verdict on the credential.
//   • The model id the provider echoed appears only when it differs from the
//     one requested. `testModel` (@ethosagent/wiring) already drops an
//     identical echo; the check is repeated here so the rule does not rest on
//     the server alone.
//
// Status colour always travels with its glyph (DESIGN.md: ✓/✗/⚠, never colour
// alone). Ids and numbers are Geist Mono with tabular numerals.

import type { ModelRegistryTestResult } from '@ethosagent/web-contracts';
import type { CSSProperties, JSX } from 'react';

const MONO = 'var(--font-mono, "Geist Mono", monospace)';

const BOX: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 13,
  minWidth: 0,
};

const NOTE: CSSProperties = { fontSize: 12, color: 'var(--text-secondary)' };

const ID: CSSProperties = { fontFamily: MONO, fontVariantNumeric: 'tabular-nums' };

const VENDOR_BODY: CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border-subtle)',
  fontFamily: MONO,
  fontSize: 12,
  lineHeight: 1.55,
  color: 'var(--text-primary)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

function status(color: string): CSSProperties {
  return { color, fontWeight: 500 };
}

export function ModelTestOutcome({ outcome }: { outcome: ModelRegistryTestResult }): JSX.Element {
  return (
    <div
      className={`model-test-outcome model-test-outcome--${outcome.state}`}
      role="status"
      aria-live="polite"
      style={BOX}
    >
      <OutcomeBody outcome={outcome} />
    </div>
  );
}

function OutcomeBody({ outcome }: { outcome: ModelRegistryTestResult }): JSX.Element {
  switch (outcome.state) {
    case 'ok': {
      const echoed =
        outcome.echoedModel !== undefined && outcome.echoedModel !== outcome.modelId
          ? outcome.echoedModel
          : null;
      return (
        <>
          <span style={status('var(--success)')}>
            ✓ Passed · <span style={ID}>{outcome.latencyMs} ms</span>
          </span>
          {echoed !== null ? (
            <span style={NOTE}>
              <span style={ID}>{outcome.providerKey}</span> served <span style={ID}>{echoed}</span>,
              not <span style={ID}>{outcome.modelId}</span>.
            </span>
          ) : null}
        </>
      );
    }
    case 'rejected':
      return (
        <>
          <span style={status('var(--error)')}>
            ✗ {outcome.provider} refused <span style={ID}>{outcome.modelId}</span>
          </span>
          <pre className="model-test-outcome-body" style={VENDOR_BODY}>
            {outcome.error}
          </pre>
          <span style={NOTE}>Fix: {outcome.fix}</span>
        </>
      );
    case 'unreachable':
      return (
        <>
          <span style={status('var(--warning)')}>
            ⚠ Could not reach <span style={ID}>{outcome.providerKey}</span>
          </span>
          <pre className="model-test-outcome-body" style={VENDOR_BODY}>
            {outcome.error}
          </pre>
          <span style={NOTE}>
            No response came back, so this says nothing about the key. Check the network or the base
            URL, then test again.
          </span>
        </>
      );
    case 'unconfigured':
      return (
        <>
          <span style={status('var(--error)')}>✗ Not tested</span>
          <span style={NOTE}>{outcome.reason}</span>
          {outcome.fix !== undefined ? <span style={NOTE}>Fix: {outcome.fix}</span> : null}
        </>
      );
    case 'rate_limited':
      return (
        <span style={NOTE}>
          Tested moments ago — try again in <span style={ID}>{outcome.retryAfterSeconds}s</span>.
        </span>
      );
  }
}
