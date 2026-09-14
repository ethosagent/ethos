import type { ModelRegistryTestResult } from '@ethosagent/web-contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelTestOutcome } from '../ModelTestOutcome';

// `ModelTestOutcome` is the one rendering of a `modelRegistry.test` result, used
// by Settings → Models and the personality picker alike
// (plan/phases/model-registry.md D19, T2.8). `renderToStaticMarkup` — the
// states are pure markup, nothing here is behind a click.

function html(outcome: ModelRegistryTestResult): string {
  return renderToStaticMarkup(createElement(ModelTestOutcome, { outcome }));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Visible text, tags stripped. */
function text(markup: string): string {
  return decodeEntities(markup.replace(/<[^>]*>/g, ''));
}

/** The text of the vendor-body block, exactly as it would reach the screen. */
function vendorBody(markup: string): string {
  const match = markup.match(/<pre class="model-test-outcome-body"[^>]*>([\s\S]*?)<\/pre>/);
  expect(match, 'no vendor body block').not.toBeNull();
  return decodeEntities(match?.[1] ?? '');
}

const SUBJECT = {
  providerKey: 'anthropic-work',
  provider: 'anthropic',
  modelId: 'claude-sonnet-5',
};

describe('ModelTestOutcome', () => {
  it('a passing test renders latency and the echoed model id only when it differs', () => {
    const plain = text(html({ state: 'ok', ...SUBJECT, latencyMs: 612 }));
    expect(plain).toContain('✓ Passed · 612 ms');
    expect(plain).not.toContain('served');

    const same = text(
      html({ state: 'ok', ...SUBJECT, latencyMs: 612, echoedModel: 'claude-sonnet-5' }),
    );
    expect(same).not.toContain('served');

    const floating = text(
      html({ state: 'ok', ...SUBJECT, latencyMs: 612, echoedModel: 'claude-sonnet-5-20260114' }),
    );
    expect(floating).toContain(
      'anthropic-work served claude-sonnet-5-20260114, not claude-sonnet-5.',
    );
  });

  it('a failing test renders the vendor body verbatim and untruncated', () => {
    const body = `{"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-5 <is> 'gone' & ${'x'.repeat(6000)}"}}\n  second line`;
    const markup = html({ state: 'rejected', ...SUBJECT, error: body, fix: 'Replace the key.' });
    expect(vendorBody(markup)).toBe(body);
    // Nothing clips it: no height cap, no hidden overflow, no ellipsis.
    const block = markup.match(/<pre class="model-test-outcome-body" style="([^"]*)"/)?.[1] ?? '';
    expect(block).not.toMatch(/max-height|overflow|text-overflow|line-clamp/);
    expect(block).toContain('white-space:pre-wrap');
    const plain = text(markup);
    expect(plain).toContain('✗ anthropic refused claude-sonnet-5');
    expect(plain).toContain('Fix: Replace the key.');
  });

  it('an unreachable outcome is not rendered as a bad key', () => {
    const error = 'getaddrinfo ENOTFOUND api.anthropic.com';
    const markup = html({ state: 'unreachable', ...SUBJECT, error });
    const plain = text(markup);
    expect(plain).toContain('⚠ Could not reach anthropic-work');
    expect(vendorBody(markup)).toBe(error);
    expect(plain).toContain('this says nothing about the key');
    for (const word of ['✗', 'refused', 'rejected', 'invalid', 'bad key', 'Replace the key']) {
      expect(plain).not.toContain(word);
    }
    expect(markup).not.toContain('var(--error)');
    expect(markup).toContain('var(--warning)');
  });

  it('an unconfigured outcome gives the reason and the fix', () => {
    const plain = text(
      html({
        state: 'unconfigured',
        alias: 'gpt',
        reason: 'The credential for provider entry "openai-main" could not be resolved.',
        fix: 'Add the key in the provider chain.',
      }),
    );
    expect(plain).toContain('✗ Not tested');
    expect(plain).toContain('"openai-main" could not be resolved.');
    expect(plain).toContain('Fix: Add the key in the provider chain.');
  });

  it('a rate_limited outcome says how long to wait', () => {
    expect(text(html({ state: 'rate_limited', alias: 'sonnet', retryAfterSeconds: 7 }))).toBe(
      'Tested moments ago — try again in 7s.',
    );
  });
});
