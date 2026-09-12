import type { EthosConfig } from '@ethosagent/config';
import { describe, expect, it } from 'vitest';
import { providerChainLines } from '../commands/doctor';

// `ethos doctor` is the command whose job is "what is wrong with my config",
// and it never mentioned the provider chain — the thing that decides which
// provider every turn actually runs on.

const BASE = {
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  apiKey: '',
  personality: 'researcher',
} satisfies EthosConfig;

function plain(lines: string[]): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes.
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

describe('providerChainLines', () => {
  it('says the top-level fields are what runs when the chain is too short', () => {
    const out = plain(providerChainLines({ ...BASE, providers: [{ provider: 'x', apiKey: '' }] }));
    expect(out).toContain('top-level');
    expect(out).toContain('not in use');
  });

  it('lists the chain, in order, with the fields each entry carries', () => {
    const out = plain(
      providerChainLines({
        ...BASE,
        providers: [
          { provider: 'anthropic', apiKey: '', model: 'claude-opus-4-7' },
          {
            provider: 'bedrock',
            apiKey: '',
            region: 'eu-west-1',
            awsProfile: 'sso-prod',
            passthrough: { inferenceProfileArn: 'arn:aws:x' },
          },
        ],
      }),
    );
    expect(out).toMatch(/1\. anthropic/);
    expect(out).toMatch(/2\. bedrock/);
    expect(out).toContain('eu-west-1');
    expect(out).toContain('sso-prod');
    expect(out).toContain('inferenceProfileArn');
  });

  it('says nothing at all when there is no chain', () => {
    expect(providerChainLines(BASE)).toEqual([]);
  });
});
