import { describe, expect, it } from 'vitest';
import { readRef } from '../runner';

describe('readRef', () => {
  it('records a world read by its text or entity argument so a brief can cite it', () => {
    expect(readRef('world_query', { text: 'Ravi', world: 'acme' })).toBe('world_query: Ravi');
    expect(readRef('world_neighbours', { entity: 'e-1', hops: 2 })).toBe('world_neighbours: e-1');
    expect(readRef('world_history', { entity: 'e-1' })).toBe('world_history: e-1');
  });

  it('records no ref for a non-read tool', () => {
    expect(readRef('world_assert', { entity: 'e-1' })).toBeNull();
  });
});
