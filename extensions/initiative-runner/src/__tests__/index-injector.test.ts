import type { PromptContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { InitiativeIndexInjector } from '../index-injector';

const ctx = { personalityId: 'a', roomAudience: 'private' } as unknown as PromptContext;
const store = { indexLines: () => ['- one'] };

describe('InitiativeIndexInjector enablement', () => {
  it('renders the index for an enabled personality', async () => {
    const inj = new InitiativeIndexInjector({ store, isEnabled: () => true });
    expect((await inj.inject(ctx))?.content).toContain('- one');
  });

  it('gives a disabled personality no index and never reads the ledger', async () => {
    let read = false;
    const inj = new InitiativeIndexInjector({
      store: {
        indexLines: () => {
          read = true;
          return ['- one'];
        },
      },
      isEnabled: (pid) => pid !== 'a',
    });
    expect(await inj.inject(ctx)).toBeNull();
    expect(read).toBe(false);
  });
});
