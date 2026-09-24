import { renderToString } from 'ink';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CredentialPromptView } from '../components/CredentialModal';
import {
  type CredentialRequest,
  credentialKeyStep,
  MASK_CHAR,
  type MaskedInputAction,
  maskedInputReducer,
  maskValue,
  submitCredential,
} from '../credential-prompt';

const SECRET = 'sk-live-THIS-MUST-NEVER-RENDER';

const request: CredentialRequest = {
  pluginId: 'weather',
  credentialKey: 'api_key',
  kind: 'api_key',
  label: 'API key',
  description: 'Your OpenWeather API key.',
  sessionKey: 'cli:test',
  pendingUserMessage: 'what is the weather in Pune?',
};

function typeAll(text: string): string {
  return Array.from(text).reduce<string>(
    (v, ch) => maskedInputReducer(v, { type: 'input', text: ch }),
    '',
  );
}

describe('maskedInputReducer', () => {
  it('appends typed and pasted text, stripping line breaks', () => {
    expect(typeAll('abc')).toBe('abc');
    expect(maskedInputReducer('ab', { type: 'input', text: 'cd\r\n' })).toBe('abcd');
  });

  it('backspace removes one character, clear empties', () => {
    const actions: MaskedInputAction[] = [{ type: 'backspace' }];
    expect(actions.reduce(maskedInputReducer, 'abc')).toBe('ab');
    expect(maskedInputReducer('abc', { type: 'clear' })).toBe('');
    expect(maskedInputReducer('', { type: 'backspace' })).toBe('');
  });
});

describe('masking', () => {
  it('maskValue is one bullet per character and never contains the value', () => {
    const masked = maskValue(SECRET);
    expect(masked).toBe(MASK_CHAR.repeat(SECRET.length));
    expect(masked).not.toContain('sk-');
  });

  it('the rendered modal names plugin, label and description but never the value', () => {
    const frame = renderToString(
      createElement(CredentialPromptView, {
        request,
        masked: maskValue(typeAll(SECRET)),
        error: null,
        busy: false,
      }),
      { columns: 120 },
    );
    expect(frame).toContain('weather');
    expect(frame).toContain('API key');
    expect(frame).toContain('Your OpenWeather API key.');
    expect(frame).toContain(MASK_CHAR.repeat(SECRET.length));
    expect(frame).not.toContain(SECRET);
    expect(frame).not.toContain('THIS-MUST-NEVER-RENDER');
  });
});

describe('submitCredential', () => {
  it('stores through setPluginCredential, then resends the pending message', async () => {
    const order: string[] = [];
    const setPluginCredential = vi.fn(async () => {
      order.push('store');
    });
    const resend = vi.fn(() => {
      order.push('resend');
    });
    const result = await submitCredential({
      request,
      value: SECRET,
      setPluginCredential,
      resend,
    });
    expect(result).toEqual({ ok: true });
    expect(setPluginCredential).toHaveBeenCalledWith('weather', 'api_key', SECRET);
    expect(resend).toHaveBeenCalledWith('what is the weather in Pune?');
    expect(order).toEqual(['store', 'resend']);
  });

  it('a thrown store returns its error text and resends nothing', async () => {
    const resend = vi.fn();
    const result = await submitCredential({
      request,
      value: SECRET,
      setPluginCredential: async () => {
        throw new Error('Plugin "weather" is not loaded');
      },
      resend,
    });
    expect(result).toEqual({ ok: false, error: 'Plugin "weather" is not loaded' });
    expect(resend).not.toHaveBeenCalled();
  });

  it('an empty value stores nothing and resends nothing', async () => {
    const setPluginCredential = vi.fn(async () => {});
    const resend = vi.fn();
    const result = await submitCredential({ request, value: '  ', setPluginCredential, resend });
    expect(result.ok).toBe(false);
    expect(setPluginCredential).not.toHaveBeenCalled();
    expect(resend).not.toHaveBeenCalled();
  });
});

describe('credentialKeyStep', () => {
  it('Enter hands out the value and empties the field in the same step', () => {
    expect(credentialKeyStep(SECRET, '', { return: true })).toEqual({
      kind: 'submit',
      value: '',
      submitted: SECRET,
    });
  });

  it('Esc empties the field and submits nothing', () => {
    const step = credentialKeyStep(SECRET, '', { escape: true });
    expect(step).toEqual({ kind: 'cancel', value: '' });
    expect(step).not.toHaveProperty('submitted');
  });

  it('typing and backspace edit; ctrl/meta chords are ignored', () => {
    expect(credentialKeyStep('ab', 'c', {})).toEqual({ kind: 'edit', value: 'abc' });
    expect(credentialKeyStep('abc', '', { backspace: true })).toEqual({
      kind: 'edit',
      value: 'ab',
    });
    expect(credentialKeyStep('ab', 'u', { ctrl: true })).toEqual({ kind: 'edit', value: 'ab' });
  });
});
