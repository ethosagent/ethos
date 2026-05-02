import { Box, Text, useInput } from 'ink';
import { type Reducer, useReducer } from 'react';
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
}

function reducer(state: WizardState, action: WizardAction): WizardState {
  if (action.type === 'abort') return { ...state, aborted: true };

  const mode = (action.patch?.mode as WizardMode | undefined) ?? state.mode;

  if (action.type === 'next') {
    const merged: WizardAnswers = { ...state.answers, ...action.patch };
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
  onComplete: (result: { answers: WizardAnswers; launchChat: boolean } | null) => void;
}

export function Wizard({ existing, startAtStep, onComplete }: WizardProps) {
  const [state, dispatch] = useReducer<Reducer<WizardState, WizardAction>>(reducer, {
    step: startAtStep ?? 'entry',
    mode: 'quick',
    answers: existing ?? {},
    aborted: false,
  });

  const accent = state.answers.personality
    ? personalityAccent(state.answers.personality)
    : DESIGN.textPrimary;

  // Handle abort → propagate null up
  if (state.aborted) {
    onComplete(null);
    return null;
  }

  // Handle completion: when reducer tries to advance past 'launch', we're done
  const order = getStepOrder(state.mode);
  const isDone = state.step === 'launch' && state.answers.launchChat !== undefined;
  if (isDone) {
    onComplete({ answers: state.answers, launchChat: Boolean(state.answers.launchChat) });
    return null;
  }

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
        <Box marginTop={1}>
          <Text color={DESIGN.textTertiary}>{`  step ${currentIdx} of ${totalSteps}`}</Text>
        </Box>
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
