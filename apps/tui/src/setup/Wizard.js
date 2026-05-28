import { Box, Text, useInput } from 'ink';
import { useEffect, useReducer } from 'react';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import { DESIGN, personalityAccent } from '../skin';
import { getStepOrder, isFullOnlyStep, nextStep, prevStep, WizardContext } from './context';
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

function reducer(state, action) {
  if (action.type === 'abort') return { ...state, aborted: true };
  const mode = action.patch?.mode ?? state.mode;
  if (action.type === 'next') {
    const merged = { ...state.answers, ...action.patch };
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
export function Wizard({ existing, startAtStep, singleStep, onComplete }) {
  const initialMode = startAtStep && isFullOnlyStep(startAtStep) ? 'full' : 'quick';
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
    (state.step === 'launch' && state.answers.launchChat !== undefined);
  // Defer onComplete out of the render path to avoid nested-update warnings
  useEffect(() => {
    if (!isDone) return;
    if (state.aborted) {
      onComplete(null);
    } else if (state.singleStepDone) {
      onComplete({ answers: state.singleStepDone, launchChat: false });
    } else {
      onComplete({ answers: state.answers, launchChat: Boolean(state.answers.launchChat) });
    }
  }, [isDone, onComplete, state.aborted, state.singleStepDone, state.answers]);
  if (isDone) return null;
  const order = getStepOrder(state.mode);
  const totalSteps = order.length;
  const currentIdx = order.indexOf(state.step) + 1;
  const fullOnlyHint = isFullOnlyStep(state.step)
    ? _jsx(Text, {
        dimColor: true,
        children: `  advanced step ${currentIdx} of ${totalSteps} · Esc skip`,
      })
    : null;
  return _jsx(WizardContext.Provider, {
    value: { answers: state.answers, accent, dispatch },
    children: _jsxs(Box, {
      flexDirection: 'column',
      paddingTop: 1,
      paddingLeft: 2,
      children: [
        _jsx(StepRouter, { step: state.step, onComplete: onComplete, dispatch: dispatch }),
        fullOnlyHint,
        !state.singleStep &&
          _jsx(Box, {
            marginTop: 1,
            children: _jsx(Text, {
              color: DESIGN.textTertiary,
              children: `  step ${currentIdx} of ${totalSteps}`,
            }),
          }),
      ],
    }),
  });
}
function StepRouter({ step, onComplete, dispatch }) {
  // Ctrl+C abort at any step
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') dispatch({ type: 'abort' });
    },
    { isActive: true },
  );
  switch (step) {
    case 'entry':
      return _jsx(SetupEntryStep, {});
    case 'provider':
      return _jsx(ProviderStep, {});
    case 'provider-chain':
      return _jsx(MultiProviderStep, {});
    case 'auth':
      return _jsx(AuthStep, {});
    case 'key-rotation':
      return _jsx(KeyRotationStep, {});
    case 'model':
      return _jsx(ModelStep, {});
    case 'memory':
      return _jsx(MemoryStep, {});
    case 'personality':
      return _jsx(PersonalityStep, {});
    case 'messaging':
      return _jsx(MessagingStep, {});
    case 'daemon':
      return _jsx(DaemonInstallStep, {});
    case 'summary':
      return _jsx(SummaryStep, {});
    case 'launch':
      return _jsx(LaunchStep, { onComplete: onComplete });
    default:
      return _jsxs(Text, { color: DESIGN.error, children: ['Unknown step: ', step] });
  }
}
