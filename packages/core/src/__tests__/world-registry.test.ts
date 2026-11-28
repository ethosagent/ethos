import type { WorldGraphProvider, WorldGraphProviderFactory } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DefaultWorldGraphProviderRegistry } from '../providers/world-registry';

const factory: WorldGraphProviderFactory = () => ({}) as WorldGraphProvider;

describe('DefaultWorldGraphProviderRegistry', () => {
  it('register/get/list/unregister', () => {
    const reg = new DefaultWorldGraphProviderRegistry();
    expect(reg.list()).toEqual([]);
    expect(reg.get('sqlite')).toBeUndefined();

    reg.register('sqlite', factory);
    reg.register('neo4j', factory);
    expect(reg.get('sqlite')).toBe(factory);
    expect(reg.list()).toEqual(['sqlite', 'neo4j']);
    expect(() => reg.register('sqlite', factory)).toThrow(/already registered/);

    reg.unregister('sqlite');
    expect(reg.get('sqlite')).toBeUndefined();
    expect(reg.list()).toEqual(['neo4j']);
  });
});
