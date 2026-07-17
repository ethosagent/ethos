import { Box, Text, useInput } from 'ink';
import { useEffect, useReducer } from 'react';
import { DESIGN, personalityAccent } from '../skin';
import {
  getStepOrder,
  isFullOnlyStep,
  nextStep,
  prevStep,
  type WizardAction,
  type WizardAnswers,
  WizardContext,
  type WizardMode,
  type WizardStepId,
} from './context';
import { AuthStep } from './steps/AuthStep';
import { DaemonInstallStep } from './steps/DaemonInstallStep';
import { KeyRotationStep } from './steps/KeyRotationStep';
import { LaunchStep } from './steps/LaunchStep';
import { MemoryStep } from './steps/MemoryStep';
import { MessagingStep } from './steps/MessagingStep';
import { ModelStep } from './steps/ModelStep';
import { MultiProviderStep } from './steps/MultiProviderStep';
import { PersonalityStep } from './steps/PersonalityStep';
import { ProviderStep } from './steps/ProviderStep';
import { SetupEntryStep } from './steps/SetupEntryStep';
import { SummaryStep } from './steps/SummaryStep';

interface WizardState {
  step: WizardStepId;
  mode: WizardMode;
  answers: WizardAnswers;
  aborted: boolean;
  /** When true, complete after the first 'next' dispatch — section-scoped re-entry. */
  singleStep: boolean;
  /** Set when singleStep fires — carries the merged answers ready for completion. */
  singleStepDone: WizardAnswers | null;
}

function reducer(state: WizardState, action: WizardAction): WizardState {
  if (action.type === 'abort') return { ...state, aborted: true };

  const mode = (action.patch?.mode as WizardMode | undefined) ?? state.mode;

  if (action.type === 'next') {
    const merged: WizardAnswers = { ...state.answers, ...action.patch };
    if (state.singleStep) {
      return { ...state, mode, answers: merged, singleStepDone: merged };
    }
    const next = nextStep(state.step, mode);
    return { ...state, mode, answers: merged, step: next ?? state.step };
  }

  if (action.type === 'back') {
    const prev = prevStep(state.step, mode);
    return { ...state, step: prev ?? state.step };
  }

  return state;
}

interface WizardProps {
  existing: WizardAnswers | null;
  startAtStep?: WizardStepId;
  /** When true, exit immediately after the first step confirms — section re-entry. */
  singleStep?: boolean;
  onComplete: (
    result: { answers: WizardAnswers; launch: 'gateway' | 'chat' | 'done' } | null,
  ) => void;
}

export function Wizard({ existing, startAtStep, singleStep, onComplete }: WizardProps) {
  const initialMode: WizardMode = startAtStep && isFullOnlyStep(startAtStep) ? 'full' : 'quick';

  // React 19 dropped the single-generic `useReducer<Reducer<S, A>>` overload.
  // The supported form is `useReducer<S, A>` directly; TS infers it from
  // `reducer`'s signature here, so no explicit args needed.
  const [state, dispatch] = useReducer(reducer, {
    step: startAtStep ?? 'entry',
    mode: initialMode,
    answers: existing ?? {},
    aborted: false,
    singleStep: singleStep ?? false,
    singleStepDone: null,
  });

  const accent = state.answers.personality
    ? personalityAccent(state.answers.personality)
    : DESIGN.textPrimary;

  const isDone =
    state.aborted ||
    state.singleStepDone !== null ||
    (state.step === 'launch' && state.answers.launch !== undefined);

  // Defer onComplete out of the render path to avoid nested-update warnings
  useEffect(() => {
    if (!isDone) return;
    if (state.aborted) {
      onComplete(null);
    } else if (state.singleStepDone) {
      onComplete({ answers: state.singleStepDone, launch: 'done' });
    } else {
      onComplete({ answers: state.answers, launch: state.answers.launch ?? 'done' });
    }
  }, [isDone, onComplete, state.aborted, state.singleStepDone, state.answers]);

  if (isDone) return null;

  const order = getStepOrder(state.mode);

  const totalSteps = order.length;
  const currentIdx = order.indexOf(state.step) + 1;

  const fullOnlyHint = isFullOnlyStep(state.step) ? (
    <Text dimColor>{`  advanced step ${currentIdx} of ${totalSteps} · Esc skip`}</Text>
  ) : null;

  return (
    <WizardContext.Provider value={{ answers: state.answers, accent, dispatch }}>
      <Box flexDirection="column" paddingTop={1} paddingLeft={2}>
        <StepRouter step={state.step} onComplete={onComplete} dispatch={dispatch} />
        {fullOnlyHint}
        {!state.singleStep && (
          <Box marginTop={1}>
            <Text color={DESIGN.textTertiary}>{`  step ${currentIdx} of ${totalSteps}`}</Text>
          </Box>
        )}
      </Box>
    </WizardContext.Provider>
  );
}

interface StepRouterProps {
  step: WizardStepId;
  onComplete: WizardProps['onComplete'];
  dispatch: React.Dispatch<WizardAction>;
}

function StepRouter({ step, onComplete, dispatch }: StepRouterProps) {
  // Ctrl+C abort at any step
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') dispatch({ type: 'abort' });
    },
    { isActive: true },
  );

  switch (step) {
    case 'entry':
      return <SetupEntryStep />;
    case 'provider':
      return <ProviderStep />;
    case 'provider-chain':
      return <MultiProviderStep />;
    case 'auth':
      return <AuthStep />;
    case 'key-rotation':
      return <KeyRotationStep />;
    case 'model':
      return <ModelStep />;
    case 'memory':
      return <MemoryStep />;
    case 'personality':
      return <PersonalityStep />;
    case 'messaging':
      return <MessagingStep />;
    case 'daemon':
      return <DaemonInstallStep />;
    case 'summary':
      return <SummaryStep />;
    case 'launch':
      return <LaunchStep onComplete={onComplete} />;
    default:
      return <Text color={DESIGN.error}>Unknown step: {step}</Text>;
  }
}
