import type { ProviderId } from '@ethosagent/web-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, ConfigProvider } from 'antd';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { bridge, isDesktop } from '../lib/desktop';
import { personalityTheme } from '../lib/theme';
import { buildWorkspaceChatPath } from '../lib/workspaceRoutes';
import { type CatalogProviderId, getCatalogEntry } from '../onboarding/catalog/providers';
import { clearDraft, type DraftState, loadDraft, saveDraft } from '../onboarding/draft';
import { firstTaskChatPath } from '../onboarding/first-task';
import {
  FULL_ONLY,
  initialState,
  STEP_COUNT,
  serverStartStep,
  stepIndex,
  type WizardStepId,
  wizardReducer,
} from '../onboarding/reducer';
import { AuthStep } from '../onboarding/steps/AuthStep';
import { ConnectorsStep } from '../onboarding/steps/ConnectorsStep';
import { DaemonHintStep } from '../onboarding/steps/DaemonHintStep';
import { FirstTaskStep } from '../onboarding/steps/FirstTaskStep';
import { KeylessStep } from '../onboarding/steps/KeylessStep';
import { KeyRotationStep } from '../onboarding/steps/KeyRotationStep';
import { MemoryStep } from '../onboarding/steps/MemoryStep';
import { MessagingStep } from '../onboarding/steps/MessagingStep';
import { ModelStep } from '../onboarding/steps/ModelStep';
import { MultiProviderStep } from '../onboarding/steps/MultiProviderStep';
import { NameAgentStep } from '../onboarding/steps/NameAgentStep';
import { PersonalityStep } from '../onboarding/steps/PersonalityStep';
import { ProviderStep } from '../onboarding/steps/ProviderStep';
import { SetupEntryStep } from '../onboarding/steps/SetupEntryStep';
import { SummaryStep } from '../onboarding/steps/SummaryStep';
import { rpc } from '../rpc';

// Ordered list of Full-only steps for the "X of 4 advanced steps" hint
const FULL_ONLY_ORDERED: WizardStepId[] = [
  'multi-provider',
  'key-rotation',
  'memory',
  'daemon-hint',
];

// Step names for the resume affordance
const STEP_LABELS: Partial<Record<WizardStepId, string>> = {
  keyless: 'Model',
  'setup-entry': 'Start',
  provider: 'Provider',
  'multi-provider': 'Provider chain',
  auth: 'API key',
  'key-rotation': 'Key rotation',
  model: 'Model',
  memory: 'Memory',
  personality: 'Personality',
  'name-agent': 'Name your agent',
  connectors: 'Connectors',
  messaging: 'Messaging',
  'daemon-hint': 'Daemon',
  summary: 'Summary',
};

