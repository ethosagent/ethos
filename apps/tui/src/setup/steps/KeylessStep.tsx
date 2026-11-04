import type { KeylessProbeResult } from '@ethosagent/wiring/keyless-probe';
import { belowFloorHint, importExternalLogin } from '@ethosagent/wiring/keyless-probe';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext, type WizardAnswers } from '../context';
import {
  answersForCandidate,
  buildKeylessRows,
  CODEX_IMPORT_CONSENT,
  codexLoginAnswers,
  defaultKeylessProbe,
  deviceSignInAnswers,
  type KeylessRow,
  keylessSecrets,
  pasteKeyAnswers,
} from '../keyless-plan';

interface KeylessStepProps {
  onComplete: (
    result: { answers: WizardAnswers; launch: 'gateway' | 'chat' | 'done' } | null,
  ) => void;
  offerInstall: boolean;
  /** Injectable for tests; defaults to the real probe. */
  probe?: () => Promise<KeylessProbeResult>;
}

type Phase =
  | { kind: 'probing' }
  | { kind: 'choose'; rows: KeylessRow[] }
  | { kind: 'consent'; rows: KeylessRow[]; source: 'codex-cli' | 'hermes' }
  | { kind: 'install'; rows: KeylessRow[]; row: KeylessRow }
  | { kind: 'error'; message: string; rows: KeylessRow[] };

const CONSENT_ROWS = [
  {
    id: 'device',
    label: 'Sign in with ChatGPT',
    hint: 'a separate sign-in for Ethos (recommended)',
  },
  { id: 'import', label: 'Import my Codex sign-in', hint: 'copies it into the Ethos secret store' },
] as const;

export function KeylessStep({ onComplete, offerInstall, probe }: KeylessStepProps) {
  const { dispatch } = useWizardContext();
  const [phase, setPhase] = useState<Phase>({ kind: 'probing' });
  const [selected, setSelected] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only probe
  useEffect(() => {
    let live = true;
    (probe ?? defaultKeylessProbe)()
      .then((result) => {
        if (live) setPhase({ kind: 'choose', rows: buildKeylessRows(result, { offerInstall }) });
      })
      .catch(() => {
        // The probe never throws by contract; fall back to the key flow anyway.
        if (live) dispatch({ type: 'next', patch: pasteKeyAnswers() });
      });
    return () => {
      live = false;
    };
  }, []);

  useInput((_input, key) => {
    if (phase.kind === 'probing') return;
    const count =
      phase.kind === 'consent'
        ? CONSENT_ROWS.length
        : phase.kind === 'choose'
          ? phase.rows.length
          : 0;
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(Math.max(count - 1, 0), s + 1));
    if (key.escape && phase.kind !== 'choose') {
      setSelected(0);
      setPhase({ kind: 'choose', rows: phase.rows });
      return;
    }
    if (!key.return) return;

    if (phase.kind === 'choose') {
      const row = phase.rows[selected];
      if (!row) return;
      const c = row.candidate;
      if (c.kind === 'paste-key') return dispatch({ type: 'next', patch: pasteKeyAnswers() });
      if (c.kind === 'external-login') {
        setSelected(0);
        return setPhase({ kind: 'consent', rows: phase.rows, source: c.source });
      }
      if (c.kind === 'install-offer') {
        setSelected(0);
        return setPhase({ kind: 'install', rows: phase.rows, row });
      }
      if (c.kind === 'local' && c.belowContextFloor) {
        // Would throw at provider init (floor check in llm-openai-compat);
        // pinned by keyless-step.test.ts ("below-floor ..."). Nothing is chosen.
        return setPhase({ kind: 'error', rows: phase.rows, message: belowFloorHint(c) ?? '' });
      }
      const patch = answersForCandidate(c);
      if (patch) dispatch({ type: 'next', patch });
      return;
    }
    if (phase.kind === 'consent') {
      if (selected === 0) return dispatch({ type: 'next', patch: deviceSignInAnswers() });
      importExternalLogin({ secrets: keylessSecrets(), source: phase.source })
        .then((r) => {
          if (r.ok) dispatch({ type: 'next', patch: codexLoginAnswers('external-login') });
          else
            setPhase({
              kind: 'error',
              rows: phase.rows,
              message: `Could not import (${r.reason}). Choose "Sign in with ChatGPT" or paste a key.`,
            });
        })
        .catch(() =>
          setPhase({ kind: 'error', rows: phase.rows, message: 'Could not import the sign-in.' }),
        );
      return;
    }
    if (phase.kind === 'install') {
      // Run from setup.ts once Ink has unmounted: the install child inherits stdio.
      onComplete({ answers: { keylessInstall: true }, launch: 'done' });
      return;
    }
    if (phase.kind === 'error') setPhase({ kind: 'choose', rows: phase.rows });
  });

  if (phase.kind === 'probing') {
    return <Text color={DESIGN.textSecondary}>{'  Looking for a model that needs no key...'}</Text>;
  }

  if (phase.kind === 'consent') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          {'Found a Codex sign-in on this machine'}
        </Text>
        <Text color={DESIGN.textSecondary}>{CODEX_IMPORT_CONSENT}</Text>
        {CONSENT_ROWS.map((r, i) => (
          <Text
            key={r.id}
            color={i === selected ? DESIGN.textPrimary : DESIGN.textSecondary}
            bold={i === selected}
          >
            {` ${i === selected ? GLYPHS.prompt : ' '} ${r.label}  ${r.hint}`}
          </Text>
        ))}
        <Text color={DESIGN.textTertiary}>{'  ↑↓ select   Enter confirm   Esc back'}</Text>
      </Box>
    );
  }

  if (phase.kind === 'install') {
    const c = phase.row.candidate;
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          {'Install Ollama'}
        </Text>
        {c.kind === 'install-offer' && (
          <>
            <Text color={DESIGN.textSecondary}>{`  ${c.plan.notes}`}</Text>
            <Text color={DESIGN.textPrimary}>
              {`  ${c.plan.command ?? c.plan.downloadUrl ?? ''}`}
            </Text>
          </>
        )}
        <Text color={DESIGN.textTertiary}>
          {'  Nothing runs until you type "yes" at the next prompt.   Enter continue   Esc back'}
        </Text>
      </Box>
    );
  }

  const rows = phase.rows;
  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        {'How should Ethos answer?'}
      </Text>
      {phase.kind === 'error' && <Text color={DESIGN.error}>{`  ${phase.message}`}</Text>}
      <Box flexDirection="column">
        {rows.map((row, i) => (
          <Box key={row.id} flexDirection="row" gap={1}>
            <Text color={DESIGN.textPrimary}>{` ${i === selected ? GLYPHS.prompt : ' '} `}</Text>
            <Box flexDirection="column">
              <Text
                color={i === selected ? DESIGN.textPrimary : DESIGN.textSecondary}
                bold={i === selected}
              >
                {row.label}
              </Text>
              <Text color={DESIGN.textTertiary}>{`    ${row.hint}`}</Text>
            </Box>
          </Box>
        ))}
      </Box>
      <Text color={DESIGN.textTertiary}>{'  ↑↓ select   Enter confirm'}</Text>
    </Box>
  );
}
