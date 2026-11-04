import { describe, expect, it } from 'vitest';
import {
  initialState,
  serverStartStep,
  stepIndex,
  type WizardAnswers,
  type WizardState,
  wizardReducer,
} from '../reducer';
import { localPatch, PASTE_KEY_PATCH } from '../steps/KeylessStep';

function from(step: WizardState['step'], answers: Partial<WizardAnswers> = {}): WizardState {
  return { ...initialState, step, answers: { mode: 'quick', ...answers } };
}

describe('keyless step transitions', () => {
  it('starts on the keyless step', () => {
    expect(initialState.step).toBe('keyless');
  });

  it('a local candidate skips setup-entry, provider, auth and model', () => {
    const next = wizardReducer(from('keyless'), {
      type: 'next',
      patch: localPatch(
        {
          kind: 'local',
          runtime: 'ollama',
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: ['llama3.2:latest'],
        },
        'llama3.2:latest',
      ),
    });
    expect(next.step).toBe('personality');
    expect(next.answers).toMatchObject({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'local',
      model: 'llama3.2:latest',
      keylessPath: 'local',
    });
    expect(next.history).toEqual(['keyless']);
  });

  it('a vllm candidate is written as openai-compat', () => {
    const patch = localPatch(
      {
        kind: 'local',
        runtime: 'vllm',
        provider: 'vllm',
        baseUrl: 'http://127.0.0.1:8000/v1',
        models: ['m'],
      },
      'm',
    );
    expect(patch.provider).toBe('openai-compat');
  });

  it('a found login with a model list goes to the model step', () => {
    const next = wizardReducer(from('keyless'), {
      type: 'next',
      patch: {
        provider: 'codex',
        apiKey: '',
        models: ['gpt-5.5-codex'],
        keylessPath: 'external-login',
      },
    });
    expect(next.step).toBe('model');
  });

  it('Sign in with ChatGPT (no models yet) goes to the auth step', () => {
    const next = wizardReducer(from('keyless'), {
      type: 'next',
      patch: { provider: 'codex', keylessPath: 'ethos-login' },
    });
    expect(next.step).toBe('auth');
  });

  it('Paste a key falls through to setup-entry and clears a previous pick', () => {
    const picked = from('keyless', {
      provider: 'ollama',
      apiKey: 'local',
      model: 'm',
      models: ['m'],
      keylessPath: 'local',
    });
    const next = wizardReducer(picked, { type: 'next', patch: PASTE_KEY_PATCH });
    expect(next.step).toBe('setup-entry');
    expect(next.answers.keylessPath).toBe('key');
    expect(next.answers.provider).toBeUndefined();
    expect(next.answers.model).toBeUndefined();
    expect(next.answers.apiKey).toBeUndefined();
  });

  it('Back from personality returns to keyless after a local pick', () => {
    const afterPick = wizardReducer(from('keyless'), {
      type: 'next',
      patch: { provider: 'ollama', model: 'm', apiKey: 'local', keylessPath: 'local' },
    });
    expect(wizardReducer(afterPick, { type: 'back' }).step).toBe('keyless');
  });
});

describe('name-agent and connectors', () => {
  it('personality leads to name-agent, then connectors, then messaging', () => {
    const a = wizardReducer(from('personality'), {
      type: 'next',
      patch: { personalityId: 'researcher' },
    });
    expect(a.step).toBe('name-agent');
    const b = wizardReducer(a, {
      type: 'next',
      patch: { personalityId: 'sage', builtInPersonalityId: 'researcher', agentName: 'Sage' },
    });
    expect(b.step).toBe('connectors');
    const c = wizardReducer(b, { type: 'next', patch: { connectedPresets: [] } });
    expect(c.step).toBe('messaging');
  });

  it('keeping the built-in skips connectors', () => {
    const next = wizardReducer(from('name-agent', { personalityId: 'researcher' }), {
      type: 'next',
      patch: { keepBuiltIn: true },
    });
    expect(next.step).toBe('messaging');
  });
});

describe('serverStartStep (D13)', () => {
  it('skips only the keyless probe when the server has a provider', () => {
    expect(serverStartStep({ step: 'personality', hasProvider: true })).toBe('setup-entry');
    expect(serverStartStep({ step: 'done', hasProvider: true })).toBe('setup-entry');
  });
  it('never starts past model, so provider, auth and model still run', () => {
    const step = serverStartStep({ step: 'done', hasProvider: true });
    expect(step).toBe('setup-entry');
    if (step) expect(stepIndex(step, 'quick')).toBeLessThan(stepIndex('model', 'quick'));
  });
  it('keeps a fresh setup on keyless', () => {
    expect(serverStartStep({ step: 'welcome', hasProvider: false })).toBeNull();
    expect(serverStartStep({ step: 'provider', hasProvider: false })).toBeNull();
  });
});