export function Onboarding({ startAtStep }: { startAtStep?: WizardStepId }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();
  const [state, dispatch] = useReducer(wizardReducer, initialState);

  // Draft resume affordance: when a non-trivial draft is detected on mount,
  // show Resume / Start over rather than silently hydrating.
  const [pendingDraft, setPendingDraft] = useState<DraftState | null>(null);

  useEffect(() => {
    if (startAtStep) {
      const draft = loadDraft();
      if (draft) {
        dispatch({ type: 'hydrate', draft: draft.answers, step: startAtStep, history: [] });
      } else {
        dispatch({ type: 'jumpTo', step: startAtStep });
      }
      return;
    }
    const draft = loadDraft();
    if (draft && draft.step !== 'setup-entry' && draft.step !== 'keyless') {
      setPendingDraft(draft);
      // Don't hydrate yet — let the user choose Resume or Start over
      return;
    }
    // No saved draft: a server that already has a provider skips keyless (D13).
    let cancelled = false;
    rpc.onboarding
      .state()
      .then((server) => {
        const step = serverStartStep(server);
        if (!cancelled && step) {
          dispatch({ type: 'hydrate', draft: { mode: 'quick' }, step, history: [] });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startAtStep]);

  const handleResume = useCallback(() => {
    if (pendingDraft) {
      dispatch({
        type: 'hydrate',
        draft: pendingDraft.answers,
        step: pendingDraft.step,
        history: pendingDraft.history,
      });
      setPendingDraft(null);
    }
  }, [pendingDraft]);

  const handleStartOver = useCallback(() => {
    clearDraft();
    dispatch({ type: 'reset' });
    setPendingDraft(null);
  }, []);

  // Auto-save draft when wizard state changes (debounced 250ms in saveDraft)
  useEffect(() => {
    if ((state.step === 'setup-entry' || state.step === 'keyless') && state.history.length === 0) {
      return;
    }
    // After `complete` the draft is cleared; don't re-save it for the first-task step.
    if (state.step === 'launch') return;
    saveDraft({ answers: state.answers, step: state.step, history: state.history });
  }, [state.answers, state.step, state.history]);

  const handleBack = useCallback(() => {
    dispatch({ type: 'back' });
  }, []);

  // Push a browser history entry on each forward step advance so browser
  // back fires a popstate (which we intercept to pop one wizard step).
  const handleNext = useCallback(
    (patch: Partial<typeof state.answers>) => {
      window.history.pushState({ onboardingStep: state.step }, '');
      dispatch({ type: 'next', patch });
    },
    [state.step],
  );

  // Browser back integration: popstate → pop wizard step.
  // When wizard history is empty, do nothing — the browser will navigate
  // away from /onboarding naturally.
  useEffect(() => {
    const onPopState = () => {
      // 'launch' follows a completed setup; going back would re-run `complete`.
      if (state.step !== 'launch' && state.history.length > 0) {
        dispatch({ type: 'back' });
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [state.history.length, state.step]);

  // Global Esc key handler:
  //   • On a Full-only step: skip to the next mandatory step (advance, not back).
  //   • On any other step with history: go back one step.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Don't intercept Esc when focused inside an input/textarea — let the
      // field handle it (e.g. closing an Antd dropdown).
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [role="listbox"]')) return;
      if (state.step === 'launch') return;
      e.preventDefault();
      if (FULL_ONLY.has(state.step)) {
        // Skip the rest of the Full-only sub-flow → advance to next mandatory step
        window.history.pushState({ onboardingStep: state.step }, '');
        dispatch({ type: 'next', patch: {} });
      } else if (state.history.length > 0) {
        dispatch({ type: 'back' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state.step, state.history.length]);

  const mode = state.answers.mode;
  const totalSteps = STEP_COUNT[mode];
  const currentIndex = stepIndex(state.step, mode);
  const showBack = state.history.length > 0 && state.step !== 'launch';

  // Full-only step hint: "1 of 4 advanced steps · Skip rest with Esc"
  const fullOnlyIdx = FULL_ONLY_ORDERED.indexOf(state.step);
  const showFullHint = fullOnlyIdx !== -1 && state.answers.mode === 'full';

  const handleComplete = async () => {
    const { answers } = state;
    const providerId = answers.provider as CatalogProviderId | undefined;
    const catalog = providerId ? getCatalogEntry(providerId) : null;
    // A probed local runtime written as `openai-compat` carries the 'local'
    // placeholder key (D14); a draft resume drops apiKey, so don't demand it.
    const isLocalKeyless = answers.keylessPath === 'local' || answers.keylessPath === 'installed';
    const requiresApiKey = catalog?.authType === 'api-key' && !isLocalKeyless;
    if (
      !answers.provider ||
      !answers.model ||
      (requiresApiKey && !answers.apiKey) ||
      !answers.personalityId
    ) {
      notification.error({
        message: 'Incomplete setup',
        description: 'Please complete all required steps before launching.',
        placement: 'topRight',
      });
      return;
    }
    const personalityId = answers.personalityId;
    try {
      await rpc.onboarding.complete({
        provider: catalog?.wiresAs as ProviderId,
        model: answers.model,
        apiKey: answers.apiKey ?? (isLocalKeyless ? 'local' : undefined),
        ...(answers.baseUrl ? { baseUrl: answers.baseUrl } : {}),
        personalityId,
        ...(answers.keylessPath ? { keylessPath: answers.keylessPath } : {}),
      });
      // Restart desktop backend so it picks up the new API key.
      if (isDesktop && bridge) {
        bridge.backend.restart().catch(() => {});
      } else {
        // The server boots the agent in this same process, so chat, goals, MCP,
        // Settings › Execution and renderers work immediately — but what starts
        // AROUND the loop at boot does not (see `adoptBootedLoop` in
        // apps/ethos/src/lib/onboarding-boot.ts, which lists them and why). Say
        // so rather than leaving those tabs quietly empty. `duration: 0` keeps
        // it up until dismissed; the server logs the same line.
        notification.info({
          message: 'Setup complete — chat is ready',
          description:
            'Cron schedules, background tasks, voice and plugin-backed dashboards start when you restart `ethos serve`.',
          placement: 'topRight',
          duration: 0,
        });
      }
      clearDraft();
      void queryClient.invalidateQueries({ queryKey: ['config'] });
      void queryClient.invalidateQueries({ queryKey: ['onboarding'] });
      // First-task suggestions come before the chat opens (D16/D17); picking
      // one prefills the composer through `?draft=`, it never sends.
      dispatch({ type: 'next', patch: {} });
    } catch (err) {
      notification.error({
        message: 'Setup failed',
        description: err instanceof Error ? err.message : String(err),
        placement: 'topRight',
      });
    }
  };

  const openId = state.answers.personalityId ?? 'researcher';

  const renderStep = () => {
    switch (state.step) {
      case 'keyless':
        return <KeylessStep onNext={handleNext} />;
      case 'setup-entry':
        return <SetupEntryStep onNext={handleNext} />;
      case 'provider':
        return <ProviderStep answers={state.answers} onNext={handleNext} />;
      case 'multi-provider':
        return (
          <MultiProviderStep answers={state.answers} onNext={handleNext} onBack={handleBack} />
        );
      case 'auth':
        return <AuthStep answers={state.answers} onNext={handleNext} />;
      case 'key-rotation':
        return <KeyRotationStep answers={state.answers} onNext={handleNext} onBack={handleBack} />;
      case 'model':
        return <ModelStep answers={state.answers} onNext={handleNext} />;
      case 'memory':
        return <MemoryStep answers={state.answers} onNext={handleNext} onBack={handleBack} />;
      case 'personality':
        return <PersonalityStep answers={state.answers} onNext={handleNext} />;
      case 'name-agent':
        return <NameAgentStep answers={state.answers} onNext={handleNext} />;
      case 'connectors':
        return <ConnectorsStep answers={state.answers} onNext={handleNext} />;
      case 'messaging':
        return <MessagingStep answers={state.answers} onNext={handleNext} />;
      case 'daemon-hint':
        return <DaemonHintStep answers={state.answers} onNext={handleNext} onBack={handleBack} />;
      case 'summary':
        return <SummaryStep answers={state.answers} onNext={() => void handleComplete()} />;
      case 'launch':
        return (
          <FirstTaskStep
            connected={state.answers.connectedPresets ?? []}
            onPick={(text) =>
              // replace: true so browser back doesn't return to /onboarding
              navigate(firstTaskChatPath(openId, text), { replace: true })
            }
            onSkip={() => navigate(buildWorkspaceChatPath(openId), { replace: true })}
          />
        );
      default:
        return null;
    }
  };

  const personalityId = state.answers.personalityId;
  const usePersonalityTheme =
    personalityId &&
    (state.step === 'name-agent' ||
      state.step === 'connectors' ||
      state.step === 'messaging' ||
      state.step === 'daemon-hint' ||
      state.step === 'summary' ||
      state.step === 'launch');

  const content = (
    <div className="onboarding">
      {/* Resume affordance — shown when a non-trivial draft was detected on mount */}
      {pendingDraft ? (
        <div className="onboarding-resume-bar">
          <span className="onboarding-resume-text">
            Setup in progress — resume from{' '}
            <strong>{STEP_LABELS[pendingDraft.step] ?? pendingDraft.step}</strong>?
          </span>
          <div className="onboarding-resume-actions">
            <Button size="small" onClick={handleResume}>
              Resume
            </Button>
            <Button size="small" onClick={handleStartOver}>
              Start over
            </Button>
          </div>
        </div>
      ) : null}

      <div className="onboarding-progress" aria-hidden="true">
        {Array.from({ length: totalSteps }).map((_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: index is position in sequence
            key={i}
            className={`onboarding-dot${i === currentIndex ? ' active' : i < currentIndex ? ' visited' : ''}`}
          />
        ))}
      </div>

      {showBack ? (
        <div className="onboarding-back-row">
          <button
            type="button"
            className="onboarding-back-btn"
            onClick={handleBack}
            aria-label="Go back"
          >
            ‹ Back
          </button>
        </div>
      ) : null}

      {/* Full-mode advanced steps hint */}
      {showFullHint ? (
        <div className="onboarding-full-hint">
          [{fullOnlyIdx + 1} of 4 advanced steps · Skip rest with Esc]
        </div>
      ) : null}

      <div key={state.step} data-dir={state.direction} className="onboarding-step-wrapper">
        {renderStep()}
      </div>
    </div>
  );

  if (usePersonalityTheme && personalityId) {
    return <ConfigProvider theme={personalityTheme(personalityId)}>{content}</ConfigProvider>;
  }
  return content;
}
