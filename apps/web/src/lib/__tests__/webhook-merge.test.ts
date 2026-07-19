import { describe, expect, it } from 'vitest';
import {
  mergeWebhooksForPersonality,
  type TriggerRowInput,
  type WebhookHookRead,
} from '../webhook-merge';

// The Triggers section (PersonalityDetail) edits one personality's hooks but
// `config.update`'s `webhooks` field replaces the WHOLE record — these cover
// the merge that keeps other personalities' hooks (and secrets) intact.

function hook(overrides: Partial<WebhookHookRead> = {}): WebhookHookRead {
  return {
    personalityId: 'researcher',
    sessionKey: null,
    prefilter: null,
    prefilterTimeoutSeconds: null,
    mode: 'sync',
    ...overrides,
  };
}

function row(overrides: Partial<TriggerRowInput> = {}): TriggerRowInput {
  return {
    hookId: 'github_ci',
    secret: '',
    sessionKey: '',
    prefilter: '',
    prefilterTimeoutSeconds: null,
    mode: 'sync',
    ...overrides,
  };
}

describe('mergeWebhooksForPersonality', () => {
  it('carries other personalities’ hooks through without a secret field', () => {
    const existing = {
      theirs: hook({
        personalityId: 'engineer',
        sessionKey: 'webhook:eng',
        prefilter: 'filter.sh',
        prefilterTimeoutSeconds: 30,
        mode: 'ack',
      }),
    };
    const result = mergeWebhooksForPersonality(existing, 'researcher', [row()]);
    if (!result.ok) throw new Error(result.error);
    expect(result.webhooks.theirs).toEqual({
      personalityId: 'engineer',
      mode: 'ack',
      sessionKey: 'webhook:eng',
      prefilter: 'filter.sh',
      prefilterTimeoutSeconds: 30,
    });
    expect(result.webhooks.theirs).not.toHaveProperty('secret');
  });

  it('deleting all of this personality’s rows leaves other hooks untouched', () => {
    const existing = {
      mine: hook({ personalityId: 'researcher' }),
      theirs: hook({ personalityId: 'engineer' }),
    };
    const result = mergeWebhooksForPersonality(existing, 'researcher', []);
    if (!result.ok) throw new Error(result.error);
    expect(Object.keys(result.webhooks)).toEqual(['theirs']);
  });

  it('binds every row to the page personality and includes typed fields only', () => {
    const result = mergeWebhooksForPersonality({}, 'researcher', [
      row({ hookId: 'gh', secret: 'super-secret', sessionKey: ' webhook:gh ', mode: 'ack' }),
      row({ hookId: 'ci' }),
    ]);
    if (!result.ok) throw new Error(result.error);
    expect(result.webhooks.gh).toEqual({
      personalityId: 'researcher',
      mode: 'ack',
      secret: 'super-secret',
      sessionKey: 'webhook:gh',
    });
    expect(result.webhooks.ci).toEqual({ personalityId: 'researcher', mode: 'sync' });
  });

  it('replaces an edited hook (blank secret keeps the stored one by omission)', () => {
    const existing = { mine: hook({ personalityId: 'researcher', sessionKey: 'old' }) };
    const result = mergeWebhooksForPersonality(existing, 'researcher', [
      row({ hookId: 'mine', sessionKey: 'new' }),
    ]);
    if (!result.ok) throw new Error(result.error);
    expect(result.webhooks.mine).toEqual({
      personalityId: 'researcher',
      mode: 'sync',
      sessionKey: 'new',
    });
  });

  it('drops the timeout when a stored hook has one without a prefilter', () => {
    const existing = {
      theirs: hook({ personalityId: 'engineer', prefilterTimeoutSeconds: 30 }),
    };
    const result = mergeWebhooksForPersonality(existing, 'researcher', []);
    if (!result.ok) throw new Error(result.error);
    expect(result.webhooks.theirs).not.toHaveProperty('prefilterTimeoutSeconds');
  });

  it('rejects an invalid hook id', () => {
    const result = mergeWebhooksForPersonality({}, 'researcher', [row({ hookId: 'bad id!' })]);
    expect(result).toEqual({
      ok: false,
      error: 'Trigger id "bad id!" must use only letters, digits, hyphens, or underscores.',
    });
  });

  it('rejects a duplicate row id', () => {
    const result = mergeWebhooksForPersonality({}, 'researcher', [
      row({ hookId: 'gh' }),
      row({ hookId: 'gh' }),
    ]);
    expect(result).toEqual({ ok: false, error: 'Duplicate trigger id "gh".' });
  });

  it('rejects an id owned by another personality instead of overwriting it', () => {
    const existing = { gh: hook({ personalityId: 'engineer' }) };
    const result = mergeWebhooksForPersonality(existing, 'researcher', [row({ hookId: 'gh' })]);
    expect(result).toEqual({
      ok: false,
      error: 'Trigger id "gh" is already used by personality "engineer".',
    });
  });

  it('rejects a secret shorter than 8 characters', () => {
    const result = mergeWebhooksForPersonality({}, 'researcher', [
      row({ hookId: 'gh', secret: 'short' }),
    ]);
    expect(result).toEqual({
      ok: false,
      error: 'Trigger "gh": secret must be at least 8 characters.',
    });
  });

  it('rejects a prefilter timeout without a prefilter script', () => {
    const result = mergeWebhooksForPersonality({}, 'researcher', [
      row({ hookId: 'gh', prefilterTimeoutSeconds: 30 }),
    ]);
    expect(result).toEqual({
      ok: false,
      error: 'Trigger "gh": prefilter timeout requires a prefilter script.',
    });
  });
});
